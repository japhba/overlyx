#!/usr/bin/env python3
"""
Anodyne: OverLyX's sans-serif, a fork of Lisnoti (https://github.com/Lisnoti/Lisnoti, OFL; "Lisnoti" is a
Reserved Font Name, so the fork needs its own name), built as a variable font with two axes:

  wght  100–900  weight. Glyphs Lisnoti kept from Noto Sans get Noto Sans's own masters (Thin, Bold, Black,
                 instanced from Google's variable Noto Sans), so every weight is Noto's design. Glyphs Lisnoti
                 redrew or added get Lisnoti Bold as their 700 master, made point-compatible with the Regular
                 (each on-curve-to-on-curve run refitted as a cubic, then cu2qu's multi-master conversion, as
                 fontmake does), Thin and Black extrapolated from the Regular→Bold change at Noto's stem ratios.
                 The few glyphs whose Bold has other contours are emboldened point by point (FreeType's
                 outline-emboldening rule), so they stay compatible too.
  GRAD  -100–150 grade: the stems of weight 400+GRAD at the widths of 400 — darker or lighter text that never
                 reflows. Derived from the weight masters: each point's weight delta, less the advance growth
                 spread across the glyph by the point's position.

It also brings back Noto Sans's small capitals (smcp, c2sc), which Lisnoti dropped, so \\textsc and small-caps
headings have real ones. Lisnoti's MATH table stays (static, for the Regular; the Bold instance gets Lisnoti
Bold's), so LuaLaTeX's unicode-math can set formulas in the static instances.

Writes to --out: Anodyne[GRAD,wght].ttf, Anodyne-Italic[GRAD,wght].ttf (variable) and Anodyne-{Regular,Bold,
Italic,BoldItalic}.ttf (static, GRAD 0, with MATH) plus OFL.txt.

  PYTHONPATH=<fonttools+brotli> python3 scripts/anodyne/build.py --lisnoti <Lisnoti-ttf dir> --noto <dir with
    NotoSans[wdth,wght].ttf and NotoSans-Italic[wdth,wght].ttf> --out <dir>
"""
import argparse
import array
import copy
import itertools
import math
import os
import sys
import tempfile

from fontTools.ttLib import TTFont
from fontTools.ttLib.tables._g_l_y_f import Glyph, GlyphCoordinates, GlyphComponent, flagOverlapSimple, OVERLAP_COMPOUND
from fontTools.ttLib.tables import otTables as ot
from fontTools.cu2qu import curves_to_quadratic
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.designspaceLib import DesignSpaceDocument, AxisDescriptor, SourceDescriptor, InstanceDescriptor
from fontTools import varLib
from fontTools.otlLib.builder import buildStatTable

VERSION = '0.100'
FAMILY = 'Anodyne'
# weight masters at Noto Sans's own (user values; Noto's avar puts 700 at normalised 0.61)
WEIGHTS = (100, 400, 700, 900)
GRAD_MIN, GRAD_MAX = -100, 150
INSTANCES = [(100, 'Thin'), (200, 'ExtraLight'), (300, 'Light'), (400, 'Regular'), (500, 'Medium'),
             (600, 'SemiBold'), (700, 'Bold'), (800, 'ExtraBold'), (900, 'Black')]


def log(*a):
    print(*a, file=sys.stderr, flush=True)


# ------------------------------------------------------------------ outlines as plain data

class Outline:
    """A glyph of one master: contours [[(x, y, on)]] or components [(name, x, y, transform)], and its advance."""
    __slots__ = ('contours', 'components', 'adv')

    def __init__(self, contours=None, components=None, adv=0):
        self.contours, self.components, self.adv = contours or [], components or [], adv

    def copy(self):
        return Outline([list(c) for c in self.contours], list(self.components), self.adv)


def read(font, name):
    g = font['glyf'][name]
    adv = font['hmtx'][name][0]
    if g.isComposite():
        return Outline(components=[(c.glyphName, c.x, c.y, getattr(c, 'transform', None)) for c in g.components], adv=adv)
    if g.numberOfContours <= 0:
        return Outline(adv=adv)
    coords, ends, flags = g.getCoordinates(font['glyf'])
    out, start = [], 0
    for e in ends:
        out.append([(coords[i][0], coords[i][1], bool(flags[i] & 1)) for i in range(start, e + 1)])
        start = e + 1
    return Outline(out, adv=adv)


def write(font, name, o):
    g = Glyph()
    if o.components:
        g.numberOfContours = -1
        g.components = []
        for i, (cn, x, y, tr) in enumerate(o.components):
            c = GlyphComponent()
            c.glyphName, c.x, c.y = cn, round(x), round(y)
            c.flags = OVERLAP_COMPOUND if i == 0 else 0
            if tr is not None:
                c.transform = tr
            g.components.append(c)
    elif o.contours:
        pts, flags, ends = [], [], []
        for c in o.contours:
            for x, y, on in c:
                pts.append((round(x), round(y)))
                flags.append(1 if on else 0)
            ends.append(len(pts) - 1)
        flags[0] |= flagOverlapSimple
        g.numberOfContours = len(ends)
        g.coordinates = GlyphCoordinates(pts)
        g.flags = array.array('B', flags)
        g.endPtsOfContours = ends
        g.program = None
    else:
        g.numberOfContours = 0
    from fontTools.ttLib.tables import ttProgram
    if g.numberOfContours != 0:
        g.program = ttProgram.Program()
        g.program.fromBytecode(b'')
    font['glyf'][name] = g
    g.recalcBounds(font['glyf'])
    lsb = g.xMin if g.numberOfContours != 0 and hasattr(g, 'xMin') else 0
    font['hmtx'][name] = (max(0, round(o.adv)), lsb)


def structure(o):
    if o.components:
        return ('C', tuple(c[0] for c in o.components))
    return ('S', tuple(tuple(p[2] for p in c) for c in o.contours))


def lerp(a, b, t):
    """a + t·(b − a) over two compatible outlines"""
    if a.components:
        comps = [(ca[0], ca[1] + t * (cb[1] - ca[1]), ca[2] + t * (cb[2] - ca[2]), ca[3]) for ca, cb in zip(a.components, b.components)]
        return Outline(components=comps, adv=a.adv + t * (b.adv - a.adv))
    cs = [[(pa[0] + t * (pb[0] - pa[0]), pa[1] + t * (pb[1] - pa[1]), pa[2]) for pa, pb in zip(ca, cb)] for ca, cb in zip(a.contours, b.contours)]
    return Outline(cs, adv=a.adv + t * (b.adv - a.adv))


def area(c):
    """signed area of a contour's polygon (on- and off-curve points; enough to see a flip)"""
    s = 0.0
    for i in range(len(c)):
        x0, y0 = c[i][0], c[i][1]
        x1, y1 = c[(i + 1) % len(c)][0], c[(i + 1) % len(c)][1]
        s += x0 * y1 - x1 * y0
    return s / 2


def sane(base, o):
    """no contour of o turned inside out or shrank to (almost) nothing against base"""
    for cb, co in zip(base.contours, o.contours):
        ab, ao = area(cb), area(co)
        if ab == 0:
            continue
        if ao * ab <= 0 or abs(ao) < 0.04 * abs(ab):
            return False
    return True


def between(a, b):
    """the half-way outline of two masters is between them: each contour's area within theirs (a wrong point
    correspondence collapses or twists it)"""
    if a.components:
        return True
    m = lerp(a, b, 0.5)
    for ca, cb, cm in zip(a.contours, b.contours, m.contours):
        x, y, z = area(ca), area(cb), area(cm)
        if x * y <= 0 or z * x <= 0:
            return False
        lo, hi = min(abs(x), abs(y)), max(abs(x), abs(y))
        if not 0.8 * lo <= abs(z) <= 1.2 * hi:
            return False
    return True


# ------------------------------------------------------------------ making a Bold compatible with the Regular

def explicit(contour):
    """the contour with an on-curve point to start from: a contour of off-curve points only gets its implied ones"""
    if any(p[2] for p in contour):
        return contour
    out = []
    for i, p in enumerate(contour):
        q = contour[(i + 1) % len(contour)]
        out += [p, ((p[0] + q[0]) / 2, (p[1] + q[1]) / 2, True)]
    return out


def run_samples(run, steps=10):
    """samples along a TrueType run: on-curve first and last, on- and off-curve points between"""
    pts = []
    ons = [run[0]]
    for i in range(1, len(run)):
        a, b = run[i - 1], run[i]
        if not a[2] and not b[2]:
            ons.append(((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, True))
        ons.append(b)
    for i in range(len(ons) - 1):
        a, b = ons[i], ons[i + 1]
        if a[2] and b[2]:
            pts += [(a[0] + (b[0] - a[0]) * k / steps, a[1] + (b[1] - a[1]) * k / steps) for k in range(steps)]
        elif a[2] and not b[2]:
            c, e = b, ons[i + 2]
            pts += [((1 - t) ** 2 * a[0] + 2 * (1 - t) * t * c[0] + t * t * e[0], (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * c[1] + t * t * e[1]) for t in (k / steps for k in range(steps))]
    pts.append(run[-1][:2])
    return pts


def fit_cubic(run):
    """the cubic (p0, c1, c2, p1) closest to a TrueType run (on-curve … on-curve), with its end tangents; and the error"""
    run = dedupe(run)
    p0, p1, inner = run[0], run[-1], run[1:-1]
    P0, P3 = p0[:2], p1[:2]
    if not inner:
        return (P0, (P0[0] + (P3[0] - P0[0]) / 3, P0[1] + (P3[1] - P0[1]) / 3), (P0[0] + 2 * (P3[0] - P0[0]) / 3, P0[1] + 2 * (P3[1] - P0[1]) / 3), P3), 0.0
    if len(inner) == 1 and not inner[0][2]:  # exact: degree elevation
        q = inner[0]
        c1 = (P0[0] + 2 / 3 * (q[0] - P0[0]), P0[1] + 2 / 3 * (q[1] - P0[1]))
        c2 = (P3[0] + 2 / 3 * (q[0] - P3[0]), P3[1] + 2 / 3 * (q[1] - P3[1]))
        return (P0, c1, c2, P3), 0.0
    samples = run_samples(run)
    # parameter by chord length
    d = [0.0]
    for i in range(1, len(samples)):
        d.append(d[-1] + math.dist(samples[i - 1], samples[i]))
    if d[-1] == 0:
        return (P0, P0, P3, P3), 0.0
    ts = [x / d[-1] for x in d]
    t0 = (inner[0][0] - P0[0], inner[0][1] - P0[1])
    t1 = (P3[0] - inner[-1][0], P3[1] - inner[-1][1])
    l0, l1 = math.hypot(*t0) or 1, math.hypot(*t1) or 1
    t0, t1 = (t0[0] / l0, t0[1] / l0), (t1[0] / l1, t1[1] / l1)
    # B(t) = P0·b0 + (P0 + a·t0)·b1 + (P3 − b·t1)·b2 + P3·b3: linear in a, b — least squares, then one
    # reparametrisation pass
    for _ in range(3):
        A11 = A12 = A22 = r1 = r2 = 0.0
        for t, s in zip(ts, samples):
            b0, b1, b2, b3 = (1 - t) ** 3, 3 * (1 - t) ** 2 * t, 3 * (1 - t) * t * t, t ** 3
            base = (P0[0] * (b0 + b1) + P3[0] * (b2 + b3), P0[1] * (b0 + b1) + P3[1] * (b2 + b3))
            u = (t0[0] * b1, t0[1] * b1)
            v = (-t1[0] * b2, -t1[1] * b2)
            e = (s[0] - base[0], s[1] - base[1])
            A11 += u[0] * u[0] + u[1] * u[1]; A12 += u[0] * v[0] + u[1] * v[1]; A22 += v[0] * v[0] + v[1] * v[1]
            r1 += u[0] * e[0] + u[1] * e[1]; r2 += v[0] * e[0] + v[1] * e[1]
        det = A11 * A22 - A12 * A12
        if abs(det) < 1e-9:
            a = b = d[-1] / 3
        else:
            a, b = (r1 * A22 - r2 * A12) / det, (A11 * r2 - A12 * r1) / det
        c1 = (P0[0] + a * t0[0], P0[1] + a * t0[1])
        c2 = (P3[0] - b * t1[0], P3[1] - b * t1[1])
        # reparametrise: nearest t on the cubic for each sample (a few Newton-free grid steps)
        cub = [cubic_at((P0, c1, c2, P3), k / 60) for k in range(61)]
        ts = [min(range(61), key=lambda k: (cub[k][0] - s[0]) ** 2 + (cub[k][1] - s[1]) ** 2) / 60 for s in samples]
    err = max(min(math.dist(s, c) for c in cub) for s in samples)
    return (P0, c1, c2, P3), err


def dedupe(run):
    """the run without points that repeat the one before (an on-curve point wins)"""
    out = [run[0]]
    for p in run[1:]:
        if abs(p[0] - out[-1][0]) < 1e-6 and abs(p[1] - out[-1][1]) < 1e-6:
            if p[2] and not out[-1][2]:
                out[-1] = p
            continue
        out.append(p)
    return out


def cubic_at(c, t):
    (x0, y0), (x1, y1), (x2, y2), (x3, y3) = c
    m = 1 - t
    return (m ** 3 * x0 + 3 * m * m * t * x1 + 3 * m * t * t * x2 + t ** 3 * x3, m ** 3 * y0 + 3 * m * m * t * y1 + 3 * m * t * t * y2 + t ** 3 * y3)


def reverse_contour(c):
    """the same contour run the other way, starting at the same point"""
    return [c[0]] + list(reversed(c[1:]))


def bbox(contours):
    xs = [p[0] for c in contours for p in c]
    ys = [p[1] for c in contours for p in c]
    return min(xs), min(ys), max(xs), max(ys)


def align(small, large):
    """a monotone cyclic map of the nodes `small` into `large` (each [(x, y)] in its glyph's box), nearest overall"""
    m, n = len(small), len(large)
    best, best_map = math.inf, None
    starts = sorted(range(n), key=lambda j: math.dist(small[0], large[j]))[:4]
    for s0 in starts:
        INF = math.inf
        dp = [[INF] * n for _ in range(m)]
        back = [[-1] * n for _ in range(m)]
        dp[0][0] = math.dist(small[0], large[s0])
        for i in range(1, m):
            # prefix minimum of the previous row: the best k < j
            bk, bv = -1, INF
            prev = dp[i - 1]
            for j in range(1, n - (m - 1 - i)):
                if prev[j - 1] < bv:
                    bv, bk = prev[j - 1], j - 1
                if bv < INF and j >= i:
                    dp[i][j] = bv + math.dist(small[i], large[(s0 + j) % n])
                    back[i][j] = bk
        j = min(range(n), key=lambda j: dp[m - 1][j])
        if dp[m - 1][j] < best:
            best, path = dp[m - 1][j], [j]
            for i in range(m - 1, 0, -1):
                j = back[i][j]; path.append(j)
            best_map = [(s0 + j) % n for j in reversed(path)]
    return best_map, best / m


def runs_at(contour, nodes):
    """the contour cut at the given on-curve indices into runs [on … on]"""
    out = []
    for a, b in zip(nodes, nodes[1:] + nodes[:1]):
        run = [contour[a]]
        i = a
        while True:
            i = (i + 1) % len(contour)
            run.append(contour[i])
            if i == b:
                break
        out.append(run)
    return out


def pieces(run):
    """a run as elementary pieces: (a, b) lines and (a, c, b) quadratics, implied on-curve points made explicit"""
    out = []
    cur = run[0][:2]
    pending = None
    for p in run[1:]:
        if p[2]:
            if pending is None:
                out.append((cur, p[:2]))
            else:
                out.append((cur, pending, p[:2])); pending = None
            cur = p[:2]
        else:
            if pending is None:
                pending = p[:2]
            else:
                mid = ((pending[0] + p[0]) / 2, (pending[1] + p[1]) / 2)
                out.append((cur, pending, mid)); cur = mid; pending = p[:2]
    return out


def piece_len(pc, steps=12):
    if len(pc) == 2:
        return math.dist(*pc)
    a, c, b = pc
    prev, L = a, 0.0
    for k in range(1, steps + 1):
        t = k / steps
        q = ((1 - t) ** 2 * a[0] + 2 * (1 - t) * t * c[0] + t * t * b[0], (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * c[1] + t * t * b[1])
        L += math.dist(prev, q); prev = q
    return L


def cut_own(run):
    """the run cut at its own inner on-curve points: sub-runs with their arc-length intervals [f0, f1] in the run"""
    subs, cur = [], [run[0]]
    for p in run[1:-1]:
        cur.append(p)
        if p[2]:
            subs.append(cur); cur = [p]
    cur.append(run[-1]); subs.append(cur)
    lens = [sum(piece_len(pc) for pc in pieces(r)) for r in subs]
    total = sum(lens) or 1
    out, acc = [], 0.0
    for r, L in zip(subs, lens):
        out.append((r, acc / total, (acc + L) / total)); acc += L
    return out


def split_at(run, f):
    """the run split in two at arc-length fraction f, exactly (de Casteljau on the piece there)"""
    ps = pieces(run)
    lens = [piece_len(p) for p in ps]
    target = f * (sum(lens) or 1)
    first, acc = [(*ps[0][0], True)], 0.0
    for k, (pc, L) in enumerate(zip(ps, lens)):
        if acc + L >= target or k == len(ps) - 1:
            t = min(max((target - acc) / L if L else 0.0, 0.0), 1.0)
            if len(pc) == 2:
                a, b = pc
                P = (a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]))
                first.append((*P, True)); second = [(*P, True), (*b, True)]
            else:
                a, c, b = pc
                ac = (a[0] + t * (c[0] - a[0]), a[1] + t * (c[1] - a[1]))
                cb = (c[0] + t * (b[0] - c[0]), c[1] + t * (b[1] - c[1]))
                P = (ac[0] + t * (cb[0] - ac[0]), ac[1] + t * (cb[1] - ac[1]))
                first += [(*ac, False), (*P, True)]; second = [(*P, True), (*cb, False), (*b, True)]
            for pc2 in ps[k + 1:]:
                second += [(*pc2[1], False), (*pc2[2], True)] if len(pc2) == 3 else [(*pc2[1], True)]
            return first, second
        first += [(*pc[1], False), (*pc[2], True)] if len(pc) == 3 else [(*pc[1], True)]
        acc += L


def matched_runs(x, y):
    """two corresponding runs cut into the same number of sub-runs: each at its own nodes, and where the other
    has a node it lacks (same arc-length fraction)"""
    cx, cy = cut_own(x), cut_own(y)
    fx, fy = [a[1] for a in cx[1:]], [a[1] for a in cy[1:]]
    # nodes at about the same fraction are the same node
    i = j = 0; ux, uy = [], []
    while i < len(fx) or j < len(fy):
        if i < len(fx) and j < len(fy) and abs(fx[i] - fy[j]) < 0.04:
            i += 1; j += 1
        elif j >= len(fy) or (i < len(fx) and fx[i] < fy[j]):
            ux.append(fx[i]); i += 1
        else:
            uy.append(fy[j]); j += 1
    def apply(cuts, extra):
        out = []
        for r, f0, f1 in cuts:
            inside = [(f - f0) / (f1 - f0) for f in extra if f0 < f < f1 and f1 > f0]
            done = 0.0
            for g in inside:
                a, r = split_at(r, (g - done) / (1 - done)); out.append(a); done = g
            out.append(r)
        return out
    return apply(cx, uy), apply(cy, ux)


def fit_pair(x, y, depth=0):
    """corresponding runs as pairs of cubics within 2 units, both halved at the same fraction while they do not fit"""
    (c1, e1), (c2, e2) = fit_cubic(x), fit_cubic(y)
    if e1 <= 2 and e2 <= 2:
        return [(c1, c2)]
    if depth >= 3:
        return None
    (x1, x2), (y1, y2) = split_at(x, 0.5), split_at(y, 0.5)
    a, b = fit_pair(x1, y1, depth + 1), fit_pair(x2, y2, depth + 1)
    return a + b if a is not None and b is not None else None


def make_compatible(R, B):
    """the Regular and the Bold with the same points (nodes matched or inserted, runs refitted), or None"""
    if R.components or B.components or len(R.contours) != len(B.contours):
        return None
    n = len(R.contours)
    def box(o):
        x0, y0, x1, y1 = bbox(o.contours)
        return lambda p: ((p[0] - x0) / ((x1 - x0) or 1), (p[1] - y0) / ((y1 - y0) or 1))
    nr, nb = box(R), box(B)
    def centre(c, nm):
        x0, y0, x1, y1 = bbox([c]); a, b = nm((x0, y0)), nm((x1, y1))
        return ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, b[0] - a[0], b[1] - a[1])
    cr = [centre(c, nr) for c in R.contours]
    cb = [centre(c, nb) for c in B.contours]
    cost = lambda perm: sum(sum(abs(x - y) for x, y in zip(cr[i], cb[j])) for i, j in enumerate(perm))
    if n <= 6:
        perm = min(itertools.permutations(range(n)), key=cost)
    else:
        free, perm = set(range(n)), []
        for i in range(n):
            j = min(free, key=lambda j: sum(abs(x - y) for x, y in zip(cr[i], cb[j]))); perm.append(j); free.discard(j)
    outR, outB = [], []
    for ci in range(n):
        r = explicit(R.contours[ci])
        b = explicit(B.contours[perm[ci]])
        if area(b) * area(r) < 0:
            b = reverse_contour(b)
        ir = [i for i, p in enumerate(r) if p[2]]
        ib = [i for i, p in enumerate(b) if p[2]]
        pr, pb = [nr(r[i]) for i in ir], [nb(b[i]) for i in ib]
        if len(ir) <= len(ib):
            mp, err = align(pr, pb)
            nodes_r, nodes_b = ir, [ib[k] for k in mp]
        else:
            mp, err = align(pb, pr)
            nodes_r, nodes_b = [ir[k] for k in mp], ib
        if mp is None or err > 0.12:
            return None
        rr, rb = runs_at(r, nodes_r), runs_at(b, nodes_b)
        cr_, cb_ = [], []
        for x, y in zip(rr, rb):
            # the other master's extra nodes, inserted at the same arc-length fractions
            xs, ys = matched_runs(x, y)
            if len(xs) != len(ys):
                return None
            for xx, yy in zip(xs, ys):
                same = len(xx) == len(yy) and all(p[2] == q[2] for p, q in zip(xx, yy))
                if same:
                    cr_.append(xx[:-1]); cb_.append(yy[:-1]); continue
                pairs = fit_pair(xx, yy)
                if pairs is None:
                    return None
                for c1, c2 in pairs:
                    try:
                        q1, q2 = curves_to_quadratic([c1, c2], [1.0, 1.0])
                    except Exception:
                        return None
                    cr_.append([(q1[0][0], q1[0][1], True)] + [(p[0], p[1], False) for p in q1[1:-1]])
                    cb_.append([(q2[0][0], q2[0][1], True)] + [(p[0], p[1], False) for p in q2[1:-1]])
        outR.append([p for run in cr_ for p in run])
        outB.append([p for run in cb_ for p in run])
    return [Outline(outR, adv=R.adv), Outline(outB, adv=B.adv)]


# ------------------------------------------------------------------ emboldening (FreeType's FT_Outline_EmboldenXY)

def embolden(o, sx, sy):
    """o grown by sx/sy units on each side of every stroke (negative: thinned), points kept; advance + 2·sx"""
    out = []
    for c in o.contours:
        n = len(c)
        ar = area(c)
        sign = 1 if ar < 0 else -1  # TrueType outer contours run clockwise (negative area)
        res = []
        for i in range(n):
            p, q, r = c[i - 1], c[i], c[(i + 1) % n]
            ix, iy = q[0] - p[0], q[1] - p[1]
            ox, oy = r[0] - q[0], r[1] - q[1]
            li, lo = math.hypot(ix, iy), math.hypot(ox, oy)
            if li == 0 or lo == 0:
                res.append(q); continue
            ix, iy, ox, oy = ix / li, iy / li, ox / lo, oy / lo
            d = ix * ox + iy * oy
            if d <= -0.9375:
                res.append(q); continue
            d += 1
            shx, shy = iy + oy, -(ix + ox)
            qq = ox * iy - oy * ix
            l = min(abs(sx), abs(sy)) or abs(sx) or abs(sy)
            if abs(qq) <= l * d:
                shx, shy = shx * sx / d, shy * sy / d
            else:
                shx, shy = shx * l * sx / abs(qq) if qq else 0, shy * l * sy / abs(qq) if qq else 0
            res.append((q[0] - sign * shx + sx, q[1] - sign * shy, q[2]))
        out.append(res)
    return Outline(out, adv=o.adv + 2 * sx)


# ------------------------------------------------------------------ small capitals from Noto Sans

def single_subst_map(font, tag):
    """base glyph → alternate, over the font's single substitutions under a feature"""
    gsub = font['GSUB'].table
    idx = {i for i, fr in enumerate(gsub.FeatureList.FeatureRecord) if fr.FeatureTag == tag}
    lookups = {li for i in idx for li in gsub.FeatureList.FeatureRecord[i].Feature.LookupListIndex}
    m = {}
    for li in sorted(lookups):
        lk = gsub.LookupList.Lookup[li]
        for st in lk.SubTable:
            if lk.LookupType == 7:
                st = st.ExtSubTable
            if getattr(st, 'mapping', None):
                for a, b in st.mapping.items():
                    m.setdefault(a, b)
    return m


def add_feature(font, tag, mapping):
    """a GSUB feature `tag` with one single-substitution lookup, registered in every script and language"""
    from fontTools.otlLib.builder import buildSingleSubstSubtable, buildLookup
    gsub = font['GSUB'].table
    lookup = buildLookup([buildSingleSubstSubtable(mapping)])
    gsub.LookupList.Lookup.append(lookup)
    gsub.LookupList.LookupCount = len(gsub.LookupList.Lookup)
    fr = ot.FeatureRecord()
    fr.FeatureTag = tag
    fr.Feature = ot.Feature()
    fr.Feature.FeatureParams = None
    fr.Feature.LookupListIndex = [len(gsub.LookupList.Lookup) - 1]
    fr.Feature.LookupCount = 1
    gsub.FeatureList.FeatureRecord.append(fr)
    fi = len(gsub.FeatureList.FeatureRecord) - 1
    gsub.FeatureList.FeatureCount = len(gsub.FeatureList.FeatureRecord)
    for sr in gsub.ScriptList.ScriptRecord:
        langs = [sr.Script.DefaultLangSys] + [l.LangSys for l in sr.Script.LangSysRecord]
        for ls in langs:
            if ls is not None:
                ls.FeatureIndex.append(fi)
                ls.FeatureCount = len(ls.FeatureIndex)
    # feature records must stay sorted by tag: sort and remap indices
    recs = gsub.FeatureList.FeatureRecord
    order = sorted(range(len(recs)), key=lambda i: recs[i].FeatureTag)
    new_index = {old: new for new, old in enumerate(order)}
    gsub.FeatureList.FeatureRecord = [recs[i] for i in order]
    for sr in gsub.ScriptList.ScriptRecord:
        for ls in [sr.Script.DefaultLangSys] + [l.LangSys for l in sr.Script.LangSysRecord]:
            if ls is not None:
                ls.FeatureIndex = sorted(new_index[i] for i in ls.FeatureIndex)
                if ls.ReqFeatureIndex != 0xFFFF:
                    ls.ReqFeatureIndex = new_index[ls.ReqFeatureIndex]


# ------------------------------------------------------------------ the build of one style (roman or italic)

def build_style(lisR, lisB, notoVF, italic, tmp):
    style = 'Italic' if italic else 'Roman'
    log(f'[{style}] loading')
    R, B = TTFont(lisR), TTFont(lisB)
    V = instantiateVariableFont(TTFont(notoVF), {'wdth': 100})
    noto = {w: instantiateVariableFont(TTFont(notoVF), {'wdth': 100, 'wght': w}) for w in WEIGHTS}
    # Noto's own stems, for the extrapolation and emboldening ratios: the stem of 'l' (a plain bar in Noto)
    def stem(f):
        o = read(f, 'l'); x0, _, x1, _ = bbox(o.contours); return x1 - x0
    s = {w: stem(noto[w]) for w in WEIGHTS}
    k_thin, k_black = (s[100] - s[400]) / (s[700] - s[400]), (s[900] - s[400]) / (s[700] - s[400])
    log(f'[{style}] Noto stems {s}; thin ×{k_thin:.2f}, black ×{k_black:.2f}')

    # --- small capitals: Noto's smcp/c2sc glyphs (and their components) into the Regular
    names = set(R.getGlyphOrder())
    smcp, c2sc = single_subst_map(V, 'smcp'), single_subst_map(V, 'c2sc')
    smcp = {a: b for a, b in smcp.items() if a in names}
    c2sc = {a: b for a, b in c2sc.items() if a in names}
    added = []
    def need(g):
        if g in names or g in added:
            return
        added.append(g)
        gl = V['glyf'][g]
        if gl.isComposite():
            for c in gl.components:
                need(c.glyphName)
    for g in list(smcp.values()) + list(c2sc.values()):
        need(g)
    # glyphs that already exist under those names in Lisnoti but differ from Noto's would be wrong targets
    order = R.getGlyphOrder() + added
    R.setGlyphOrder(order)
    for g in added:
        R['glyf'].glyphs[g] = copy.deepcopy(V['glyf'][g])
        R['hmtx'].metrics[g] = V['hmtx'][g]
    R['glyf'].glyphOrder = order
    if 'post' in R and hasattr(R['post'], 'extraNames'):
        pass
    add_feature(R, 'smcp', smcp)
    add_feature(R, 'c2sc', c2sc)
    log(f'[{style}] small caps: {len(smcp)} smcp, {len(c2sc)} c2sc, {len(added)} glyphs from Noto')

    # --- masters per glyph
    masters = {w: {} for w in WEIGHTS}
    kinds = {'noto': 0, 'bold': 0, 'fitted': 0, 'embolden': 0, 'static': 0}
    vnames = set(V.getGlyphOrder())
    bnames = set(B.getGlyphOrder())
    for g in order:
        r = read(R, g)
        masters[400][g] = r
        if not r.contours and not r.components:
            for w in (100, 700, 900):
                o = r.copy()
                if g in vnames and not read(V, g).contours and not read(V, g).components:
                    o.adv = noto[w]['hmtx'][g][0]
                masters[w][g] = o
            kinds['static'] += 1
            continue
        if g in vnames:
            v = read(V, g)
            if structure(v) == structure(r) and (v.contours == r.contours if r.contours else [(c[0], c[1], c[2]) for c in v.components] == [(c[0], c[1], c[2]) for c in r.components]):
                for w in (100, 700, 900):
                    masters[w][g] = read(noto[w], g)
                kinds['noto'] += 1
                continue
        b = read(B, g) if g in bnames else None
        pair = None
        if b is not None and r.components and structure(b) == structure(r):
            pair = [r, b]
            kinds['bold'] += 1
        elif b is not None:
            # also for the same structure: the Bold may start its contours elsewhere or order them otherwise
            pair = make_compatible(r, b)
            if pair:
                kinds['bold' if structure(b) == structure(r) else 'fitted'] += 1
                masters[400][g] = pair[0]
        if pair and not between(*pair):
            pair = None
        if pair:
            r0, b0 = pair
            masters[700][g] = b0
            kt, kb = k_thin, k_black
            thin = lerp(r0, b0, kt)
            while not sane(r0, thin) and kt < -0.2:
                kt *= 0.8
                thin = lerp(r0, b0, kt)
            masters[100][g] = thin
            masters[900][g] = lerp(r0, b0, kb)
            continue
        if r.components:  # a composite of glyphs that vary on their own
            for w in (100, 700, 900):
                masters[w][g] = r.copy()
            kinds['static'] += 1
            continue
        # embolden: Noto's stem growth, half on each side; y a little less, as Noto's bolds do
        for w in (100, 700, 900):
            dx = (s[w] - s[400]) / 2
            o = embolden(r, dx, dx * 0.75)
            f = 1.0
            while not sane(r, o) and f > 0.2:
                f *= 0.75
                o = embolden(r, dx * f, dx * f * 0.75)
            masters[w][g] = o
        kinds['embolden'] += 1
    log(f'[{style}] glyph sources: {kinds}')

    # --- grade masters: stems of 400+GRAD at 400's widths
    def at(g, wt):
        # Noto's avar: user 300 → normalised −0.5 (half-way to Thin); 550 → 0.28 (0.459 of the way to the 0.61 Bold)
        if wt < 400:
            t = {300: 0.5}[wt]
            return lerp(masters[400][g], masters[100][g], t)
        t = {550: 0.28 / 0.61}[wt]
        return lerp(masters[400][g], masters[700][g], t)
    grade = {GRAD_MIN: {}, GRAD_MAX: {}}
    for gv, wt in ((GRAD_MIN, 300), (GRAD_MAX, 550)):
        for g in order:
            base = masters[400][g]
            o = at(g, wt)
            dadv = o.adv - base.adv
            a = base.adv or 1
            if o.components:
                comps = [(c[0], c[1] - dadv * (cb[1] / a), c[2], c[3]) for c, cb in zip(o.components, base.components)]
                grade[gv][g] = Outline(components=comps, adv=base.adv)
            else:
                cs = [[(p[0] - dadv * (pb[0] / a), p[1], p[2]) for p, pb in zip(c, cb)] for c, cb in zip(o.contours, base.contours)]
                grade[gv][g] = Outline(cs, adv=base.adv)

    # --- master fonts
    for t in ('fpgm', 'prep', 'cvt ', 'hdmx', 'LTSH', 'VDMX', 'DSIG', 'STAT'):
        if t in R:
            del R[t]
    paths = {}
    locs = [((w, 0), masters[w]) for w in WEIGHTS] + [((400, gv), grade[gv]) for gv in (GRAD_MIN, GRAD_MAX)]
    for (w, gv), glyphs in locs:
        f = copy.deepcopy(R)
        for g in order:
            write(f, g, glyphs[g])
        f['maxp'].recalc(f)
        p = os.path.join(tmp, f'{style}-{w}-{gv}.ttf')
        f.save(p)
        paths[(w, gv)] = p
    log(f'[{style}] masters written')

    ds = DesignSpaceDocument()
    wa = AxisDescriptor(); wa.tag, wa.name, wa.minimum, wa.default, wa.maximum = 'wght', 'Weight', 100, 400, 900
    # Noto Sans's avar (user → design): the masters sit where Noto's do
    wa.map = [(100, 100), (200, 400 - 0.796875 * 300), (300, 250), (400, 400), (500, 400 + 0.18 * 500), (600, 400 + 0.38 * 500), (700, 400 + 0.61 * 500), (800, 400 + 0.79 * 500), (900, 900)]
    ga = AxisDescriptor(); ga.tag, ga.name, ga.minimum, ga.default, ga.maximum = 'GRAD', 'Grade', GRAD_MIN, 0, GRAD_MAX
    ds.addAxis(wa); ds.addAxis(ga)
    design = dict(wa.map)
    for (w, gv), p in paths.items():
        sd = SourceDescriptor(); sd.path = p; sd.location = {'Weight': design[w], 'Grade': gv}
        sd.copyInfo = sd.copyLib = sd.copyFeatures = sd.copyGroups = (w, gv) == (400, 0)
        ds.addSource(sd)
    for wv, nm in INSTANCES:
        inst = InstanceDescriptor(); inst.familyName = FAMILY
        inst.styleName = (nm + ' Italic' if nm != 'Regular' else 'Italic') if italic else nm
        inst.location = {'Weight': design[wv], 'Grade': 0}
        ds.addInstance(inst)
    log(f'[{style}] varLib.build')
    vf, _, _ = varLib.build(ds, exclude=['MVAR'], optimize=True)
    return vf, R, B


# ------------------------------------------------------------------ names, STAT, statics

OFL_URL = 'https://openfontlicense.org'


def set_names(font, style, ps_style, variable):
    nm = font['name']
    copyright_ = ('Noto Sans: Copyright 2022 The Noto Project Authors (https://github.com/notofonts/latin-greek-cyrillic). '
                  'Noto Sans Symbols, Noto Sans Math: Copyright 2022 The Noto Project Authors / Google LLC. '
                  'Lisnoti: Modifications copyright 2024-2026 Tim Gordon with Reserved Font Name "Lisnoti" (https://github.com/Lisnoti/Lisnoti). '
                  'Anodyne: Modifications copyright 2026 The OverLyX authors (https://overlyx.app).')
    keep = {}
    for rec in nm.names:
        if rec.nameID >= 256:
            keep.setdefault(rec.nameID, rec.toUnicode())
    nm.names = [r for r in nm.names if r.nameID >= 256]
    vals = {
        0: copyright_, 1: FAMILY, 2: style, 3: f'{VERSION};OLYX;{FAMILY}-{ps_style}', 4: f'{FAMILY} {style}' if style != 'Regular' else f'{FAMILY} Regular',
        5: f'Version {VERSION}', 6: f'{FAMILY}-{ps_style}', 8: 'OverLyX', 9: 'Noto Project; Tim Gordon (Lisnoti); OverLyX (Anodyne)',
        11: 'https://overlyx.app', 13: 'This Font Software is licensed under the SIL Open Font License, Version 1.1. This license is available with a FAQ at: https://openfontlicense.org',
        14: OFL_URL,
    }
    if variable:
        vals[25] = FAMILY
    for i, v in vals.items():
        nm.setName(v, i, 3, 1, 0x409)
        nm.setName(v, i, 1, 0, 0)
    if 'OS/2' in font:
        font['OS/2'].achVendID = 'OLYX'
    for rec in nm.names:
        assert 'Lisnoti' not in rec.toUnicode() or rec.nameID in (0, 9), (rec.nameID, rec.toUnicode())


def stat(vf, italic):
    axes = [
        dict(tag='wght', name='Weight', values=[dict(value=v, name=n, **({'flags': 0x2} if v == 400 else {})) for v, n in INSTANCES]),
        dict(tag='GRAD', name='Grade', values=[dict(value=0, name='Normal', flags=0x2)]),
        dict(tag='ital', name='Italic', values=[dict(value=1, name='Italic')] if italic else [dict(value=0, name='Roman', flags=0x2, linkedValue=1)]),
    ]
    buildStatTable(vf, axes, elidedFallbackName=2)


def sort_math(font):
    """the MATH table's coverages in the font's glyph order, their records along (entries for absent glyphs dropped)"""
    m = font['MATH'].table
    gid = font.getReverseGlyphMap()
    def sort(cov, owner=None, attr=None):
        if cov is None:
            return
        keep = [i for i, g in enumerate(cov.glyphs) if g in gid]
        idx = sorted(keep, key=lambda i: gid[cov.glyphs[i]])
        if owner is not None:
            arr = getattr(owner, attr)
            setattr(owner, attr, [arr[i] for i in idx])
        cov.glyphs = [cov.glyphs[i] for i in idx]
    gi = m.MathGlyphInfo
    if gi.MathItalicsCorrectionInfo:
        sort(gi.MathItalicsCorrectionInfo.Coverage, gi.MathItalicsCorrectionInfo, 'ItalicsCorrection')
        gi.MathItalicsCorrectionInfo.ItalicsCorrectionCount = len(gi.MathItalicsCorrectionInfo.ItalicsCorrection)
    if gi.MathTopAccentAttachment:
        sort(gi.MathTopAccentAttachment.TopAccentCoverage, gi.MathTopAccentAttachment, 'TopAccentAttachment')
        gi.MathTopAccentAttachment.TopAccentAttachmentCount = len(gi.MathTopAccentAttachment.TopAccentAttachment)
    sort(gi.ExtendedShapeCoverage)
    if gi.MathKernInfo:
        sort(gi.MathKernInfo.MathKernCoverage, gi.MathKernInfo, 'MathKernInfoRecords')
        gi.MathKernInfo.MathKernCount = len(gi.MathKernInfo.MathKernInfoRecords)
    mv = m.MathVariants
    if mv.VertGlyphCoverage:
        sort(mv.VertGlyphCoverage, mv, 'VertGlyphConstruction'); mv.VertGlyphCount = len(mv.VertGlyphConstruction)
    if mv.HorizGlyphCoverage:
        sort(mv.HorizGlyphCoverage, mv, 'HorizGlyphConstruction'); mv.HorizGlyphCount = len(mv.HorizGlyphConstruction)


def static(vf, w, math_from, out, style, ps):
    f = instantiateVariableFont(copy.deepcopy(vf), {'wght': w, 'GRAD': 0}, updateFontNames=False)
    if 'STAT' in f:
        del f['STAT']
    if math_from is not None and 'MATH' in math_from:
        names = set(f.getGlyphOrder())
        f['MATH'] = copy.deepcopy(math_from['MATH'])
        sort_math(f)
        try:
            f['MATH'].compile(f)
        except Exception as e:
            log('MATH from the Bold did not fit:', e)
            f['MATH'] = copy.deepcopy(vf['MATH'])
    set_names(f, style, ps, False)
    f['OS/2'].usWeightClass = w
    f['OS/2'].fsSelection = (f['OS/2'].fsSelection & ~0b1100001) | (0x20 if w >= 700 else 0) | (0x1 if 'Italic' in style else 0) | (0x40 if style == 'Regular' else 0)
    f['head'].macStyle = (1 if w >= 700 else 0) | (2 if 'Italic' in style else 0)
    f.save(out)
    log('wrote', out, os.path.getsize(out))


# the web files by Unicode range: the same ranges as the server's (packages/server/src/googlefonts.ts ANODYNE_RANGES)
WEB_RANGES = [
    ('latin', 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2212, U+2215, U+FEFF, U+FFFD'),
    ('latin-ext', 'U+0100-024F, U+0259, U+0300-036F, U+1E00-1EFF, U+2020, U+20A0-20AB, U+20AD-20CF, U+2113, U+2C60-2C7F, U+A720-A7FF'),
    ('greek', 'U+0370-03FF, U+1F00-1FFF'),
    ('cyrillic', 'U+0400-052F, U+1C80-1C88, U+2DE0-2DFF, U+A640-A69F'),
    ('symbols', 'U+2190-21FF, U+2300-23FF, U+2460-24FF, U+2500-27BF'),
    ('math', 'U+2070-209F, U+2100-2111, U+2114-2121, U+2123-218F, U+2200-2211, U+2213-2214, U+2216-22FF, U+27C0-27FF, U+2900-2BFF'),
    ('math-alpha', 'U+1D400-1D7FF'),
]


def unicodes(spec):
    out = []
    for part in spec.split(','):
        part = part.strip()[2:]
        lo, _, hi = part.partition('-')
        out += range(int(lo, 16), int(hi or lo, 16) + 1)
    return out


def install(out, repo):
    """the files OverLyX serves: web/ variable woff2 by range and anodyne.css, tex/ the static faces, OFL.txt"""
    from fontTools import subset
    import shutil
    web, tex = os.path.join(repo, 'web'), os.path.join(repo, 'tex')
    os.makedirs(web, exist_ok=True); os.makedirs(tex, exist_ok=True)
    css = ['/* generated by scripts/anodyne/build.py: Anodyne, variable (wght 100–900, GRAD −100–150), by Unicode range */']
    for style, src in (('roman', f'{FAMILY}[GRAD,wght].ttf'), ('italic', f'{FAMILY}-Italic[GRAD,wght].ttf')):
        for part, rng in WEB_RANGES:
            f = TTFont(os.path.join(out, src))
            del f['MATH']
            opts = subset.Options()
            opts.layout_features = ['*']; opts.flavor = 'woff2'; opts.name_IDs = ['*']; opts.notdef_outline = True
            opts.hinting = False; opts.desubroutinize = True
            sub = subset.Subsetter(opts)
            sub.populate(unicodes=unicodes(rng))
            sub.subset(f)
            name = f'anodyne-{style}-{part}.woff2'
            f.flavor = 'woff2'
            f.save(os.path.join(web, name))
            log('web', name, os.path.getsize(os.path.join(web, name)))
            css.append(f'@font-face {{ font-family: "Anodyne"; font-style: {"italic" if style == "italic" else "normal"}; font-weight: 100 900; font-display: swap; '
                       f'src: url("./{name}") format("woff2"); unicode-range: {rng}; }}')
    open(os.path.join(web, 'anodyne.css'), 'w').write('\n'.join(css) + '\n')
    for n in ('Regular', 'Bold', 'Italic', 'BoldItalic'):
        shutil.copy(os.path.join(out, f'{FAMILY}-{n}.ttf'), os.path.join(tex, f'{FAMILY}-{n}.ttf'))
    shutil.copy(os.path.join(out, 'OFL.txt'), os.path.join(repo, 'OFL.txt'))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--lisnoti', required=True)
    ap.add_argument('--noto', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--only', choices=['roman', 'italic'])
    ap.add_argument('--repo', help='then write the files OverLyX serves into this folder (fonts/anodyne)')
    ap.add_argument('--install-only', action='store_true', help='skip the build: only --repo from --out')
    a = ap.parse_args()
    if a.install_only:
        install(a.out, a.repo)
        return
    os.makedirs(a.out, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        for italic in (False, True):
            if a.only and a.only != ('italic' if italic else 'roman'):
                continue
            r, b = ('Lisnoti-Italic.ttf', 'Lisnoti-BoldItalic.ttf') if italic else ('Lisnoti-Regular.ttf', 'Lisnoti-Bold.ttf')
            nv = 'NotoSans-Italic[wdth,wght].ttf' if italic else 'NotoSans[wdth,wght].ttf'
            vf, R, B = build_style(os.path.join(a.lisnoti, r), os.path.join(a.lisnoti, b), os.path.join(a.noto, nv), italic, tmp)
            set_names(vf, 'Italic' if italic else 'Regular', 'Italic' if italic else 'Regular', True)
            stat(vf, italic)
            name = f'{FAMILY}-Italic[GRAD,wght].ttf' if italic else f'{FAMILY}[GRAD,wght].ttf'
            vf.save(os.path.join(a.out, name))
            log('wrote', name, os.path.getsize(os.path.join(a.out, name)))
            vf = TTFont(os.path.join(a.out, name))
            if italic:
                static(vf, 400, None, os.path.join(a.out, f'{FAMILY}-Italic.ttf'), 'Italic', 'Italic')
                static(vf, 700, B, os.path.join(a.out, f'{FAMILY}-BoldItalic.ttf'), 'Bold Italic', 'BoldItalic')
            else:
                static(vf, 400, None, os.path.join(a.out, f'{FAMILY}-Regular.ttf'), 'Regular', 'Regular')
                static(vf, 700, B, os.path.join(a.out, f'{FAMILY}-Bold.ttf'), 'Bold', 'Bold')
    lic = os.path.join(a.lisnoti, '..', '..', 'Licence.txt')
    if os.path.exists(lic):
        text = open(lic, encoding='utf-8').read()
        text = text.replace('Modifications copyright 2024-2026 Tim Gordon with Reserved Font Name "Lisnoti" (https://github.com/Lisnoti/Lisnoti).',
                            'Modifications copyright 2024-2026 Tim Gordon with Reserved Font Name "Lisnoti" (https://github.com/Lisnoti/Lisnoti).\n'
                            'Anodyne: modifications copyright 2026 The OverLyX authors (https://overlyx.app); no Reserved Font Name.')
        open(os.path.join(a.out, 'OFL.txt'), 'w', encoding='utf-8').write(text)
    if a.repo:
        install(a.out, a.repo)


if __name__ == '__main__':
    main()

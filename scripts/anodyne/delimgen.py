"""
Anodyne's tall delimiters drawn the way Computer Modern's (cmex, Latin Modern Math) grow: Noto Sans Math's
size variants of braces are the brace stretched upright (hooks and beak drawn out into a bracket-like shape),
and its parentheses and angle brackets widen only a little as they grow. Every size variant is drawn again
here from the font's own base glyph, so the style stays Anodyne's:

  parentheses, angle brackets   the stroke's centre line (the middle between its two sides at each height)
                                scaled to the variant's height and widened by (height ratio) ** WIDEN, as
                                Computer Modern's bow out; the stroke keeps its thickness, a little heavier
                                as it grows (TCK)
  braces, square brackets,      the straight vertical runs (arms, stem) lengthen; a brace's hooks and beak
  floor and ceiling             grow in both directions by (height ratio) ** CURL, so a tall brace is still
                                a brace (Computer Modern's are about as wide as the square root of their
                                height), and a bracket's arms lengthen by (height ratio) ** ARM; what grows
                                is brought back to the stroke's thickness by moving its outline into the
                                ink (FreeType's emboldening, backwards)

Each variant keeps its height and depth and the base glyph's side bearings; its points are the base glyph's,
so a Regular and a Bold made compatible stay so. mathtune.py lets the bearings grow afterwards.
"""
import math
from fontTools.pens.basePen import BasePen

WIDEN = {'paren': 0.8, 'angle': 0.8}
TCK = 0.12        # stroke growth per doubling of the height
# angle brackets stop growing here, as Computer Modern's do (the tallest drawn is used above it)
ANGLE_MAX = 2600
CURL = 0.55       # how a brace's hooks and beak grow with the height (Computer Modern's: width ~ height ** 0.5)
ARM = 0.4         # how a bracket's arms lengthen with the height


class _Flat(BasePen):
    """a glyph as polylines (curves sampled)"""
    def __init__(self, gs):
        super().__init__(gs)
        self.polys, self.cur = [], []

    def _moveTo(self, p):
        self.cur = [p]

    def _lineTo(self, p):
        self.cur.append(p)

    def _qCurveToOne(self, p1, p2):
        p0 = self.cur[-1]
        for k in range(1, 9):
            t = k / 8
            self.cur.append(((1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0], (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1]))

    def _curveToOne(self, p1, p2, p3):
        p0 = self.cur[-1]
        for k in range(1, 9):
            t = k / 8
            m = 1 - t
            self.cur.append((m ** 3 * p0[0] + 3 * m * m * t * p1[0] + 3 * m * t * t * p2[0] + t ** 3 * p3[0], m ** 3 * p0[1] + 3 * m * m * t * p1[1] + 3 * m * t * t * p2[1] + t ** 3 * p3[1]))

    def _closePath(self):
        self.polys.append(self.cur)
        self.cur = []

    _endPath = _closePath


def _crossings(polys, y):
    xs = []
    for poly in polys:
        for a, b in zip(poly, poly[1:] + poly[:1]):
            if (a[1] - y) * (b[1] - y) < 0 or (a[1] == y and b[1] != y):
                t = (y - a[1]) / (b[1] - a[1])
                xs.append(a[0] + t * (b[0] - a[0]))
    return sorted(xs)


def _outline(font, name):
    g = font['glyf'][name]
    coords, ends, flags = g.getCoordinates(font['glyf'])
    return [(x, y) for x, y in coords], list(ends), [f & 1 for f in flags]


def _write(font, name, pts, ends, onflags, base):
    from fontTools.ttLib.tables._g_l_y_f import Glyph, GlyphCoordinates
    import array
    b = font['glyf'][base]
    # the base glyph's side bearings (mathtune.py lets them grow with the height)
    dx = b.xMin - min(x for x, _ in pts)
    g = Glyph()
    g.numberOfContours = len(ends)
    g.coordinates = GlyphCoordinates([(round(x + dx), round(y)) for x, y in pts])
    g.flags = array.array('B', onflags)
    g.endPtsOfContours = list(ends)
    g.program = b.program
    font['glyf'][name] = g
    g.recalcBounds(font['glyf'])
    adv, _ = font['hmtx'][base]
    font['hmtx'][name] = (round(adv + (g.xMax - b.xMax)), g.xMin)


def stroke_scaled(font, base, name, y0, y1, widen):
    """the base glyph's stroke at the extent y0..y1: centre line scaled, thickness kept"""
    pts, ends, on = _outline(font, base)
    gs = font.getGlyphSet()
    pen = _Flat(gs)
    gs[base].draw(pen)
    b = font['glyf'][base]
    by0, by1 = b.yMin, b.yMax
    sy = (y1 - y0) / (by1 - by0)
    sx = sy ** widen
    tg = 1 + TCK * math.log2(sy) if sy > 1 else 1
    eps = 0.6

    def centre(y):
        yy = min(max(y, by0 + eps), by1 - eps)
        xs = _crossings(pen.polys, yy)
        return ((xs[0] + xs[-1]) / 2) if len(xs) >= 2 else None

    c_end = centre(by1 - eps)

    def F(p):
        c = centre(p[1])
        if c is None:
            c = c_end
        return (c_end + (c - c_end) * sx + (p[0] - c) * tg, y0 + (p[1] - by0) * sy)

    # points on the outline move by F; a control point lies off it (its offset from the centre line is
    # mostly the curve's bulge, which must widen with the bow), so it is put back from where the
    # middle of its curve went: C' = 2 F(M) - (F(A) + F(B)) / 2
    out = list(pts)
    start = 0
    for e in ends:
        idx = list(range(start, e + 1))
        n = len(idx)
        for k, i in enumerate(idx):
            p = pts[i]
            if on[i]:
                out[i] = F(p)
                continue
            pv, nx_ = idx[(k - 1) % n], idx[(k + 1) % n]
            a = pts[pv] if on[pv] else ((pts[pv][0] + p[0]) / 2, (pts[pv][1] + p[1]) / 2)
            b = pts[nx_] if on[nx_] else ((p[0] + pts[nx_][0]) / 2, (p[1] + pts[nx_][1]) / 2)
            m = ((a[0] + 2 * p[0] + b[0]) / 4, (a[1] + 2 * p[1] + b[1]) / 4)
            fa, fb, fm = F(a), F(b), F(m)
            out[i] = (2 * fm[0] - (fa[0] + fb[0]) / 2, 2 * fm[1] - (fa[1] + fb[1]) / 2)
        start = e + 1
    _write(font, name, out, ends, on, base)


def _offset(pts, ends, d_of):
    """each point moved d_of(i) (a number, or (dx_only, d)) into the ink along its corner's mitred normal
    (TrueType outlines have their ink on the right), as FreeType emboldens with a negative strength"""
    out = list(pts)
    start = 0
    for e in ends:
        idx = list(range(start, e + 1))
        n = len(idx)
        for k, i in enumerate(idx):
            d, x_only = d_of(i)
            if not d:
                continue
            p = pts[i]
            # the nearest neighbours either side further than the offset itself (a short edge by a corner
            # moves with the corner, or the corner would pass it and fold the outline)
            far = max(0.5, 1.2 * abs(d))
            def nb(step):
                for s in range(1, n):
                    q = pts[idx[(k + step * s) % n]]
                    if math.hypot(q[0] - p[0], q[1] - p[1]) > far:
                        return q
                return p
            a, b = nb(-1), nb(1)
            t1 = _unit((p[0] - a[0], p[1] - a[1]))
            t2 = _unit((b[0] - p[0], b[1] - p[1]))
            n1, n2 = (t1[1], -t1[0]), (t2[1], -t2[0])
            den = 1 + n1[0] * n2[0] + n1[1] * n2[1]
            if den < 0.25:      # (a spike: no further than 2.8 d)
                den = 0.25
            ox, oy = (n1[0] + n2[0]) * d / den, (n1[1] + n2[1]) * d / den
            out[i] = (p[0] + ox, p[1] + (0 if x_only else oy))
        start = e + 1
    return out


def _unit(v):
    d = math.hypot(*v)
    return (v[0] / d, v[1] / d) if d > 1e-9 else (0.0, 0.0)


def zones_kept(font, base, name, y0, y1, kind):
    """the base glyph at the extent y0..y1: the straight vertical runs (a brace's arms, a bracket's stem)
    lengthen; a brace's hooks and beak grow in both directions, as Computer Modern's do ((height ratio) **
    CURL), a bracket's arms in length ((height ratio) ** ARM). What grows is scaled about the arm's centre line
    and then brought back to the stroke's thickness (a little heavier as it grows, TCK) by moving its outline
    into the ink, so curls and arms keep the weight of the stem"""
    pts, ends, on = _outline(font, base)
    b = font['glyf'][base]
    by0, by1 = b.yMin, b.yMax
    sy = (y1 - y0) / (by1 - by0)
    tg = 1 + TCK * math.log2(sy) if sy > 1 else 1
    brace = kind == 'brace'
    gx = sy ** (CURL if brace else ARM)
    gy = gx if brace else tg
    # the straight vertical runs: consecutive on-curve points one above the other
    runs = []
    start = 0
    for e in ends:
        n = e - start + 1
        for i in range(n):
            a, c = start + i, start + (i + 1) % n
            # (not at the glyph's outer edges: a run there is a tip or a terminal — a brace's beak, a bracket's arm ends)
            if on[a] and on[c] and abs(pts[a][0] - pts[c][0]) < 2 and abs(pts[a][1] - pts[c][1]) > 30 \
                    and b.xMin + 3 < pts[a][0] < b.xMax - 3:
                lo, hi = sorted((pts[a][1], pts[c][1]))
                runs.append((lo, hi))
        start = e + 1
    # the stretchable intervals: where some run covers the height, except an arm at either end (a bracket's
    # arms keep their thickness; a ceiling's stem end has none)
    levels = sorted({round(p[1]) for p, f in zip(pts, on) if f})
    near = 0.3 * (by1 - by0)
    cap_lo = levels[1] if len(levels) > 2 and levels[1] - by0 < near else by0
    cap_hi = levels[-2] if len(levels) > 2 and by1 - levels[-2] < near else by1
    cuts = sorted({by0, by1, cap_lo, cap_hi} | {v for r in runs for v in r if cap_lo <= v <= cap_hi})
    segs = []
    for lo, hi in zip(cuts, cuts[1:]):
        mid = (lo + hi) / 2
        stretch = cap_lo <= lo and hi <= cap_hi and any(r[0] <= mid <= r[1] for r in runs)
        segs.append([lo, hi, stretch])
    kept = sum((hi - lo) for lo, hi, s in segs if not s)
    stretchable = sum((hi - lo) for lo, hi, s in segs if s)
    k = ((y1 - y0) - kept * gy) / stretchable if stretchable else 0
    if k < 1:   # (too short to keep the parts whole: everything grows alike)
        gx = gy = k = sy
        brace = True
        for sg in segs:
            sg[2] = False
    pos, mp = by0, []
    for lo, hi, s in segs:
        f = k if s else gy
        mp.append((lo, hi, pos, f, s))
        pos += (hi - lo) * f

    def seg_of(y):
        # (a point on a boundary belongs to the part that is kept: a bracket's arm, not its stem)
        hits = [m for m in mp if m[0] - 0.01 <= y <= m[1] + 0.01]
        if not hits:
            return mp[0] if y < by0 else mp[-1]
        return next((m for m in hits if not m[4]), hits[0])

    # the arms' (stem's) centre line and thickness
    gs = font.getGlyphSet()
    pen = _Flat(gs)
    gs[base].draw(pen)
    longest = max((m for m in mp if m[4]), key=lambda m: m[1] - m[0], default=None)
    ym = (longest[0] + longest[1]) / 2 if longest else (by0 + by1) / 2
    xs = _crossings(pen.polys, ym)
    xa, stem = ((xs[0] + xs[-1]) / 2, xs[-1] - xs[0]) if len(xs) >= 2 else ((b.xMin + b.xMax) / 2, 0.1 * (b.xMax - b.xMin))

    scaled, stretched = [], []
    for x, y in pts:
        lo, hi, p0, f, s = seg_of(y)
        stretched.append(s)
        scaled.append((xa + (x - xa) * (tg if s else gx), p0 + (y - lo) * f))
    # what grew by gx: back to the stem's thickness (times tg); a bracket's arms only lengthwise
    d = (gx - tg) * stem / 2
    out = _offset(scaled, ends, lambda i: (0, False) if stretched[i] else (d, not brace))
    # exactly y0..y1 (the curls' offset leaves a few units)
    ys = [y for _, y in out]
    lo_, hi_ = min(ys), max(ys)
    out = [(x, y0 + (y - lo_) * (y1 - y0) / (hi_ - lo_)) for x, y in out]
    _write(font, name, out, ends, on, base)


KIND = {'(': 'paren', ')': 'paren', '⟨': 'angle', '⟩': 'angle', '⟪': 'angle', '⟫': 'angle',
        '{': 'brace', '}': 'brace', '[': 'bracket', ']': 'bracket', '⌈': 'bracket', '⌉': 'bracket',
        '⌊': 'bracket', '⌋': 'bracket'}


def redraw(font):
    """every vertical size variant of the delimiters above drawn again from its base glyph; returns their names.
    (Not in a slanted font: its delimiters lean, and an assembly of leaning pieces cannot stack; formulas
    take the upright font's anyway)"""
    if font['post'].italicAngle:
        return []
    cmap = font.getBestCmap()
    mv = font['MATH'].table.MathVariants
    cov = mv.VertGlyphCoverage.glyphs
    done = []
    for ch, kind in KIND.items():
        base = cmap.get(ord(ch))
        if base not in cov or font['glyf'][base].isComposite():
            continue
        con = mv.VertGlyphConstruction[cov.index(base)]
        for v in con.MathGlyphVariantRecord:
            name = v.VariantGlyph
            if name == base or font['glyf'][name].isComposite():
                continue
            g = font['glyf'][name]
            g.recalcBounds(font['glyf'])
            if kind in WIDEN:
                stroke_scaled(font, base, name, g.yMin, g.yMax, WIDEN[kind])
            else:
                zones_kept(font, base, name, g.yMin, g.yMax, kind)
            done.append(name)
        if kind == 'angle':
            con.MathGlyphVariantRecord = [v for v in con.MathGlyphVariantRecord if v.AdvanceMeasurement <= ANGLE_MAX]
            con.VariantCount = len(con.MathGlyphVariantRecord)
    return done


# ------------------------------------------------------------------ assemblies cut from the largest variant

def _pieces(contour):
    """a contour [(x, y, on)] as line (a, b) and quadratic (a, c, b) pieces, implied on-curve points explicit"""
    n = len(contour)
    first = next(i for i, p in enumerate(contour) if p[2])
    c = contour[first:] + contour[:first] + [contour[first]]
    out, cur, pend = [], c[0][:2], None
    for p in c[1:]:
        if p[2]:
            out.append((cur, pend, p[:2]) if pend else (cur, p[:2]))
            cur, pend = p[:2], None
        elif pend is None:
            pend = p[:2]
        else:
            mid = ((pend[0] + p[0]) / 2, (pend[1] + p[1]) / 2)
            out.append((cur, pend, mid))
            cur, pend = mid, p[:2]
    return out


def _at(pc, t):
    if len(pc) == 2:
        (ax, ay), (bx, by) = pc
        return (ax + t * (bx - ax), ay + t * (by - ay))
    (ax, ay), (cx, cy), (bx, by) = pc
    m = 1 - t
    return (m * m * ax + 2 * m * t * cx + t * t * bx, m * m * ay + 2 * m * t * cy + t * t * by)


def _split(pc, t):
    if len(pc) == 2:
        p = _at(pc, t)
        return (pc[0], p), (p, pc[1])
    a, c, b = pc
    ac = (a[0] + t * (c[0] - a[0]), a[1] + t * (c[1] - a[1]))
    cb = (c[0] + t * (b[0] - c[0]), c[1] + t * (b[1] - c[1]))
    p = _at(pc, t)
    return (a, ac, p), (p, cb, b)


def _roots(pc, y):
    """parameters 0 < t < 1 where the piece crosses height y"""
    if len(pc) == 2:
        (_, ay), (_, by) = pc
        return [(y - ay) / (by - ay)] if (ay - y) * (by - y) < 0 else []
    (_, a), (_, c), (_, b) = pc
    A, B, C = a - 2 * c + b, 2 * (c - a), a - y
    if abs(A) < 1e-9:
        ts = [-C / B] if abs(B) > 1e-9 else []
    else:
        d = B * B - 4 * A * C
        ts = [] if d < 0 else [(-B - math.sqrt(d)) / (2 * A), (-B + math.sqrt(d)) / (2 * A)]
    return sorted(t for t in ts if 1e-6 < t < 1 - 1e-6)


def _clip(pieces, y, above):
    """the pieces of a closed outline on one side of height y, closed along y where it was cut"""
    inside = (lambda p: p[1] >= y - 1e-6) if above else (lambda p: p[1] <= y + 1e-6)
    split = []
    for pc in pieces:
        ts = _roots(pc, y)
        rest = pc
        done = 0.0
        for t in ts:
            a, rest = _split(rest, (t - done) / (1 - done))
            split.append(a)
            done = t
        split.append(rest)
    out, open_at = [], None
    for pc in split:
        mid = _at(pc, 0.5)
        if inside(mid):
            if open_at is not None:
                out.append((open_at, pc[0]))
                open_at = None
            out.append(pc)
        elif open_at is None and out:
            open_at = pc[0]
    if out and out[-1][-1] != out[0][0]:
        out.append((out[-1][-1], out[0][0]))
    return out


def _points(pieces, dy):
    pts, on = [], []
    for pc in pieces:
        pts.append((pc[0][0], pc[0][1] - dy)); on.append(1)
        if len(pc) == 3:
            pts.append((pc[1][0], pc[1][1] - dy)); on.append(0)
    return pts, on


def _part(font, name, pieces, ylo, adv):
    from fontTools.ttLib.tables._g_l_y_f import Glyph, GlyphCoordinates
    import array
    pts, on = _points(pieces, ylo)
    g = Glyph()
    g.numberOfContours = 1
    g.coordinates = GlyphCoordinates([(round(x), round(y)) for x, y in pts])
    g.flags = array.array('B', on)
    g.endPtsOfContours = [len(pts) - 1]
    g.program = None
    from fontTools.ttLib.tables import ttProgram
    g.program = ttProgram.Program(); g.program.fromBytecode(b'')
    font['glyf'][name] = g
    g.recalcBounds(font['glyf'])
    font['hmtx'][name] = (adv, g.xMin)


def _rect(font, name, x0, x1, h, adv):
    from fontTools.ttLib.tables._g_l_y_f import Glyph, GlyphCoordinates
    from fontTools.ttLib.tables import ttProgram
    import array
    g = Glyph()
    g.numberOfContours = 1
    g.coordinates = GlyphCoordinates([(round(x0), 0), (round(x0), h), (round(x1), h), (round(x1), 0)])
    g.flags = array.array('B', [1, 1, 1, 1])
    g.endPtsOfContours = [3]
    g.program = ttProgram.Program(); g.program.fromBytecode(b'')
    font['glyf'][name] = g
    g.recalcBounds(font['glyf'])
    font['hmtx'][name] = (adv, g.xMin)


EXT = 600   # an extender's height


def name_free(font, name):
    """a new empty glyph of that name at the end of the glyph order (its outline and metrics set after)"""
    from fontTools.ttLib.tables._g_l_y_f import Glyph
    order = font.getGlyphOrder()
    if name not in order:
        font.setGlyphOrder(order + [name])
        font['glyf'].glyphOrder = font.getGlyphOrder()
        g = Glyph(); g.numberOfContours = 0
        font['glyf'][name] = g
        font['hmtx'][name] = (0, 0)
    return name


def assemble(font):
    """each delimiter's assembly cut from its largest variant (as redraw left it); returns the part names"""
    if font['post'].italicAngle:
        return []
    cmap = font.getBestCmap()
    mv = font['MATH'].table.MathVariants
    cov = mv.VertGlyphCoverage.glyphs
    done = []
    shared_ext = set()
    for ch, kind in KIND.items():
        base = cmap.get(ord(ch))
        if base not in cov:
            continue
        con = mv.VertGlyphConstruction[cov.index(base)]
        ga = con.GlyphAssembly
        if not ga:
            continue
        largest = con.MathGlyphVariantRecord[-1].VariantGlyph
        g = font['glyf'][largest]
        if g.isComposite() or g.numberOfContours != 1:
            continue
        g.recalcBounds(font['glyf'])
        coords, ends, flags = g.getCoordinates(font['glyf'])
        contour = [(x, y, bool(f & 1)) for (x, y), f in zip(coords, flags)]
        pcs = _pieces(contour)
        adv = font['hmtx'][largest][0]
        y0, y1 = g.yMin, g.yMax
        parts = ga.PartRecords
        fixed = [p for p in parts if not p.PartFlags]
        exts = [p for p in parts if p.PartFlags]
        if kind == 'brace':
            # the arms' middles: where the outline is a straight vertical run, below and above the beak
            gs = font.getGlyphSet(); pen = _Flat(gs); gs[largest].draw(pen)
            mid = (y0 + y1) / 2
            # an arm: heights where both sides of the stroke stay at one x for long
            def width_at(y):
                xs = _crossings(pen.polys, y)
                return (xs[0], xs[-1]) if len(xs) >= 2 else None
            lo_arm = [y for y in range(int(y0) + 1, int(mid)) if width_at(y) and abs(width_at(y)[0] - width_at(y + 40 if y + 40 < mid else y)[0]) < 1]
            hi_arm = [y for y in range(int(mid) + 1, int(y1)) if width_at(y) and abs(width_at(y)[0] - width_at(y - 40 if y - 40 > mid else y)[0]) < 1]
            if not lo_arm or not hi_arm or len(fixed) != 3 or not exts:
                continue
            m1 = (lo_arm[0] + lo_arm[-1]) / 2
            m2 = (hi_arm[0] + hi_arm[-1]) / 2
            bottom = _clip(pcs, m1, above=False)
            middle = _clip(_clip(pcs, m1, above=True), m2, above=False)
            top = _clip(pcs, m2, above=True)
            xL, xR = width_at(m1)
            # (Noto's two braces share their extender ⎪; each gets its own here, at its own arm)
            ext = exts[0].glyph
            if ext in shared_ext:
                ext = name_free(font, base + '.ext')
                for e in exts:
                    e.glyph = ext
            shared_ext.add(ext)
            _part(font, fixed[0].glyph, bottom, y0, adv)
            _part(font, fixed[1].glyph, middle, m1, adv)
            _part(font, fixed[2].glyph, top, m2, adv)
            _rect(font, ext, xL, xR, EXT, adv)
            fixed[0].FullAdvance, fixed[0].StartConnectorLength, fixed[0].EndConnectorLength = round(m1 - y0), 0, round(m1 - lo_arm[0])
            fixed[1].FullAdvance = round(m2 - m1)
            fixed[1].StartConnectorLength, fixed[1].EndConnectorLength = round(lo_arm[-1] - m1), round(m2 - hi_arm[0])
            fixed[2].FullAdvance, fixed[2].StartConnectorLength, fixed[2].EndConnectorLength = round(y1 - m2), round(hi_arm[-1] - m2), 0
            for e in exts:
                e.FullAdvance = e.StartConnectorLength = e.EndConnectorLength = EXT
            done += [fixed[0].glyph, fixed[1].glyph, fixed[2].glyph, ext]
        else:
            if len(fixed) != 2 or not exts:
                continue
            c = (y0 + y1) / 2
            gs = font.getGlyphSet(); pen = _Flat(gs); gs[largest].draw(pen)
            xs = _crossings(pen.polys, c)
            if len(xs) < 2:
                continue
            bottom = _clip(pcs, c, above=False)
            top = _clip(pcs, c, above=True)
            _part(font, fixed[0].glyph, bottom, y0, adv)
            _part(font, fixed[1].glyph, top, c, adv)
            _rect(font, exts[0].glyph, xs[0], xs[-1], EXT, adv)
            # (a parenthesis is near upright for a little way about its middle; a bracket's stem all along)
            conn = 100 if kind in ('paren', 'angle') else round((c - y0) * 0.6)
            fixed[0].FullAdvance, fixed[0].StartConnectorLength, fixed[0].EndConnectorLength = round(c - y0), 0, conn
            fixed[1].FullAdvance, fixed[1].StartConnectorLength, fixed[1].EndConnectorLength = round(y1 - c), conn, 0
            for e in exts:
                e.FullAdvance = e.StartConnectorLength = e.EndConnectorLength = EXT
            done += [fixed[0].glyph, fixed[1].glyph, exts[0].glyph]
    return done


if __name__ == '__main__':
    import sys
    from fontTools.ttLib import TTFont
    f = TTFont(sys.argv[1])
    print(len(redraw(f)), 'variants drawn again,', len(assemble(f)), 'assembly parts cut')
    f.save(sys.argv[2])

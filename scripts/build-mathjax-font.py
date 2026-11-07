#!/usr/bin/env python3
"""
An OpenType math font → a MathJax 4 CHTML font package, laid out like MathJax's own font packages
(@mathjax/mathjax-<font>-font: common.js, chtml.js, chtml/<variant>.js, chtml/delimiters.js,
chtml/dynamic/<block>.js, chtml/woff2/*.woff2), so editor/lyxmath/mathfonts.ts loads it like them.
MathJax's own font tools (@mathjax/font-tools, github mathjax/MathJax-fonts) are not public; this
does what their font definitions (node_modules/@mathjax/mathjax-fira-font/def/mathjax-fira.ts)
describe, from the font's own data:

  - characters: [height, depth, width] from the glyph's ink box and advance; the italic correction
    from the MATH table (else the ink sticking out past the advance, as MathJax's fonts have it);
    the skew from the MATH top-accent attachment (minus the part of the italic correction MathJax
    adds itself); dx for combining accents (their centre)
  - variants: the math font for normal and the Unicode math alphabets (bold, italic, script,
    fraktur, double-struck, sans-serif, monospace — MathJax reaches them by code point); the text
    faces (bold, italic, bold italic) for \\mathbf, \\mathit etc. of what is not a letter or digit;
    \\mathcal = the script capitals with the calligraphic feature (ss01), \\mathscr = the default
    script; primes = their ssty1 forms (-tex-variant)
  - delimiters: the MATH table's size variants (normal, -smallop, -largeop, -size3, …) and glyph
    assemblies (parts in -lf-tp, -ext, -rt-bt, -mid at the delimiter's code point); display forms of
    large operators in -largeop, an integral's box its advance less its italic correction (the
    correction places the limits); arrows the MATH table has no assembly for are cut at the middle
    of their shaft (the ends) with an extender from the shaft's cross-section; rules (=, −, ―, _, ¯,
    |, ‖ …) repeat themselves
  - parameters: MathJax's TeX font parameters from the MATH constants (axis height, fraction and
    script shifts, limit gaps, rule thicknesses, space after scripts; the accent gap from
    AccentBaseHeight). MathJax's CHTML style sheet has some of TeX's Computer Modern values built
    in (fraction struts, the table axis, the radical rule, script space); the font's style sheet
    sets them from these parameters. The class carries all MATH constants (mathConstants), e.g. the
    script sizes MathJax does not take from a font (it scales scripts by 71 % / 50 %)
  - woff2 files: one per font letter (static variants and dynamic blocks), subset to the glyphs
    that letter needs, each glyph at the code point the data names (built glyphs too); the same
    input gives the same files

Inputs: static TrueType or CFF fonts with a MATH table in the math font (instantiate a variable
font first, e.g. `fonttools varLib.instancer Font[wght].ttf wght=700`). Check the result with
scratch/mathfont-compare.mts (MathJax against LuaLaTeX + unicode-math, overlaid at the baseline).

Usage (fontTools and brotli on PYTHONPATH):
  PYTHONPATH=/mnt/HC_Volume_107166861/jan/pylib python3 scripts/build-mathjax-font.py \\
    --id anodyne --prefix ANOD --name Anodyne \\
    --math fonts/anodyne/tex/Anodyne-Regular.ttf --bold fonts/anodyne/tex/Anodyne-Bold.ttf \\
    --italic fonts/anodyne/tex/Anodyne-Italic.ttf --bold-italic fonts/anodyne/tex/Anodyne-BoldItalic.ttf
writes packages/client/src/fonts/@mathjax/mathjax-<id>-font/ (the path has MathJax's package name so
that the build puts its files into assets/mathjax/<id>/ like MathJax's fonts; see vite.config.ts).
Register the font in editor/lyxmath/mathfonts.ts (SOURCES) and fonts/catalog.ts (MATH_FONTS); editor/lyxmath/mathjax.ts
sizes its scripts from the MATH constants the font class carries.
"""
import argparse
import copy
import json
import math
import os
import re
import shutil
import sys
from fontTools.ttLib import TTFont
from fontTools.ttLib.tables._g_l_y_f import Glyph, GlyphComponent
from fontTools.pens.basePen import BasePen
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.fontBuilder import FontBuilder
from fontTools.ttLib.tables import ttProgram

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ---------------------------------------------------------------------------------------- ranges

def R(*items):
    """code points from ints and (lo, hi) pairs"""
    out = set()
    for it in items:
        if isinstance(it, tuple):
            out.update(range(it[0], it[1] + 1))
        else:
            out.add(it)
    return out

ALPHA_UC = R((0x41, 0x5A))
ALPHA = R((0x41, 0x5A), (0x61, 0x7A))
DIGITS = R((0x30, 0x39))
GREEK_BASIC = R((0x391, 0x3A9), (0x3B1, 0x3C9), 0x3D1, 0x3D2, 0x3D5, 0x3D6, 0x3DC, 0x3DD, 0x3F0, 0x3F1, 0x3F4, 0x3F5) - {0x3A2}

# what the normal variant takes from the math font (MathJax's fonts: everything up to U+2FFF, the
# math alphabets): Latin, Greek, Cyrillic, IPA, punctuation, symbols and the math blocks
INCLUDE = R((0x20, 0x7E), (0xA0, 0x24F), (0x250, 0x2FF), (0x300, 0x36F), (0x370, 0x3FF), (0x400, 0x52F),
            (0x1D00, 0x1DBF), (0x1DC0, 0x1DFF), (0x1E00, 0x1EFF), (0x1F00, 0x1FFF), (0x2000, 0x200B),
            (0x2010, 0x2027), (0x202F, 0x205F), (0x2060, 0x2064), (0x2070, 0x209F), (0x20A0, 0x20C1),
            (0x20D0, 0x20F0), (0x2100, 0x218F), (0x2190, 0x23FF), (0x2500, 0x27FF), (0x2900, 0x2BFF),
            (0x2C60, 0x2C7F), (0xA720, 0xA7FF), (0xAB30, 0xAB6F), (0xFB00, 0xFB04), (0x1D400, 0x1D7FF))

# MathJax's spaces (the font tools' `spaces`): fixed widths, whatever the font has
SPACES = {0x2000: .5, 0x2001: 1, 0x2002: .5, 0x2003: 1, 0x2004: .3333, 0x2005: .25, 0x2006: .1667,
          0x2009: .2, 0x200A: .1, 0x200B: 0, 0x202F: .2, 0x205F: .222, 0x2060: 0, 0x2061: 0, 0x2062: 0,
          0x2063: 0, 0x2064: 0}

# large operators (MathJax's operator dictionary: prefix OP and INTEGRAL): text size = the base
# glyph, display size (-largeop) = the first variant at least DisplayOperatorMinHeight tall
LARGEOPS = R(0x220F, 0x2210, 0x2211, (0x222B, 0x2233), (0x22C0, 0x22C3), (0x2A00, 0x2A1E), 0x2AFC, 0x2AFF, 0x2140)

# the script capitals (A–Z in the script alphabet, with the letterlike holes)
SCRIPT_UC = [0x1D49C, 0x212C, 0x1D49E, 0x1D49F, 0x2130, 0x2131, 0x1D4A2, 0x210B, 0x2110, 0x1D4A5, 0x1D4A6,
             0x2112, 0x2133, 0x1D4A9, 0x1D4AA, 0x1D4AB, 0x1D4AC, 0x211B, 0x1D4AE, 0x1D4AF, 0x1D4B0,
             0x1D4B1, 0x1D4B2, 0x1D4B3, 0x1D4B4, 0x1D4B5]
BOLD_SCRIPT_UC = list(range(0x1D4D0, 0x1D4EA))

# blocks of character data loaded when a formula needs them (MathJax's `ranges`); the rest is in
# the font's module. Each: name → {font letter: (variant, code points)}
LATIN = R((0xC0, 0x24F), (0x1E00, 0x1EFF), (0x2C60, 0x2C7F), (0xA720, 0xA7FF), (0xAB30, 0xAB6F)) - R(0xD7, 0xF7, 0x131, 0x237)
GREEK = R((0x370, 0x3FF), (0x1F00, 0x1FFF)) - GREEK_BASIC
CYRILLIC = R((0x400, 0x52F))
PHONETICS = R((0x250, 0x2AF), (0x1D00, 0x1DBF))
DOUBLESTRUCK = R(0x2102, 0x210D, 0x2115, 0x2119, 0x211A, 0x211D, 0x2124, (0x213C, 0x2140), (0x2145, 0x2149),
                 (0x1D538, 0x1D56B), (0x1D7D8, 0x1D7E1))
FRAKTUR = R(0x210C, 0x2111, 0x211C, 0x2128, 0x212D, (0x1D504, 0x1D537), (0x1D56C, 0x1D59F))
SCRIPT = R(0x210A, 0x210B, 0x2110, 0x2112, 0x2113, 0x211B, 0x212C, (0x212F, 0x2131), 0x2133, 0x2134, (0x1D49C, 0x1D503))
SANSSERIF = R((0x1D5A0, 0x1D66F), (0x1D756, 0x1D7C9), (0x1D7E2, 0x1D7F5))
MONOSPACE = R((0x1D670, 0x1D6A3), (0x1D7F6, 0x1D7FF))
SYMBOLS = (R((0xA1, 0xBF), (0x2010, 0x205E), (0x2070, 0x209F), (0x20A0, 0x20C1), (0x2100, 0x214F), (0x2150, 0x218F),
             (0x2300, 0x23FF), (0xFB00, 0xFB04))
           - R(0xA3, 0xA5, 0xA7, 0xA8, 0xAC, 0xAF, 0xB0, 0xB1, 0xB4, 0xB5, 0xB6, 0xB7, (0x2013, 0x2016), (0x2018, 0x201D),
               (0x2020, 0x2022), 0x2026, (0x2032, 0x2037), 0x203E, 0x2044, 0x210E, 0x210F, 0x2118, 0x2127, 0x212B,
               0x2132, (0x2135, 0x2138), 0x2141, (0x2308, 0x230B), (0x231C, 0x231F), 0x2322, 0x2323, 0x2329, 0x232A,
               (0x239B, 0x23B7), 0x23D0, (0x23DC, 0x23E1))
           - DOUBLESTRUCK - FRAKTUR - SCRIPT)
ARROWS = (R((0x219C, 0x21FF), (0x27F0, 0x27F4), (0x27FD, 0x27FF), (0x2900, 0x297F), (0x2B00, 0x2B11), (0x2B30, 0x2B4C))
          - R(0x219E, 0x21A0, 0x21A2, 0x21A3, 0x21A4, 0x21A6, (0x21A9, 0x21AE), 0x21B0, 0x21B1, 0x21B6, 0x21B7, 0x21BA,
              0x21BB, (0x21BC, 0x21D5), 0x21DA, 0x21DB, 0x21DD, 0x21E0, 0x21E2, 0x21F5, 0x27FD, 0x27FE, 0x27FF))
ACCENTS = (R((0x2B0, 0x2FF), (0x30D, 0x36F), (0x1DC0, 0x1DFF), (0x20D0, 0x20F0), 0xB8)
           - R(0x2B9, 0x2C6, 0x2C7, 0x2C9, 0x2CA, 0x2CB, 0x2D8, 0x2D9, 0x2DA, 0x2DC, 0x2DD, 0x332, 0x338,
               0x20D0, 0x20D1, 0x20D6, 0x20D7, 0x20DB, 0x20DC, 0x20E1, (0x20EC, 0x20EF)))
SHAPES = (R((0x2500, 0x25FF), (0x2600, 0x27BF), (0x2B12, 0x2B2F), (0x2B4D, 0x2BFF))
          - R(0x25A0, 0x25A1, 0x25AA, 0x25AB, 0x25AD, 0x25AE, (0x25B2, 0x25C3), 0x25C6, 0x25C7, 0x25CA, 0x25CB,
              0x25CF, 0x25EF, 0x25FB, 0x25FC, 0x2605, 0x2606, (0x2660, 0x2667), (0x266D, 0x266F), 0x2713, 0x2720,
              0x2758, 0x2500))
MATH_OTHER = R((0x2190, 0x21FF), (0x2200, 0x22FF), (0x25A0, 0x25FF), (0x2980, 0x2AFF), (0x27C0, 0x27FF))

BLOCKS = [
    ('latin', {'LR': ('normal', LATIN)}),
    ('latin-b', {'LB': ('bold', LATIN)}),
    ('latin-i', {'LI': ('italic', LATIN)}),
    ('latin-bi', {'LIB': ('bold-italic', LATIN)}),
    ('greek', {'GR': ('normal', GREEK), 'GRB': ('bold', GREEK), 'GRI': ('italic', GREEK), 'GRBI': ('bold-italic', GREEK)}),
    ('cyrillic', {'CY': ('normal', CYRILLIC), 'CYB': ('bold', CYRILLIC), 'CYI': ('italic', CYRILLIC), 'CYBI': ('bold-italic', CYRILLIC)}),
    ('phonetics', {'PH': ('normal', PHONETICS), 'PHB': ('bold', PHONETICS), 'PHI': ('italic', PHONETICS), 'PHBI': ('bold-italic', PHONETICS)}),
    ('double-struck', {'DS': ('normal', DOUBLESTRUCK)}),
    ('fraktur', {'F': ('normal', FRAKTUR)}),
    ('script', {'S': ('normal', SCRIPT)}),
    ('sans-serif', {'SS': ('normal', SANSSERIF)}),
    ('monospace', {'MO': ('normal', MONOSPACE)}),
    ('calligraphic', {'C': ('-tex-calligraphic', ALPHA_UC), 'CB': ('-tex-bold-calligraphic', ALPHA_UC)}),
    ('symbols', {'SY': ('normal', SYMBOLS)}),
    ('symbols-other', {'SYB': ('bold', SYMBOLS), 'SYI': ('italic', SYMBOLS), 'SYBI': ('bold-italic', SYMBOLS)}),
    ('arrows', {'AR': ('normal', ARROWS)}),
    ('accents', {'': ('normal', ACCENTS)}),
    ('accents-other', {'': [('bold', ACCENTS), ('italic', ACCENTS), ('bold-italic', ACCENTS)]}),
    ('shapes', {'SH': ('normal', SHAPES)}),
    ('math-other', {'MXB': ('bold', MATH_OTHER), 'MXI': ('italic', MATH_OTHER), 'MXBI': ('bold-italic', MATH_OTHER)}),
]

PART_VARIANTS = ['-lf-tp', '-rt-bt', '-ext', '-mid']
STRETCH_VARIANTS = ['normal', '-ext', '-lf-tp', '-rt-bt', '-mid']

# combining characters that overlay their base (MathJax's fonts give them a skew, not a dx)
OVERLAYS = R((0x334, 0x338), 0x20D2, 0x20D3, (0x20D8, 0x20DA), 0x20E5, 0x20E6, 0x20EA, 0x20EB)
COMBINING = R((0x300, 0x36F), (0x1AB0, 0x1AFF), (0x1DC0, 0x1DFF), (0x20D0, 0x20FF))

# stretchy characters the MATH table may lack (MathJax's fonts' `add`): rules that repeat
# themselves, and arrows built from their own glyph. `sizes`: the normal size counts as one.
LINES_H = {0x3D: True, 0x5F: True, 0xAF: True, 0x2013: False, 0x2014: False, 0x2015: False, 0x2212: False,
           0x2261: False, 0x2263: False, 0x23AF: False, 0x2500: False}
LINES_V = [0x2223, 0x2225, 0x23AA, 0x2016, 0x7C]
ARROWS_H = R(0x2190, 0x2192, 0x2194, 0x219E, 0x21A0, 0x21A2, 0x21A3, 0x21A4, 0x21A6, 0x21A9, 0x21AA,
             (0x21BC, 0x21BD), (0x21C0, 0x21C1), (0x21C4, 0x21C4), 0x21C6, 0x21CB, 0x21CC, 0x21D0, 0x21D2, 0x21D4,
             0x21DA, 0x21DB, (0x27F5, 0x27FE), 0x2906, 0x2907, 0x294A, 0x294B, 0x294E, 0x2950, (0x2952, 0x2953),
             (0x2956, 0x2957), (0x295A, 0x295B), (0x295E, 0x295F), 0x2B04)
ARROWS_V = R(0x2191, 0x2193, 0x2195, 0x21A5, 0x21A7, (0x21BE, 0x21BF), (0x21C2, 0x21C3), 0x21C5, 0x21D1, 0x21D3,
             0x21D5, 0x21F5, 0x294C, 0x294D, 0x294F, 0x2951, (0x2954, 0x2955), (0x2958, 0x2959), (0x295C, 0x295D),
             (0x2960, 0x2961), 0x2B0D)
# MathJax's fonts' aliases: a stretchy character drawn with another one's data (only where the font
# has no construction of its own)
ALIASES = {0x2D: 0x2212, 0x5E: 0x302, 0x7E: 0x303, 0x2C6: 0x302, 0x2C9: 0xAF, 0x2DC: 0x303, 0x203E: 0xAF,
           0x20D7: 0x2192, 0x2215: 0x2F, 0x2312: 0x23DC, 0x2322: 0x23DC, 0x2323: 0x23DD, 0x2329: 0x27E8,
           0x232A: 0x27E9, 0x27F5: 0x2190, 0x27F6: 0x2192, 0x27F7: 0x2194, 0x27F8: 0x21D0, 0x27F9: 0x21D2,
           0x27FA: 0x21D4, 0x3008: 0x27E8, 0x3009: 0x27E9, 0xFE37: 0x23DE, 0xFE38: 0x23DF, 0x23D0: 0x2223,
           0x2758: 0x2223, 0x2017: 0x2015}

ACCENT_MAP = {0x5E: 0x2C6, 0x7E: 0x2DC, 0x300: 0x2CB, 0x301: 0x2CA, 0x302: 0x2C6, 0x303: 0x2DC, 0x304: 0x2C9,
              0x306: 0x2D8, 0x307: 0x2D9, 0x308: 0xA8, 0x30A: 0x2DA, 0x30C: 0x2C7, 0x2192: 0x20D7}

# ------------------------------------------------------------------------------------ helpers

def warn(*a):
    print('warning:', *a, file=sys.stderr)


def num(x):
    """a number as MathJax's generated data writes it (3 decimals, no leading zero)"""
    x = round(x + 0.0, 3)
    if x == 0:
        return '0'
    s = ('%.3f' % x).rstrip('0').rstrip('.')
    if s.startswith('0.'):
        s = s[1:]
    elif s.startswith('-0.'):
        s = '-' + s[2:]
    return s


def hexcp(c):
    return '0x%X' % c


class FlattenPen(BasePen):
    """an outline as polygons (curves as short lines), for cutting glyphs"""
    def __init__(self, glyphSet):
        super().__init__(glyphSet)
        self.contours = []
        self.cur = None

    def _moveTo(self, p):
        self.cur = [p]
        self.contours.append(self.cur)

    def _lineTo(self, p):
        self.cur.append(p)

    def _curveToOne(self, p1, p2, p3):
        p0 = self._getCurrentPoint()
        n = max(2, int(math.ceil((math.dist(p0, p1) + math.dist(p1, p2) + math.dist(p2, p3)) / 6)))
        for i in range(1, n + 1):
            t = i / n
            mt = 1 - t
            self.cur.append((mt ** 3 * p0[0] + 3 * mt * mt * t * p1[0] + 3 * mt * t * t * p2[0] + t ** 3 * p3[0],
                             mt ** 3 * p0[1] + 3 * mt * mt * t * p1[1] + 3 * mt * t * t * p2[1] + t ** 3 * p3[1]))

    def _qCurveToOne(self, p1, p2):
        p0 = self._getCurrentPoint()
        n = max(2, int(math.ceil((math.dist(p0, p1) + math.dist(p1, p2)) / 6)))
        for i in range(1, n + 1):
            t = i / n
            mt = 1 - t
            self.cur.append((mt * mt * p0[0] + 2 * mt * t * p1[0] + t * t * p2[0],
                             mt * mt * p0[1] + 2 * mt * t * p1[1] + t * t * p2[1]))

    def _closePath(self):
        if self.cur and len(self.cur) > 1 and math.dist(self.cur[0], self.cur[-1]) < 1e-6:
            self.cur.pop()
        self.cur = None

    _endPath = _closePath


def cross_section(contours, axis, pos):
    """the ink along the line axis=pos (axis 0: the vertical line x=pos): sorted [lo, hi] intervals"""
    o = 1 - axis
    hits = []
    for c in contours:
        n = len(c)
        for i in range(n):
            p, q = c[i], c[(i + 1) % n]
            a, b = p[axis], q[axis]
            if a == b:
                continue
            if (a <= pos < b) or (b <= pos < a):
                t = (pos - a) / (b - a)
                hits.append((p[o] + t * (q[o] - p[o]), 1 if b > a else -1))
    hits.sort()
    out = []
    w = 0
    start = None
    for v, d in hits:
        before = w
        w += d
        if before == 0 and w != 0:
            start = v
        elif before != 0 and w == 0:
            if out and abs(out[-1][1] - start) < 0.5:
                out[-1][1] = v
            else:
                out.append([start, v])
    return out


def clip(contours, axis, lo=None, hi=None):
    """Sutherland–Hodgman: the polygons cut to lo ≤ coordinate ≤ hi along axis"""
    def cut(poly, inside, at):
        out = []
        n = len(poly)
        for i in range(n):
            p, q = poly[i - 1], poly[i]
            pi, qi = inside(p), inside(q)
            if qi:
                if not pi:
                    out.append(at(p, q))
                out.append(q)
            elif pi:
                out.append(at(p, q))
        return out

    def at_value(v):
        def at(p, q):
            t = (v - p[axis]) / (q[axis] - p[axis])
            r = [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]
            r[axis] = v
            return tuple(r)
        return at

    res = []
    for poly in contours:
        if lo is not None:
            poly = cut(poly, lambda p: p[axis] >= lo, at_value(lo))
        if hi is not None and len(poly) >= 3:
            poly = cut(poly, lambda p: p[axis] <= hi, at_value(hi))
        if len(poly) >= 3:
            res.append(poly)
    return res


def cut(contours, axis, lo=None, hi=None):
    """The outline cut to lo ≤ coordinate ≤ hi along axis, without the zero-width bridges clipping
    leaves along the cut where one contour crosses it several times (they show as hairlines): the
    pieces are joined again along the ink the cut line runs through."""
    res = contours
    if lo is not None:
        res = cut_side(res, axis, lo, True)
    if hi is not None:
        res = cut_side(res, axis, hi, False)
    return res


def cut_side(contours, axis, v, keep_greater):
    o = 1 - axis
    clipped = clip(contours, axis, lo=v) if keep_greater else clip(contours, axis, hi=v)
    on = lambda p: abs(p[axis] - v) < 1e-6
    closed, chains = [], []
    for poly in clipped:
        n = len(poly)
        line = [on(poly[i]) and on(poly[(i + 1) % n]) for i in range(n)]      # edge i → i+1 on the cut
        if not any(line):
            closed.append(poly)
            continue
        if all(line):
            continue
        # the runs of edges off the cut, each from the cut to the cut
        s = next(i for i in range(n) if line[i - 1] and not line[i])
        chain = None
        for k in range(n):
            i = (s + k) % n
            if not line[i]:
                if chain is None:
                    chain = [poly[i]]
                chain.append(poly[(i + 1) % n])
            elif chain is not None:
                chains.append(chain)
                chain = None
        if chain is not None:
            chains.append(chain)
    if not chains:
        return closed
    eps = 1e-3 if keep_greater else -1e-3
    ink = cross_section(contours, axis, v + eps)
    starts = {i: c[0][o] for i, c in enumerate(chains)}

    def near(y, ys):
        best = min(ys, key=lambda j: abs(ys[j] - y), default=None)
        return best if best is not None and abs(ys[best] - y) < 1.0 else None

    nxt = {}
    for i, c in enumerate(chains):
        y = c[-1][o]
        iv = next((iv for iv in ink if abs(iv[0] - y) < 1.0 or abs(iv[1] - y) < 1.0), None)
        if iv is None:
            return clipped
        other = iv[1] if abs(iv[0] - y) < 1.0 else iv[0]
        j = near(other, starts)
        if j is None:
            return clipped
        nxt[i] = j
    seen = set()
    for i in range(len(chains)):
        if i in seen:
            continue
        loop, j = [], i
        while j not in seen:
            seen.add(j)
            loop.extend(chains[j])
            j = nxt[j]
        closed.append(loop)
    return closed


def area(poly):
    return 0.5 * sum(poly[i - 1][0] * poly[i][1] - poly[i][0] * poly[i - 1][1] for i in range(len(poly)))


def outline_glyph(contours, dx=0, dy=0):
    pen = TTGlyphPen(None)
    for poly in contours:
        pts = []
        for x, y in poly:
            p = (int(round(x + dx)), int(round(y + dy)))
            if not pts or pts[-1] != p:
                pts.append(p)
        while len(pts) > 1 and pts[0] == pts[-1]:
            pts.pop()
        if len(pts) < 3 or abs(area(pts)) < 1:
            continue
        pen.moveTo(pts[0])
        for p in pts[1:]:
            pen.lineTo(p)
        pen.closePath()
    return pen.glyph()


def contour_bounds(contours):
    xs = [p[0] for c in contours for p in c]
    ys = [p[1] for c in contours for p in c]
    return (min(xs), min(ys), max(xs), max(ys)) if xs else None

# ------------------------------------------------------------------------------------ sources

class Src:
    """one input font"""
    def __init__(self, key, path):
        self.key = key
        self.path = path
        self.font = TTFont(path)
        self.upm = self.font['head'].unitsPerEm
        self.gs = self.font.getGlyphSet()
        self.cmap = self.font.getBestCmap()
        self.hm = self.font['hmtx'].metrics
        self._bounds = {}
        self._flat = {}
        m = self.font.get('MATH')
        self.math = m.table if m else None
        self.ic = {}
        self.ta = {}
        if self.math and self.math.MathGlyphInfo:
            gi = self.math.MathGlyphInfo
            if gi.MathItalicsCorrectionInfo:
                ii = gi.MathItalicsCorrectionInfo
                self.ic = {g: v.Value for g, v in zip(ii.Coverage.glyphs, ii.ItalicsCorrection)}
            if gi.MathTopAccentAttachment:
                ta = gi.MathTopAccentAttachment
                self.ta = {g: v.Value for g, v in zip(ta.TopAccentCoverage.glyphs, ta.TopAccentAttachment)}
        self.vert = {}
        self.horiz = {}
        if self.math and self.math.MathVariants:
            mv = self.math.MathVariants
            if mv.VertGlyphCoverage:
                self.vert = dict(zip(mv.VertGlyphCoverage.glyphs, mv.VertGlyphConstruction))
            if mv.HorizGlyphCoverage:
                self.horiz = dict(zip(mv.HorizGlyphCoverage.glyphs, mv.HorizGlyphConstruction))

    def bounds(self, g):
        if g not in self._bounds:
            p = BoundsPen(self.gs)
            self.gs[g].draw(p)
            self._bounds[g] = p.bounds
        return self._bounds[g]

    def flat(self, g):
        if g not in self._flat:
            p = FlattenPen(self.gs)
            self.gs[g].draw(p)
            self._flat[g] = [c for c in p.contours if len(c) >= 3]
        return self._flat[g]

    def adv(self, g):
        return self.hm[g][0]

    def constant(self, name):
        v = getattr(self.math.MathConstants, name)
        return getattr(v, 'Value', v)

    def feature_subst(self, tag):
        """glyph → [substitutes] of a GSUB feature (single and alternate substitutions)"""
        out = {}
        gsub = self.font.get('GSUB')
        if not gsub:
            return out
        t = gsub.table
        idx = sorted({i for fr in t.FeatureList.FeatureRecord if fr.FeatureTag == tag for i in fr.Feature.LookupListIndex})
        for i in idx:
            lk = t.LookupList.Lookup[i]
            for st in lk.SubTable:
                if lk.LookupType == 7:
                    st = st.ExtSubTable
                if hasattr(st, 'mapping'):
                    for a, b in st.mapping.items():
                        out.setdefault(a, [b])
                elif hasattr(st, 'alternates'):
                    for a, b in st.alternates.items():
                        out.setdefault(a, list(b))
        return out


class GlyphSpec:
    """a glyph of an output woff2: a source glyph (maybe moved, with another advance) or an outline"""
    def __init__(self, src, name=None, dx=0, dy=0, adv=None, outline=None, key=None):
        self.src = src
        self.name = name
        self.dx = dx
        self.dy = dy
        self._adv = adv
        self.outline = outline          # contours (for cut glyphs, rules)
        self.key = key or f'{src.key}:{name}:{dx}:{dy}:{adv}'

    @property
    def adv(self):
        if self._adv is not None:
            return self._adv
        return self.src.adv(self.name) if self.name else 0

    def bounds(self):
        if self.outline is not None:
            b = contour_bounds(self.outline)
        else:
            b = self.src.bounds(self.name) if self.name else None
        if not b:
            return None
        return (b[0] + self.dx, b[1] + self.dy, b[2] + self.dx, b[3] + self.dy)

    def plain(self):
        return self.outline is None and self.dx == 0 and self.dy == 0 and self._adv is None

# ------------------------------------------------------------------------------------ the font

class Builder:
    def __init__(self, args):
        self.args = args
        self.M = Src('M', args.math)
        self.srcs = {'M': self.M}
        for key, path in (('B', args.bold), ('I', args.italic), ('BI', args.bold_italic)):
            if path:
                self.srcs[key] = Src(key, path)
        for s in self.srcs.values():
            if s.upm != self.M.upm:
                sys.exit(f'{s.path}: units per em {s.upm}, the math font has {self.M.upm}')
        if not self.M.math:
            sys.exit(f'{args.math} has no MATH table')
        self.upm = self.M.upm
        self.prefix = args.prefix
        # variant → {code point: (GlyphSpec | None, data list)}
        self.chars = {}
        self.delims = {}
        self.letters = {}           # variant → its font letter
        self.size_variants = ['normal', '-smallop', '-largeop']
        self.notes = []

    # -- character data

    def em(self, v):
        return v / self.upm

    def data(self, spec, cp, ic_override=None):
        """[h, d, w, {ic, sk, dx}] of a glyph"""
        b = spec.bounds()
        adv = spec.adv
        h = self.em(b[3]) if b else 0
        d = -self.em(b[1]) if b else 0
        w = self.em(adv)
        opts = {}
        src, name = spec.src, spec.name
        if ic_override is not None:
            ic = ic_override
        else:
            ic = src.ic.get(name) if (name and spec.outline is None) else None
            if ic is None:
                ic = max(0, b[2] - adv) if b else 0
            ic = self.em(ic)
        if adv == 0 and b and cp in COMBINING:
            center = src.ta[name] + spec.dx if name in src.ta else (b[0] + b[2]) / 2
            if cp in OVERLAYS:
                opts['sk'] = self.em(center)
            else:
                opts['dx'] = -self.em(center)
            ic = 0
        if round(ic, 3) > 0:
            opts['ic'] = ic
        if adv > 0 and name and name in src.ta and spec.outline is None:
            sk = self.em(src.ta[name] + spec.dx - adv / 2) - 0.75 * opts.get('ic', 0)
            if abs(round(sk, 3)) >= 0.005:
                opts['sk'] = sk
        return [h, d, w, opts]

    def put(self, variant, cp, spec, data=None):
        self.chars.setdefault(variant, {})[cp] = (spec, data if data is not None else self.data(spec, cp))

    def has(self, variant, cp):
        return cp in self.chars.get(variant, {})

    def gspec(self, src, name, **kw):
        return GlyphSpec(src, name, **kw)

    # -- variants

    def build_variants(self):
        M = self.M
        for cp in sorted(INCLUDE):
            g = M.cmap.get(cp)
            if g and cp not in SPACES:
                self.put('normal', cp, self.gspec(M, g))
        for cp, w in SPACES.items():
            self.put('normal', cp, GlyphSpec(M, None, adv=round(w * self.upm), key=f'space:{cp}'),
                     [0, 0, w, {}])
        # MathJax's fonts give the minus the plus's height and depth (transferHD)
        if self.has('normal', 0x2212) and self.has('normal', 0x2B):
            spec, d = self.chars['normal'][0x2212]
            p = self.chars['normal'][0x2B][1]
            self.chars['normal'][0x2212] = (spec, [p[0], p[1]] + d[2:])

        letters_digits_greek = ALPHA | DIGITS | GREEK_BASIC | R(0x131, 0x237, 0x2202, 0x2207, 0x210A)
        alphabets = DOUBLESTRUCK | FRAKTUR | SCRIPT
        textsets = [('bold', 'B', R((0x20, 0x24FF), (0x25A0, 0x25FF)) - letters_digits_greek),
                    ('italic', 'I', R((0x20, 0x22EF)) - ALPHA - GREEK_BASIC - R(0x131, 0x237, 0x2202, 0x2207, 0x210A)),
                    ('bold-italic', 'BI', R((0x20, 0x22EF)) - ALPHA - GREEK_BASIC - R(0x131, 0x237, 0x2202, 0x2207, 0x210A))]
        for variant, key, cps in textsets:
            src = self.srcs.get(key)
            if not src:
                continue
            for cp in sorted(cps & INCLUDE):
                g = src.cmap.get(cp)
                if g and cp not in SPACES and cp not in alphabets:
                    self.put(variant, cp, self.gspec(src, g))
        # \mathsf / \boldsymbol digits in italic: MathJax would take the upright sans-serif ones
        for variant, key in (('sans-serif-italic', 'I'), ('sans-serif-bold-italic', 'BI')):
            src = self.srcs.get(key)
            if src:
                for cp in sorted(DIGITS):
                    if cp in src.cmap:
                        self.put(variant, cp, self.gspec(src, src.cmap[cp]))
        # \mathit: the text italic letters
        if 'I' in self.srcs:
            I = self.srcs['I']
            for cp in sorted(ALPHA):
                if cp in I.cmap:
                    self.put('-tex-mathit', cp, self.gspec(I, I.cmap[cp]))
        # \mathcal: the script capitals in their calligraphic form (ss01, or the variation sequence U+FE00)
        cal = M.feature_subst(self.args.calligraphic_feature)
        uvs = {}
        for st in M.font['cmap'].tables:
            if st.format == 14:
                for u, g in st.uvsDict.get(0xFE00, []):
                    if g:
                        uvs[u] = g
        for variant, caps in (('-tex-calligraphic', SCRIPT_UC), ('-tex-bold-calligraphic', BOLD_SCRIPT_UC)):
            n = 0
            for i, ucp in enumerate(caps):
                g = M.cmap.get(ucp)
                if not g:
                    continue
                alt = (cal.get(g) or [None])[0] or uvs.get(ucp)
                if alt:
                    self.put(variant, 0x41 + i, self.gspec(M, alt))
                    n += 1
            if 0 < n < 26:
                warn(f'{variant}: only {n} calligraphic capitals')
            if not n:
                self.notes.append(f'{variant}: no calligraphic forms, falls back to the script letters')
        # primes and quotes as superscripts: their ssty1 forms (-tex-variant)
        ssty = M.feature_subst('ssty')
        for cp in sorted(R((0x2018, 0x201F), (0x2032, 0x2037), 0x2057)):
            g = M.cmap.get(cp)
            if g and g in ssty:
                self.put('-tex-variant', cp, self.gspec(M, ssty[g][0]))
        # old-style figures
        onum = M.feature_subst('onum')
        for cp in sorted(DIGITS):
            g = M.cmap.get(cp)
            if g and g in onum:
                self.put('-tex-oldstyle', cp, self.gspec(M, onum[g][0]))

    # -- delimiters

    def size_variant(self, i):
        while len(self.size_variants) <= i:
            self.size_variants.append(f'-size{len(self.size_variants)}')
        return self.size_variants[i]

    def measure(self, spec, vertical):
        b = spec.bounds()
        if vertical:
            return (b[3] - b[1]) if b else 0
        return spec.adv

    def build_delimiters(self):
        M = self.M
        dmin = M.constant('DisplayOperatorMinHeight')
        normal = self.chars['normal']
        for cp in sorted(normal):
            spec = normal[cp][0]
            g = spec.name
            if not g or not spec.plain():
                continue
            for vertical, table in ((True, M.vert), (False, M.horiz)):
                con = table.get(g)
                if not con:
                    continue
                self.delimiter_from_math(cp, g, con, vertical, dmin)
        # rules that repeat themselves
        for cp, sized in LINES_H.items():
            if cp in self.delims or not self.has('normal', cp):
                continue
            self.line_delimiter(cp, False, sized)
        for cp in LINES_V:
            if cp in self.delims or not self.has('normal', cp):
                continue
            self.line_delimiter(cp, True, True)
        # arrows without an assembly: cut at the middle of the shaft
        for vertical, cps in ((False, ARROWS_H), (True, ARROWS_V)):
            for cp in sorted(cps):
                d = self.delims.get(cp)
                if (d and d.get('stretch')) or not self.has('normal', cp):
                    continue
                self.cut_arrow(cp, vertical)
        for cp, target in ALIASES.items():
            if cp in self.delims or target not in self.delims:
                continue
            if cp != target:
                self.delims[cp] = dict(self.delims[target], c=self.delims[target].get('c', target))
        # Large operators (integrals): the italic correction places the limits (the subscript that much to
        # the left of the superscript), it is no room after the glyph. MathJax adds it to the box, so the
        # width is the advance less the correction (MathJax's fonts' fixIC): a lone ∫ is as wide as its
        # advance, its subscript tucked under it, its superscript at the advance.
        for variant in ('normal', '-largeop'):
            for cp in LARGEOPS:
                if not self.has(variant, cp):
                    continue
                spec, d = self.chars[variant][cp]
                ic = d[3].get('ic', 0)
                b = spec.bounds()
                if ic and b and b[2] - spec.adv < ic * self.upm:
                    d[2] = self.em(spec.adv) - ic

    def delimiter_from_math(self, cp, g, con, vertical, dmin):
        M = self.M
        recs = [(r.VariantGlyph, r.AdvanceMeasurement) for r in con.MathGlyphVariantRecord]
        base = self.chars['normal'][cp]
        if not recs or recs[0][0] != g:
            recs.insert(0, (g, self.measure(base[0], vertical)))
        d = {'dir': 'V' if vertical else 'H'}
        if cp in LARGEOPS and vertical:
            disp = next((r for r in recs[1:] if r[1] >= dmin), recs[-1] if len(recs) > 1 else None)
            if disp:
                self.put('-largeop', cp, self.gspec(M, disp[0]))
                d['sizes'] = [self.em(recs[0][1]), self.em(disp[1])]
                d['variants'] = [0, 2]
            self.delims[cp] = d
            return
        sizes = []
        for i, (vg, measure) in enumerate(recs):
            if i:
                self.put(self.size_variant(i), cp, self.gspec(M, vg))
            sizes.append(self.em(measure))
        d['sizes'] = sizes
        asm = con.GlyphAssembly
        if asm and asm.PartRecords:
            parts = [(p.glyph, bool(p.PartFlags & 1)) for p in asm.PartRecords]
            if vertical:
                parts.reverse()             # MathJax lists them top to bottom
            if not self.assembly(cp, d, parts, vertical):
                warn(f'{hexcp(cp)}: glyph assembly {parts} does not fit MathJax\'s beg/ext/end/mid, sizes only')
        self.delims[cp] = d

    def assembly(self, cp, d, parts, vertical):
        exts = {g for g, e in parts if e}
        if len(exts) != 1:
            return False
        ext = exts.pop()
        idx = [i for i, (g, e) in enumerate(parts) if e]
        beg = [g for g, e in parts[:idx[0]] if g != ext]
        end = [g for g, e in parts[idx[-1] + 1:] if g != ext]
        middle = [g for g, e in parts[idx[0] + 1:idx[-1]] if not e]
        if len(beg) > 1 or len(end) > 1 or len(middle) > 1 or (middle and len(idx) != 2):
            return False
        M = self.M
        names = [beg[0] if beg else None, ext, end[0] if end else None, middle[0] if middle else None]
        specs = []
        if vertical:
            width = max(M.adv(n) for n in names if n)
            specs = [GlyphSpec(M, n, adv=width) if n else None for n in names]
        else:
            specs = [GlyphSpec(M, n) if n else None for n in names]
        self.set_parts(cp, d, specs, vertical)
        return True

    def set_parts(self, cp, d, specs, vertical):
        """beg/ext/end/mid glyphs into -lf-tp/-ext/-rt-bt/-mid at the delimiter's code point"""
        stretch, stretchv = [], []
        for spec, variant in zip(specs, ['-lf-tp', '-ext', '-rt-bt', '-mid']):
            if spec is None:
                stretch.append(0)
                stretchv.append(0)
                continue
            self.put(variant, cp, spec, self.data(spec, cp, ic_override=0))
            stretch.append(cp)
            stretchv.append(STRETCH_VARIANTS.index(variant))
        if not specs[3]:
            stretch, stretchv = stretch[:3], stretchv[:3]
        while stretch and stretch[-1] == 0:
            stretch.pop()
            stretchv.pop()
        d['stretch'] = stretch
        d['stretchv'] = stretchv
        base = self.chars['normal'][cp][1]
        ext = self.chars['-ext'][cp]
        if vertical:
            d['HDW'] = [base[0], base[1], max(self.chars[v][cp][1][2] for v in PART_VARIANTS if self.has(v, cp))]
        else:
            hs = [self.chars[v][cp][1] for v in PART_VARIANTS if self.has(v, cp)]
            d['HDW'] = [max(x[0] for x in hs), max(x[1] for x in hs), base[2]]
            # (no `hd`: MathJax would make the box lower, toward the extender's height, and its
            # clip-path then cuts what sticks out of it — arrowheads, hooks, barbs)
            b = ext[0].bounds()
            if b:
                d['ext'] = self.ext_bearings(ext[0].adv - (b[2] - b[0]))

    def ext_bearings(self, units):
        """An extender's left plus right side bearing (MathJax overlaps its copies by that plus .07em). MathJax
        skips the overlap when this is 0 — copies drawn edge to edge leave hairline seams — so never 0."""
        v = self.em(units)
        return v if abs(round(v, 3)) >= 0.001 else 0.001

    def line_delimiter(self, cp, vertical, sized):
        """a rule drawn by repeating the character itself (MathJax's fonts' parts [0, c])"""
        spec, data = self.chars['normal'][cp]
        b = spec.bounds()
        if not b:
            return
        d = {'dir': 'V' if vertical else 'H'}
        if sized:
            d['sizes'] = [data[0] + data[1] if vertical else data[2]]
        if vertical:
            d['stretch'] = [0, cp] if cp != 0x23AA else [0, cp, 0]
            d['HDW'] = [data[0], data[1], data[2]]
        else:
            d['stretch'] = [0, cp]
            d['HDW'] = [data[0], data[1], data[2]]
            d['ext'] = self.ext_bearings(spec.adv - (b[2] - b[0]))
        self.delims[cp] = d

    def cut_arrow(self, cp, vertical):
        """An arrow the MATH table cannot stretch: its glyph cut in two at the middle of the straight
        part of its shaft (the two ends), with the shaft's cross-section there as the extender."""
        spec = self.chars['normal'][cp][0]
        src, g = spec.src, spec.name
        if not g:
            return
        contours = src.flat(g)
        b = contour_bounds(contours)
        if not b:
            return
        axis = 1 if vertical else 0
        lo, hi = (b[1], b[3]) if vertical else (b[0], b[2])
        step = 4
        positions = []
        p = lo + step
        while p < hi - step:
            positions.append(p)
            p += step

        def same(a, c):
            return len(a) == len(c) and all(abs(x[0] - y[0]) <= 2 and abs(x[1] - y[1]) <= 2 for x, y in zip(a, c))

        runs = []
        cur = None
        for p in positions:
            cs = cross_section(contours, axis, p)
            if cs and cur and same(cs, cur[2]):
                cur[1] = p
            else:
                cur = [p, p, cs]
                if cs:
                    runs.append(cur)
        if not runs:
            warn(f'{hexcp(cp)}: no shaft found, not stretchy')
            return
        mid = (lo + hi) / 2
        runs.sort(key=lambda r: (-(r[0] <= mid <= r[1]), -(r[1] - r[0])))
        a0, a1, cs = runs[0]
        if a1 - a0 < 40:
            runs.sort(key=lambda r: -(r[1] - r[0]))
            a0, a1, cs = runs[0]
            if a1 - a0 < 40:
                warn(f'{hexcp(cp)}: shaft too short, not stretchy')
                return
        m = round((a0 + a1) / 2)
        half = max(20, min(150, (a1 - a0) / 2 - 4))
        if vertical:
            top = cut(contours, 1, lo=m)
            bot = cut(contours, 1, hi=m)
            beg = GlyphSpec(src, None, adv=spec.adv, outline=[[(x, y - m) for x, y in c] for c in top], key=f'cut:{cp}:top')
            end = GlyphSpec(src, None, adv=spec.adv, outline=[[(x, y - b[1]) for x, y in c] for c in bot], key=f'cut:{cp}:bot')
            rect = [[(x0, 0), (x0, 2 * half), (x1, 2 * half), (x1, 0)] for x0, x1 in cs]
            ext = GlyphSpec(src, None, adv=spec.adv, outline=rect, key=f'cut:{cp}:ext')
        else:
            left = cut(contours, 0, hi=m)
            right = cut(contours, 0, lo=m)
            beg = GlyphSpec(src, None, adv=round(m - b[0]), outline=[[(x - b[0], y) for x, y in c] for c in left], key=f'cut:{cp}:left')
            end = GlyphSpec(src, None, adv=round(b[2] - m), outline=[[(x - m, y) for x, y in c] for c in right], key=f'cut:{cp}:right')
            rect = [[(0, y0), (0, y1), (2 * half, y1), (2 * half, y0)] for y0, y1 in cs]
            ext = GlyphSpec(src, None, adv=round(2 * half), outline=rect, key=f'cut:{cp}:ext')
        for s in (beg, end, ext):
            s.outline = [[(round(x), round(y)) for x, y in c] for c in s.outline]
        d = self.delims.get(cp) or {'dir': 'V' if vertical else 'H'}
        if 'sizes' not in d:
            d['sizes'] = [self.chars['normal'][cp][1][0] + self.chars['normal'][cp][1][1] if vertical else self.chars['normal'][cp][1][2]]
        self.set_parts(cp, d, [beg, ext, end, None], vertical)
        self.delims[cp] = d

    # -- parameters

    def params(self):
        M = self.M
        c = M.constant
        os2 = M.font['OS/2']
        xh = getattr(os2, 'sxHeight', 0) or (M.bounds(M.cmap[0x78])[3] if 0x78 in M.cmap else 0.45 * self.upm)
        p = {
            'x_height': xh,
            'quad': self.upm,
            'num1': c('FractionNumeratorDisplayStyleShiftUp'),
            'num2': c('FractionNumeratorShiftUp'),
            'num3': c('StackTopShiftUp'),
            'denom1': c('FractionDenominatorDisplayStyleShiftDown'),
            'denom2': c('FractionDenominatorShiftDown'),
            'sup1': c('SuperscriptShiftUp'),
            'sup2': c('SuperscriptShiftUp'),
            'sup3': c('SuperscriptShiftUpCramped'),
            'sub1': c('SubscriptShiftDown'),
            'sub2': c('SubscriptShiftDown'),
            'sup_drop': c('SuperscriptBaselineDropMax'),
            'sub_drop': c('SubscriptBaselineDropMin'),
            'delim1': c('DelimitedSubFormulaMinHeight'),
            'delim2': c('DelimitedSubFormulaMinHeight'),
            'axis_height': c('AxisHeight'),
            'rule_thickness': c('FractionRuleThickness'),
            'big_op_spacing1': c('UpperLimitGapMin'),
            'big_op_spacing2': c('LowerLimitGapMin'),
            'big_op_spacing3': c('UpperLimitBaselineRiseMin'),
            'big_op_spacing4': c('LowerLimitBaselineDropMin'),
            'surd_height': c('RadicalRuleThickness'),
            'scriptspace': c('SpaceAfterScript'),
        }
        p = {k: self.em(v) for k, v in p.items()}
        # MathJax leaves rule_thickness × separation_factor between a base and its accent. The font's accents
        # are drawn for a base AccentBaseHeight tall: the gap they leave above it is the separation.
        bottoms = sorted(M.bounds(M.cmap[a])[1] for a in set(ACCENT_MAP.values()) - {0x20D7} if a in M.cmap and M.bounds(M.cmap[a]))
        if bottoms:
            gap = self.em(bottoms[len(bottoms) // 2] - c('AccentBaseHeight'))
            p['separation_factor'] = round(min(3, max(0.25, gap / p['rule_thickness'])), 3)
        return p

    def math_constants(self):
        mc = self.M.math.MathConstants
        out = {}
        for k in mc.__dict__:
            v = getattr(mc, k)
            v = getattr(v, 'Value', v)
            if isinstance(v, int):
                out[k] = v if 'Percent' in k else self.em(v)
        return out

    # -- blocks

    def assign_blocks(self):
        """(variant, code point) → (block name or None, font id within the block)"""
        owner = {}
        for name, ids in BLOCKS:
            for fid, spec in ids.items():
                for variant, cps in (spec if isinstance(spec, list) else [spec]):
                    for cp in cps:
                        owner.setdefault((variant, cp), (name, fid))
        self.block_of = {}
        for variant, chars in self.chars.items():
            for cp in chars:
                key = (variant, cp)
                if key in owner:
                    self.block_of[key] = owner[key]
                elif variant in self.size_variants or variant in PART_VARIANTS:
                    # sizes and parts go with their character
                    b = owner.get(('normal', cp))
                    self.block_of[key] = (b[0], '') if b else (None, None)
                else:
                    self.block_of[key] = (None, None)
        self.delim_block = {}
        for cp in self.delims:
            b = owner.get(('normal', cp))
            self.delim_block[cp] = b[0] if b and ('normal', cp) in self.block_of and self.block_of[('normal', cp)][0] else None

    # -- output

    def variant_letters(self):
        L = {'normal': '', 'bold': 'B', 'italic': 'I', 'bold-italic': 'BI', 'sans-serif-italic': 'SSI',
             'sans-serif-bold-italic': 'SSBI', '-smallop': 'SO', '-largeop': 'LO', '-tex-variant': 'V',
             '-tex-mathit': 'MI', '-tex-oldstyle': 'OS', '-tex-bold-oldstyle': 'OB', '-tex-calligraphic': 'C',
             '-tex-bold-calligraphic': 'CB', '-lf-tp': 'LT', '-rt-bt': 'RB', '-ext': 'E', '-mid': 'MID'}
        for v in self.size_variants[3:]:
            L[v] = 'S' + v[len('-size'):]
        return L

    def write(self):
        out = self.args.out
        pkg = f'mathjax-{self.args.id}-font'
        cls = f'MathJax{self.args.name}Font'
        P = self.prefix
        if os.path.isdir(out):
            shutil.rmtree(out)
        os.makedirs(os.path.join(out, 'chtml', 'dynamic'))
        os.makedirs(os.path.join(out, 'chtml', 'woff2'))
        letters = self.variant_letters()
        variants = [v for v in ['normal', 'bold', 'italic', 'bold-italic', 'sans-serif-italic', 'sans-serif-bold-italic']
                    + self.size_variants[1:] + ['-tex-variant', '-tex-mathit', '-tex-oldstyle', '-tex-bold-oldstyle',
                                                '-tex-calligraphic', '-tex-bold-calligraphic'] + PART_VARIANTS]
        # a variant without characters anywhere gets no letter (its characters are its parent's)
        used = {v for v in variants if self.chars.get(v)}
        variants = [v for v in variants if v in used or v == 'normal']
        header = self.header()
        # module file and export names as MathJax's fonts have them (bold-italic.js: boldItalic)
        special = {'-tex-bold-calligraphic': 'tex-calligraphic-bold', '-tex-bold-oldstyle': 'tex-oldstyle-bold'}
        fname = lambda v: special.get(v, v.lstrip('-'))
        exportname = {v: re.sub(r'-(\w)', lambda m: m.group(1).upper(), fname(v)) for v in variants}

        # static character data
        woff = {}           # letter → {cp: spec}

        def add_woff(letter, cp, spec):
            if spec is None:
                return
            m = woff.setdefault(letter, {})
            if cp in m and m[cp].key != spec.key:
                warn(f'font letter {letter!r}: {hexcp(cp)} wanted for two glyphs ({m[cp].key}, {spec.key})')
                return
            m[cp] = spec

        letter_name = lambda l: l or 'N'
        for v in variants:
            chars = {cp: x for cp, x in self.chars.get(v, {}).items() if self.block_of[(v, cp)][0] is None}
            with open(os.path.join(out, 'chtml', fname(v) + '.js'), 'w') as f:
                f.write(header)
                f.write(f'export const {exportname[v]} = {{\n')
                f.write(',\n'.join(f'    {hexcp(cp)}: {self.fmt(d)}' for cp, (s, d) in sorted(chars.items())))
                f.write('\n};\n')
            for cp, (spec, d) in chars.items():
                add_woff(letter_name(letters[v]), cp, spec)

        # delimiters
        static_delims = {cp: d for cp, d in self.delims.items() if not self.delim_block.get(cp)}
        with open(os.path.join(out, 'chtml', 'delimiters.js'), 'w') as f:
            f.write(header)
            f.write("import { V, H } from '@mathjax/src/mjs/output/common/Direction.js';\n")
            f.write('export const delimiters = {\n')
            f.write(',\n'.join(f'    {hexcp(cp)}: {self.fmt_delim(d)}' for cp, d in sorted(static_delims.items())))
            f.write('\n};\n')

        # dynamic blocks
        dynamic_defs = []
        for name, ids in BLOCKS:
            groups = {}         # font id → variant → {cp: data}
            ranges = {}         # variant → cps
            for (v, cp), (bname, fid) in self.block_of.items():
                if bname != name:
                    continue
                spec, d = self.chars[v][cp]
                groups.setdefault(fid, {}).setdefault(v, {})[cp] = d
                ranges.setdefault(v, []).append(cp)
                add_woff(fid if fid else letter_name(letters[v]), cp, spec)
            delims = {cp: d for cp, d in self.delims.items() if self.delim_block.get(cp) == name}
            if not groups and not delims:
                continue
            fonts = sorted(f'MJX-{P}-{fid}' for fid in groups if fid)
            with open(os.path.join(out, 'chtml', 'dynamic', name + '.js'), 'w') as f:
                f.write(header)
                f.write("import { AddFontIds } from '@mathjax/src/mjs/output/chtml/DynamicFonts.js';\n")
                f.write(f"import {{ {cls} }} from '../../chtml.js';\n")
                if delims:
                    f.write("import { V, H } from '@mathjax/src/mjs/output/common/Direction.js';\n")
                f.write(f"{cls}.dynamicSetup('', '{name}', AddFontIds({{\n")
                parts = []
                for fid in sorted(groups):
                    vs = []
                    for v in sorted(groups[fid]):
                        body = ',\n'.join(f'            {hexcp(cp)}: {self.fmt(d)}' for cp, d in sorted(groups[fid][v].items()))
                        vs.append(f"        '{v}': {{\n{body}\n        }}")
                    parts.append(f"    '{fid}': {{\n" + ',\n'.join(vs) + '\n    }')
                f.write(',\n'.join(parts))
                f.write(f"\n}}, '{P}')")
                if delims or fonts:
                    f.write(', {\n' + ',\n'.join(f'    {hexcp(cp)}: {self.fmt_delim(d)}' for cp, d in sorted(delims.items())) + '\n}')
                if fonts:
                    f.write(', ' + json.dumps(fonts).replace('"', "'"))
                f.write(');\n')
            dynamic_defs.append((name, {v: self.ranges(cps) for v, cps in sorted(ranges.items())}, self.ranges(sorted(delims))))

        # the font's woff2 files
        self.write_woff2(woff)
        self.woff_letters = set(woff)
        self.write_common(variants)
        self.write_chtml(variants, exportname, fname, dynamic_defs, cls, pkg)
        self.write_dts(cls)

    def ranges(self, cps):
        cps = sorted(set(cps))
        out = []
        for c in cps:
            if out and isinstance(out[-1], list) and out[-1][1] == c - 1:
                out[-1][1] = c
            elif out and not isinstance(out[-1], list) and out[-1] == c - 1:
                out[-1] = [out[-1], c]
            else:
                out.append(c)
        return out

    def fmt_ranges(self, rs):
        return '[' + ', '.join(f'[{hexcp(r[0])}, {hexcp(r[1])}]' if isinstance(r, list) else hexcp(r) for r in rs) + ']'

    def fmt(self, d):
        h, dd, w, opts = d
        s = f'[{num(h)}, {num(dd)}, {num(w)}'
        o = [f'{k}: {num(opts[k])}' for k in ('ic', 'sk', 'dx') if k in opts and round(opts[k], 3) != 0]
        if o:
            s += ', { ' + ', '.join(o) + ' }'
        return s + ']'

    def fmt_delim(self, d):
        items = []
        if 'c' in d:
            items.append(f'c: {hexcp(d["c"])}')
        items.append(f'dir: {d["dir"]}')
        if 'sizes' in d:
            items.append('sizes: [' + ', '.join(num(x) for x in d['sizes']) + ']')
        if 'variants' in d:
            items.append('variants: [' + ', '.join(str(x) for x in d['variants']) + ']')
        if 'schar' in d:
            items.append('schar: [' + ', '.join(hexcp(x) for x in d['schar']) + ']')
        if 'stretch' in d:
            items.append('stretch: [' + ', '.join(hexcp(x) if x else '0' for x in d['stretch']) + ']')
            if any(d.get('stretchv', [])):
                items.append('stretchv: [' + ', '.join(str(x) for x in d['stretchv']) + ']')
            items.append('HDW: [' + ', '.join(num(x) for x in d['HDW']) + ']')
            if 'hd' in d:
                items.append('hd: [' + ', '.join(num(x) for x in d['hd']) + ']')
            if d.get('ext'):
                items.append(f'ext: {num(d["ext"])}')
        return '{\n        ' + ',\n        '.join(items) + '\n    }'

    def header(self):
        n = self.M.font['name']
        return (f'// Generated by scripts/build-mathjax-font.py from {os.path.basename(self.args.math)} '
                f'({n.getDebugName(5) or ""}) — do not edit.\n'
                f'// The font: {(n.getDebugName(13) or "").splitlines()[0][:200]}\n')

    def write_common(self, variants):
        P = self.params()
        sv = self.size_variants
        extra = [[v, 'normal'] for v in sv[3:]] + [['-tex-calligraphic', 'script'], ['-tex-bold-calligraphic', 'bold-script']]
        extra += [[v, 'normal'] for v in PART_VARIANTS]
        css = {v: ['serif', False, False] for v in sv[3:] + PART_VARIANTS}
        name = self.args.name
        with open(os.path.join(self.args.out, 'common.js'), 'w') as f:
            f.write(self.header())
            f.write("import { FontData } from '@mathjax/src/mjs/output/common/FontData.js';\n")
            f.write(f'export function CommonMathJax{name}FontMixin(Base) {{\n')
            f.write('    return class extends Base {\n')
            f.write('        static defaultVariants = [\n            ...FontData.defaultVariants,\n')
            f.write(',\n'.join(f'            {json.dumps(x)}'.replace('"', "'") for x in extra) + '\n        ];\n')
            f.write('        static defaultCssFonts = {\n            ...FontData.defaultCssFonts,\n')
            f.write(',\n'.join(f"            '{k}': {json.dumps(v)}".replace('"', "'").replace('false', 'false') for k, v in css.items()) + '\n        };\n')
            f.write('        static defaultAccentMap = {\n' + ',\n'.join(f"            {hexcp(a)}: '\\u{b:04X}'" for a, b in ACCENT_MAP.items()) + '\n        };\n')
            f.write('        static defaultParams = {\n            ...FontData.defaultParams,\n')
            f.write(',\n'.join(f'            {k}: {num(v)}' for k, v in P.items()) + '\n        };\n')
            f.write('        static defaultSizeVariants = ' + json.dumps(sv).replace('"', "'") + ';\n')
            f.write('        static defaultStretchVariants = ' + json.dumps(STRETCH_VARIANTS).replace('"', "'") + ';\n')
            f.write('        /** the font\'s MATH constants (em; the two script percentages as they are) */\n')
            f.write('        static mathConstants = ' + json.dumps({k: round(v, 3) for k, v in self.math_constants().items()}) + ';\n')
            f.write('    };\n}\n')

    def fix_styles(self):
        """CSS MathJax's CHTML output has with Computer Modern's parameters built in, from this font's"""
        P = self.params()
        a, t = P['axis_height'], 0.06          # the fraction rule of \\frac is MathJax's 'medium' (.06em)
        rf = 1.25                               # MathJax's rule_factor
        m = f'mjx-math.{self.prefix}-N'
        em = lambda v: num(v) + 'em' if num(v) != '0' else '0'
        return {
            f'{m} mjx-frac': {'vertical-align': em(a - 1.5 * t)},
            f'{m} mjx-frac[type="d"]': {'vertical-align': em(a - 3.5 * t)},
            f'{m} mjx-nstrut': {'height': em(P['num2'] - a - 1.5 * t), 'vertical-align': em(-(P['num2'] - a - 1.5 * t))},
            f'{m} mjx-nstrut[type="d"]': {'height': em(P['num1'] - a - 3.5 * t), 'vertical-align': em(-(P['num1'] - a - 3.5 * t))},
            f'{m} mjx-dstrut': {'height': em(P['denom2'] + a - 1.5 * t)},
            f'{m} mjx-dstrut[type="d"]': {'height': em(P['denom1'] + a - 3.5 * t)},
            f'{m} mjx-mtable': {'vertical-align': em(a)},
            f'{m} mjx-mstyle[size="s"] mjx-mtable': {'vertical-align': em(a / 0.707)},
            f'{m} mjx-mtr[rowalign="axis"] > mjx-mtd': {'vertical-align': em(a)},
            f'{m} mjx-mtd[rowalign="axis"]': {'vertical-align': em(a)},
            f'{m} mjx-sqrt': {'padding-top': em(P['surd_height'] * rf)},
            f'{m} mjx-script': {'padding-right': em(P['scriptspace'])},
            f'{m} mjx-prescripts': {'padding-left': em(P['scriptspace'])},
            f'{m} mjx-scripts': {'padding-right': em(P['scriptspace'])},
        }

    def write_chtml(self, variants, exportname, fname, dynamic_defs, cls, pkg):
        P = self.prefix
        letters = self.variant_letters()
        out = self.args.out
        with open(os.path.join(out, 'chtml.js'), 'w') as f:
            f.write(self.header())
            f.write("import { ChtmlFontData } from '@mathjax/src/mjs/output/chtml/FontData.js';\n")
            f.write(f"import {{ CommonMathJax{self.args.name}FontMixin }} from './common.js';\n")
            for v in variants:
                f.write(f"import {{ {exportname[v]} }} from './chtml/{fname(v)}.js';\n")
            f.write("import { delimiters } from './chtml/delimiters.js';\n")
            f.write(f'const Base = CommonMathJax{self.args.name}FontMixin(ChtmlFontData);\n')
            f.write(f'export class {cls} extends Base {{\n    constructor() {{\n        super(...arguments);\n'
                    f"        this.cssFontPrefix = '{P}';\n    }}\n}}\n")
            f.write(f"{cls}.NAME = 'MathJax{self.args.name}';\n")
            f.write(f"{cls}.OPTIONS = {{ ...Base.OPTIONS, fontURL: '@mathjax/{pkg}/js/chtml/woff2', dynamicPrefix: '@mathjax/{pkg}/js/chtml/dynamic' }};\n")
            f.write(f"{cls}.defaultCssFamilyPrefix = 'MJX-{P}-ZERO';\n")
            f.write(f'{cls}.defaultVariantLetters = {{\n' + ',\n'.join(f"    '{v}': '{letters[v]}'" for v in variants) + '\n};\n')
            f.write(f'{cls}.defaultDelimiters = delimiters;\n')
            f.write(f'{cls}.defaultChars = {{\n' + ',\n'.join(f"    '{v}': {exportname[v]}" for v in variants) + '\n};\n')
            styles = {f'mjx-container[jax="CHTML"] > mjx-math.{P}-N[breakable] > *': {'font-family': f'MJX-{P}-ZERO, MJX-{P}-N'}}
            for v in variants:
                L = letters[v] or 'N'
                styles[f'.{P}-{L}'] = {'font-family': f'MJX-{P}-ZERO, MJX-{P}-{L}'}
            styles.update(self.fix_styles())
            f.write(f'{cls}.defaultStyles = {{\n    ...ChtmlFontData.defaultStyles,\n' +
                    ',\n'.join(f"    '{k}': {{ " + ', '.join(f"'{a}': '{b}'" for a, b in v.items()) + ' }' for k, v in styles.items()) + '\n};\n')
            fonts = [('MJX-%s-ZERO' % P, 'mjx-%s-zero.woff2' % P.lower()), ('MJX-BRK', 'mjx-%s-brk.woff2' % P.lower())]
            fonts += [(f'MJX-{P}-{letters[v] or "N"}', f'mjx-{P.lower()}-{(letters[v] or "N").lower()}.woff2') for v in variants
                      if (letters[v] or 'N') in self.woff_letters]
            f.write(f'{cls}.defaultFonts = {{\n    ...ChtmlFontData.defaultFonts,\n' +
                    ',\n'.join(f"    '@font-face /* {fam} */': {{ 'font-family': '{fam}', src: 'url(\"%%URL%%/{file}\") format(\"woff2\")' }}" for fam, file in fonts) + '\n};\n')
            f.write(f'{cls}.dynamicFiles = ChtmlFontData.defineDynamicFiles([\n')
            items = []
            for name, vranges, dranges in dynamic_defs:
                vs = ',\n'.join(f"        '{v}': {self.fmt_ranges(r)}" for v, r in vranges.items())
                s = f"    ['{name}', {{\n{vs}\n    }}"
                if dranges:
                    s += ', ' + self.fmt_ranges(dranges)
                items.append(s + ']')
            f.write(',\n'.join(items) + '\n]);\n')

    def write_dts(self, cls):
        with open(os.path.join(self.args.out, 'chtml.d.ts'), 'w') as f:
            f.write(self.header())
            f.write("import { ChtmlFontData } from '@mathjax/src/js/output/chtml/FontData.js';\n")
            f.write(f'export declare class {cls} extends ChtmlFontData {{\n    static NAME: string;\n}}\n')

    # -- woff2

    def write_woff2(self, woff):
        P = self.prefix.lower()
        d = os.path.join(self.args.out, 'chtml', 'woff2')
        self.woff_sizes = {}
        self.save_font(os.path.join(d, f'mjx-{P}-zero.woff2'), f'mjx-{P}-zero', {0x20: GlyphSpec(self.M, None, adv=round(0.25 * self.upm), key='zero')}, (750, -750))
        self.save_font(os.path.join(d, f'mjx-{P}-brk.woff2'), f'mjx-{P}-brk', {0x20: GlyphSpec(self.M, None, adv=self.upm, key='brk')}, (500, -10))
        for letter, cps in sorted(woff.items()):
            name = f'mjx-{P}-{letter.lower()}'
            self.save_font(os.path.join(d, name + '.woff2'), name, cps)

    def save_font(self, path, family, cps, vmetrics=None):
        order = ['.notdef']
        glyphs = {'.notdef': Glyph()}
        hmtx = {'.notdef': (0, 0)}
        cmap = {}
        names = {}          # spec key → glyph name

        def copy_glyph(src, gname):
            out = f'{src.key}.{gname}'
            if out in glyphs:
                return out
            if 'glyf' not in src.font:
                # a CFF font: its cubic outline as quadratic curves (TrueType runs the other way round)
                pen = TTGlyphPen(None)
                src.gs[gname].draw(Cu2QuPen(pen, 1.0, reverse_direction=True))
                glyphs[out] = pen.glyph()
                order.append(out)
                hmtx[out] = (src.adv(gname), 0)
                return out
            g = copy.deepcopy(src.font['glyf'][gname])
            g.expand(src.font['glyf'])
            if g.isComposite():
                if hasattr(g, 'program'):
                    del g.program
            elif g.numberOfContours:
                g.program = ttProgram.Program()
                g.program.fromBytecode(b'')
            if g.isComposite():
                for comp in g.components:
                    comp.glyphName = copy_glyph(src, comp.glyphName)
            glyphs[out] = g
            order.append(out)
            hmtx[out] = (src.adv(gname), 0)
            return out

        def realize(spec):
            if spec.key in names:
                return names[spec.key]
            if spec.outline is not None:
                gname = f'x{len(order)}'
                g = outline_glyph(spec.outline)
            elif spec.name is None:
                gname = f'space{len(order)}'
                g = Glyph()
            elif spec.plain():
                gname = copy_glyph(spec.src, spec.name)
                names[spec.key] = gname
                return gname
            else:
                inner = copy_glyph(spec.src, spec.name)
                gname = f'm{len(order)}'
                g = Glyph()
                g.numberOfContours = -1
                comp = GlyphComponent()
                comp.glyphName = inner
                comp.x, comp.y = int(spec.dx), int(spec.dy)
                comp.flags = 0x4          # ROUND_XY_TO_GRID
                g.components = [comp]
            glyphs[gname] = g
            order.append(gname)
            hmtx[gname] = (int(round(spec.adv)), 0)
            names[spec.key] = gname
            return gname

        for cp, spec in sorted(cps.items()):
            cmap[cp] = realize(spec)
        if not any(g.numberOfContours for g in glyphs.values()):
            # browsers reject a font whose glyf table is empty (MathJax's ZERO and BRK fonts are only a
            # space): .notdef gets a box, which is never drawn (unmapped characters go to the next family)
            glyphs['.notdef'] = outline_glyph([[(50, 0), (50, 700), (450, 700), (450, 0)]])
            hmtx['.notdef'] = (500, 0)
        fb = FontBuilder(self.upm, isTTF=True)
        fb.setupGlyphOrder(order)
        fb.setupCharacterMap(cmap)
        fb.setupGlyf(glyphs)
        # left side bearings follow the glyphs' boxes
        glyf = fb.font['glyf']
        metrics = {}
        ymax, ymin = 0, 0
        for gname in order:
            g = glyf[gname]
            g.recalcBounds(glyf)
            lsb = getattr(g, 'xMin', 0) if g.numberOfContours else 0
            metrics[gname] = (hmtx[gname][0], lsb)
            if g.numberOfContours:
                ymax = max(ymax, g.yMax)
                ymin = min(ymin, g.yMin)
        fb.setupHorizontalMetrics(metrics)
        asc, desc = vmetrics or (ymax, ymin)
        fb.setupHorizontalHeader(ascent=asc, descent=desc)
        n = self.M.font['name']
        fb.setupNameTable({
            'familyName': family, 'styleName': 'Regular',
            'copyright': n.getDebugName(0) or '',
            'licenseDescription': n.getDebugName(13) or '', 'licenseInfoURL': n.getDebugName(14) or '',
            'description': f'Glyphs of {n.getDebugName(4)} ({n.getDebugName(5)}) for MathJax, '
                           f'made by OverLyX\'s scripts/build-mathjax-font.py',
        })
        fb.setupOS2(sTypoAscender=asc, sTypoDescender=desc, sTypoLineGap=0, usWinAscent=max(asc, 0),
                    usWinDescent=max(-desc, 0), fsSelection=0x40, achVendID='    ')
        fb.setupPost(keepGlyphNames=False)
        # the source's dates, not the time of the build: the same input gives the same files
        fb.font['head'].created = fb.font['head'].modified = self.M.font['head'].modified
        fb.font.recalcTimestamp = False
        fb.font.flavor = 'woff2'
        fb.font.save(path)
        self.woff_sizes[os.path.basename(path)] = os.path.getsize(path)

    # -- report

    def report(self):
        n = self.chars['normal']
        xh = n.get(0x78, (None, [0]))[1][0]
        cap = n.get(0x48, (None, [0]))[1][0]
        js = 0
        for dp, _, fs in os.walk(self.args.out):
            for f in fs:
                if f.endswith('.js'):
                    js += os.path.getsize(os.path.join(dp, f))
        wo = sum(self.woff_sizes.values())
        print(f'{self.args.out}:')
        print(f'  x-height {num(xh)} em (U+0078), cap height {num(cap)} em (U+0048)')
        print(f'  {sum(len(c) for c in self.chars.values())} characters in {len(self.chars)} variants, '
              f'{len(self.delims)} stretchy, size variants up to {self.size_variants[-1]}')
        print(f'  data {js / 1024:.0f} kB in .js, {len(self.woff_sizes)} woff2 files {wo / 1024:.0f} kB')
        for note in self.notes:
            print('  note:', note)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0], formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--id', required=True, help='the font id (a-z, 0-9): the package is mathjax-<id>-font')
    ap.add_argument('--prefix', required=True, help='the CSS prefix (A-Z, 0-9): classes <PREFIX>-N, families MJX-<PREFIX>-N')
    ap.add_argument('--name', help='the class name part: MathJax<Name>Font (default: the id capitalised)')
    ap.add_argument('--math', required=True, help='the OpenType math font (regular)')
    ap.add_argument('--bold', help='the bold text face (\\mathbf of what is not a letter or digit)')
    ap.add_argument('--italic', help='the italic text face (\\mathit)')
    ap.add_argument('--bold-italic', help='the bold italic text face')
    ap.add_argument('--calligraphic-feature', default='ss01', help='the GSUB feature of the calligraphic capitals (\\mathcal)')
    ap.add_argument('--out', help='output directory (default packages/client/src/fonts/@mathjax/mathjax-<id>-font)')
    args = ap.parse_args()
    if not re.fullmatch(r'[a-z0-9]+', args.id):
        sys.exit('--id: lower-case letters and digits')
    if not re.fullmatch(r'[A-Z][A-Z0-9]*', args.prefix):
        sys.exit('--prefix: upper-case letters and digits')
    args.name = args.name or args.id.capitalize()
    args.out = args.out or os.path.join(ROOT, 'packages', 'client', 'src', 'fonts', '@mathjax', f'mathjax-{args.id}-font')
    b = Builder(args)
    b.build_variants()
    b.build_delimiters()
    b.assign_blocks()
    b.write()
    b.report()


if __name__ == '__main__':
    main()

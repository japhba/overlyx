#!/usr/bin/env python3
"""
Builds the editor's web fonts (Settings ▸ Editor ▸ Text font / Math font; the catalogue is
packages/client/src/fonts/catalog.ts) into packages/client/src/fonts/web/:

  text/<id>/<style>-<part>.woff2   a text face, subset into a Latin part and a Greek/Cyrillic part
                                   (unicode-range, so the second is fetched only when needed)
  math/<id>/<face>.woff2           an OpenType math font taken apart into the faces KaTeX's HTML
                                   uses, so that KaTeX keeps its layout and only the glyphs change
  webfonts.css                     the @font-face rules (families "OLT <id>…" and "OLM <id>…")
  metrics.gen.ts                   the x-height of every text face (formulas are scaled to it)

KaTeX cannot read an OpenType MATH table: it lays formulas out with its own Computer Modern
metrics and fonts. The math faces therefore put each glyph where KaTeX expects its Computer Modern
counterpart:

  main          upright letters, digits, operators, relations, arrows, delimiters, Greek, AMS
                symbols (as in KaTeX_Main / KaTeX_AMS); the accents KaTeX draws with spacing
                characters (^ ~ ˉ ˙ ¨ ˘ ˇ ˊ ˋ ˚) are the font's math accents, centred and at the
                height of KaTeX's own; U+E020 (KaTeX's \\not slash) is the font's U+0338 centred on
                the font's own "=", so ≠ and \\not< come out right
  it bf bfit    the math italic / bold / bold italic alphabets (U+1D400…), put at the ASCII and
                Greek code points KaTeX writes (\\mathnormal, \\mathbf, \\boldsymbol)
  cal frak bb   script (\\mathcal), fraktur, double-struck; sf, tt: sans-serif and monospace
  size1…size4   the big operators and delimiters (KaTeX_Size1…4): the font's own size variant
                (MATH table) closest to KaTeX's glyph, scaled to exactly its height and centred on it

Every face is scaled so that its x-height is Computer Modern's (0.4306 em), which keeps KaTeX's
metrics — accent clearance, script shifts, the math axis — right for the substituted glyphs. What
stays KaTeX's: spacing, fraction and radical rules, the SVG radical sign, \\vec, \\widehat,
\\widetilde and stretchy arrows, and delimiters taller than \\Bigg (stacked pieces).

Family names are our own (OFL "Reserved Font Names"); every file keeps its source's copyright and
licence strings, collected in packages/client/public/licenses/editor-fonts.txt.

Requires fontTools and brotli (`pip install fonttools brotli`), TeX Live for most sources (the rest
are downloaded from CTAN / google/fonts into --cache) and KaTeX in node_modules (its fonts are the
reference). Usage: python3 scripts/build-editor-fonts.py [--cache DIR] [--only id,id]
"""
import argparse
import json
import math
import os
import re
import subprocess
import sys
import urllib.request

from fontTools import subset
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.recordingPen import DecomposingRecordingPen, RecordingPen
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTCollection, TTFont
from fontTools.varLib import instancer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'packages/client/src/fonts/web')
LICENSES = os.path.join(ROOT, 'packages/client/public/licenses/editor-fonts.txt')
KATEX = os.path.join(ROOT, 'node_modules/katex/dist/fonts')
KATEX_METRICS = os.path.join(ROOT, 'node_modules/katex/src/fontMetricsData.js')
CTAN = 'https://ftp.fau.de/ctan/fonts/'  # any CTAN mirror
GF = 'https://raw.githubusercontent.com/google/fonts/main/ofl/'
NOTO = 'https://cdn.jsdelivr.net/gh/notofonts/notofonts.github.io/fonts/'

try:
    TEXMF = subprocess.run(['kpsewhich', '-var-value', 'TEXMFDIST'], capture_output=True, text=True).stdout.strip()
except OSError:
    TEXMF = ''
TEXMF = TEXMF or '/usr/share/texlive/texmf-dist'


def tl(p):
    return 'tl:fonts/' + p


# ------------------------------------------------------------------ sources
# math fonts: id → (source, index in a collection). The ids are the catalogue's (fonts/catalog.ts).
MATH = {
    'lm': CTAN + 'lm-math/opentype/latinmodern-math.otf',
    'newcm': tl('opentype/public/newcomputermodern/NewCMMath-Regular.otf'),
    'newcm-book': tl('opentype/public/newcomputermodern/NewCMMath-Book.otf'),
    'stix2': tl('opentype/public/stix2-otf/STIXTwoMath-Regular.otf'),
    'xits': tl('opentype/public/xits/XITSMath-Regular.otf'),
    'libertinus': tl('opentype/public/libertinus-fonts/LibertinusMath-Regular.otf'),
    'termes': CTAN + 'tex-gyre-math/opentype/texgyretermes-math.otf',
    'pagella': CTAN + 'tex-gyre-math/opentype/texgyrepagella-math.otf',
    'bonum': CTAN + 'tex-gyre-math/opentype/texgyrebonum-math.otf',
    'schola': CTAN + 'tex-gyre-math/opentype/texgyreschola-math.otf',
    'dejavu': CTAN + 'tex-gyre-math/opentype/texgyredejavu-math.otf',
    'asana': (tl('truetype/public/asana-math/ASANA.TTC'), 1),
    'euler': tl('opentype/public/euler-math/Euler-Math.otf'),
    'garamond': tl('opentype/public/garamond-math/Garamond-Math.otf'),
    'erewhon': tl('opentype/public/erewhon-math/Erewhon-Math.otf'),
    'xcharter': tl('opentype/public/xcharter-math/XCharter-Math.otf'),
    'concrete': tl('opentype/public/concmath-otf/Concrete-Math.otf'),
    'kp': tl('opentype/public/kpfonts-otf/KpMath-Regular.otf'),
    'kp-light': tl('opentype/public/kpfonts-otf/KpMath-Light.otf'),
    'kp-sans': tl('opentype/public/kpfonts-otf/KpMath-Sans.otf'),
    'oldstandard': tl('opentype/public/oldstandard/OldStandard-Math.otf'),
    'neohellenic': tl('opentype/public/gfsneohellenicmath/GFSNeohellenicMath.otf'),
    'fira': tl('opentype/public/firamath/FiraMath-Regular.otf'),
    'lete': CTAN + 'lete-sans-math/LeteSansMath.otf',
    'noto': NOTO + 'NotoSansMath/unhinted/otf/NotoSansMath-Regular.otf',
    'plex': CTAN + 'plex/opentype/IBMPlexMath-Regular.otf',
    'luciole': CTAN + 'luciole/Luciole-Math.otf',
    'pennstander': CTAN + 'pennstander-otf/fonts/PennstanderMath-Regular.otf',
    'arsenal': CTAN + 'arsenal-math/otf/ArsenalMath-Sans.otf',
    'pl46': CTAN + 'pl46-fonts/PL46-Math.otf',
}

# text faces: id → {family role: {style: source}}; roles 'text' (the face), 'sans' and 'mono'
# (Text Style ▸ Family). A source may be (file, {axis: value}) for a variable font.
def four(r, i, b, bi):
    return {'regular': r, 'italic': i, 'bold': b, 'bolditalic': bi}


def texgyre(n):
    return four(*(CTAN + f'tex-gyre/opentype/texgyre{n}-{s}.otf' for s in ('regular', 'italic', 'bold', 'bolditalic')))


TL_OT = 'opentype/public/'
TEXT = {
    'newcm': {'text': four(*(tl(TL_OT + f'newcomputermodern/NewCM10-{s}.otf') for s in ('Book', 'BookItalic', 'Bold', 'BoldItalic')))},
    'libertinus': {
        'text': four(*(tl(TL_OT + f'libertinus-fonts/LibertinusSerif-{s}.otf') for s in ('Regular', 'Italic', 'Bold', 'BoldItalic'))),
        'sans': {'regular': tl(TL_OT + 'libertinus-fonts/LibertinusSans-Regular.otf'), 'italic': tl(TL_OT + 'libertinus-fonts/LibertinusSans-Italic.otf'), 'bold': tl(TL_OT + 'libertinus-fonts/LibertinusSans-Bold.otf')},
        'mono': {'regular': tl(TL_OT + 'libertinus-fonts/LibertinusMono-Regular.otf')},
    },
    'stix2': {'text': four(*(tl(TL_OT + f'stix2-otf/STIXTwoText-{s}.otf') for s in ('Regular', 'Italic', 'Bold', 'BoldItalic')))},
    'xits': {'text': four(*(tl(TL_OT + f'xits/XITS-{s}.otf') for s in ('Regular', 'Italic', 'Bold', 'BoldItalic')))},
    'termes': {'text': texgyre('termes')},
    'pagella': {'text': texgyre('pagella')},
    'bonum': {'text': texgyre('bonum')},
    'schola': {'text': texgyre('schola')},
    'dejavu': {'text': four(*(CTAN + f'dejavu/truetype/DejaVuSerif{s}.ttf' for s in ('', '-Italic', '-Bold', '-BoldItalic')))},
    'garamond': {'text': four(*(tl(TL_OT + f'ebgaramond/EBGaramond-{s}.otf') for s in ('Regular', 'Italic', 'Bold', 'BoldItalic')))},
    'crimson': {'text': four((GF + 'crimsonpro/CrimsonPro[wght].ttf', {'wght': 400}), (GF + 'crimsonpro/CrimsonPro-Italic[wght].ttf', {'wght': 400}),
                             (GF + 'crimsonpro/CrimsonPro[wght].ttf', {'wght': 700}), (GF + 'crimsonpro/CrimsonPro-Italic[wght].ttf', {'wght': 700}))},
    'charis': {'text': four(*(GF + f'charissil/CharisSIL-{s}.ttf' for s in ('Regular', 'Italic', 'Bold', 'BoldItalic')))},
    'xcharter': {'text': four(*(tl(TL_OT + f'xcharter/XCharter-{s}.otf') for s in ('Roman', 'Italic', 'Bold', 'BoldItalic')))},
    'erewhon': {'text': four(*(tl(TL_OT + f'erewhon/Erewhon-{s}.otf') for s in ('Regular', 'Italic', 'Bold', 'BoldItalic')))},
    'kp': {'text': four(*(tl(TL_OT + f'kpfonts-otf/KpRoman-{s}.otf') for s in ('Regular', 'Italic', 'Bold', 'BoldItalic')))},
    'concrete': {'text': four(*(tl(TL_OT + f'cm-unicode/{s}.otf') for s in ('cmunorm', 'cmunoti', 'cmunobx', 'cmunobi')))},
    'oldstandard': {'text': four(*(tl(TL_OT + f'oldstandard/OldStandard-{s}.otf') for s in ('Regular', 'Italic', 'Bold', 'BoldItalic')))},
    'neohellenic': {'text': four(*(GF + f'gfsneohellenic/GFSNeohellenic{s}.ttf' for s in ('', 'Italic', 'Bold', 'BoldItalic')))},
    'fira': {'text': four(*(tl(TL_OT + f'fira/FiraSans-{s}.otf') for s in ('Regular', 'Italic', 'Bold', 'BoldItalic'))),
             'mono': {'regular': tl(TL_OT + 'fira/FiraMono-Regular.otf'), 'bold': tl(TL_OT + 'fira/FiraMono-Bold.otf')}},
    'lato': {'text': four(*(GF + f'lato/Lato-{s}.ttf' for s in ('Regular', 'Italic', 'Bold', 'BoldItalic')))},
    'notosans': {'text': four((GF + 'notosans/NotoSans[wdth,wght].ttf', {'wdth': 100, 'wght': 400}), (GF + 'notosans/NotoSans-Italic[wdth,wght].ttf', {'wdth': 100, 'wght': 400}),
                          (GF + 'notosans/NotoSans[wdth,wght].ttf', {'wdth': 100, 'wght': 700}), (GF + 'notosans/NotoSans-Italic[wdth,wght].ttf', {'wdth': 100, 'wght': 700}))},
    'plex': {'text': four(*(CTAN + f'plex/opentype/IBMPlexSerif-{s}.otf' for s in ('Regular', 'Italic', 'Bold', 'BoldItalic')))},
    'luciole': {'text': four(*(CTAN + f'luciole/Luciole-{s}.ttf' for s in ('Regular', 'Italic', 'Bold', 'BoldItalic')))},
    'pennstander': {'text': four(*(CTAN + f'pennstander-otf/fonts/Pennstander-{s}.otf' for s in ('Regular', 'ItalicRegular', 'SemiBold', 'ItalicSemiBold')))},
    'arsenal': {'text': four(*(tl(TL_OT + f'arsenal/Arsenal-{s}.otf') for s in ('Regular', 'Italic', 'Bold', 'BoldItalic')))},
    'pl46': {'text': {'regular': CTAN + 'pl46-fonts/PL46-Regular.otf', 'bold': CTAN + 'pl46-fonts/PL46-Bold.otf'}},
}
STYLE = {'regular': ('normal', 400), 'italic': ('italic', 400), 'bold': ('normal', 700), 'bolditalic': ('italic', 700)}

# the text subsets: Latin, and for a Greek face its Greek; other characters come from CMU Serif, which is
# behind every face (it has Greek, Cyrillic and extended Latin)
EXT_FACES = {'neohellenic'}
LATIN = [(0x20, 0x17F), (0x218, 0x21B), (0x2C6, 0x2C7), (0x2D8, 0x2DD), (0x1E9E, 0x1E9E), (0x2000, 0x206F), (0x20AC, 0x20AC),
         (0x2113, 0x2113), (0x2116, 0x2116), (0x2122, 0x2122), (0x2190, 0x2193), (0x2212, 0x2212), (0xFB00, 0xFB04)]
EXT = [(0x300, 0x36F), (0x370, 0x3FF), (0x1F00, 0x1FFF)]

# the math faces: which KaTeX font each one stands in for (its vertical metrics are copied)
KATEX_FONT = {'main': 'Main-Regular', 'it': 'Math-Italic', 'bf': 'Main-Bold', 'bfit': 'Math-BoldItalic', 'cal': 'Caligraphic-Regular',
              'frak': 'Fraktur-Regular', 'bb': 'AMS-Regular', 'sf': 'SansSerif-Regular', 'tt': 'Typewriter-Regular',
              'size1': 'Size1-Regular', 'size2': 'Size2-Regular', 'size3': 'Size3-Regular', 'size4': 'Size4-Regular'}
REFERENCE_ONLY = {'ams': 'AMS-Regular'}
# KaTeX's metrics (fontMetricsData.js) for each face: it adds a glyph's italic correction as margin-right and takes
# it back for a subscript, so a built glyph's advance leaves exactly that much of the font's width to KaTeX
ITALIC_METRICS = {'it': 'Math-Italic', 'bfit': 'Math-BoldItalic', 'cal': 'Caligraphic-Regular'}
FACE_CSS = {'it': ('italic', 400), 'bf': ('normal', 700), 'bfit': ('italic', 700)}  # the style KaTeX's CSS asks for with that class
FACE_SUFFIX = {'main': '', 'it': ' It', 'bf': ' Bf', 'bfit': ' BfIt', 'cal': ' Cal', 'frak': ' Frak', 'bb': ' Bb', 'sf': ' Sf', 'tt': ' Tt',
               'size1': ' S1', 'size2': ' S2', 'size3': ' S3', 'size4': ' S4'}

# main: what KaTeX draws from KaTeX_Main and KaTeX_AMS (their cmaps), and a few symbols they lack that are
# typed as Unicode or reached through macros (≠ ∉ ⊄ ≔ ⟂ …)
MAIN_EXTRA = [0x2260, 0x2262, 0x2209, 0x220C, 0x2224, 0x2226, 0x2244, 0x2247, 0x2249, 0x2254, 0x2255, 0x2270, 0x2271, 0x2284, 0x2285,
              0x2288, 0x2289, 0x22E2, 0x22E3, 0x27C2, 0x2A2F, 0x2A3F, 0x2AFD, 0x2032, 0x2033, 0x2034, 0x2057, 0x221B, 0x221C, 0x2A0C,
              0x222F, 0x2230, 0x2231, 0x2232, 0x2233, 0x2A0D, 0x2A0F, 0x2A16, 0x27E6, 0x27E7, 0x2983, 0x2984, 0x2016, 0x00B6, 0x00A7,
              0x2013, 0x2014, 0x21A9, 0x21AA, 0x22C8, 0x266E, 0x00DE, 0x00FE, 0x2215]
# KaTeX's accent characters (katex/src/functions/accent.js, symbols) → the font's glyph for it, best first
ACCENTS = {0x5E: [0x302, 0x2C6], 0x7E: [0x303, 0x2DC], 0x2C9: [0x304, 0x2C9, 0xAF], 0x2D9: [0x307, 0x2D9], 0xA8: [0x308, 0xA8],
           0x2D8: [0x306, 0x2D8], 0x2C7: [0x30C, 0x2C7], 0x2CA: [0x301, 0xB4, 0x2CA], 0x2CB: [0x300, 0x60, 0x2CB], 0x2DA: [0x30A, 0x2DA]}
NOT_SLASH = 0xE020  # KaTeX_Main's \not
# KaTeX sets primes as superscripts of Computer Modern's big prime (cmsy); a math font's U+2032… are drawn for
# the base line, so they are fitted to KaTeX's glyph box
FIT_MAIN = [0x2032, 0x2033, 0x2034, 0x2035, 0x2036, 0x2037]
CM_X_HEIGHT = 430.554  # KaTeX_Main's x-height, per 1000


def alphabet(upper=None, lower=None, digits=None, exceptions=None, greek_upper=None, greek_lower=None, greek_vars=None):
    m = {}
    for i in range(26):
        if upper is not None:
            m[0x41 + i] = upper + i
        if lower is not None:
            m[0x61 + i] = lower + i
    for i in range(10):
        if digits is not None:
            m[0x30 + i] = digits + i
    for i in range(25):
        if greek_upper is not None and 0x391 + i != 0x3A2:
            m[0x391 + i] = greek_upper + i
        if greek_lower is not None:
            m[0x3B1 + i] = greek_lower + i
    if greek_vars is not None:
        for cp, off in zip((0x3F5, 0x3D1, 0x3F0, 0x3D5, 0x3F1, 0x3D6), range(6)):
            m[cp] = greek_vars + off
    m.update({ord(k): v for k, v in (exceptions or {}).items()})
    return m


ALPHABETS = {
    'it': {**alphabet(0x1D434, 0x1D44E, None, {'h': 0x210E}, 0x1D6E2, 0x1D6FC, 0x1D716), 0x131: 0x1D6A4, 0x237: 0x1D6A5},
    'bf': alphabet(0x1D400, 0x1D41A, 0x1D7CE, None, 0x1D6A8, 0x1D6C2, 0x1D6DC),
    'bfit': alphabet(0x1D468, 0x1D482, 0x1D7CE, None, 0x1D71C, 0x1D736, 0x1D750),
    'cal': alphabet(0x1D49C, 0x1D4B6, None, {'B': 0x212C, 'E': 0x2130, 'F': 0x2131, 'H': 0x210B, 'I': 0x2110, 'L': 0x2112, 'M': 0x2133, 'R': 0x211B,
                                            'e': 0x212F, 'g': 0x210A, 'o': 0x2134}),
    'frak': alphabet(0x1D504, 0x1D51E, None, {'C': 0x212D, 'H': 0x210C, 'I': 0x2111, 'R': 0x211C, 'Z': 0x2128}),
    'bb': alphabet(0x1D538, 0x1D552, 0x1D7D8, {'C': 0x2102, 'H': 0x210D, 'N': 0x2115, 'P': 0x2119, 'Q': 0x211A, 'R': 0x211D, 'Z': 0x2124}),
    'sf': alphabet(0x1D5A0, 0x1D5BA, 0x1D7E2),
    'tt': alphabet(0x1D670, 0x1D68A, 0x1D7F6),
}
# a size face's code point may be encoded elsewhere in the source
SIZE_ALIASES = {0x27E8: [0x2329, 0x3008], 0x27E9: [0x232A, 0x3009], 0x2223: [0x7C], 0x2225: [0x2016], 0x2016: [0x2225]}
SIZE_SKIP = {0x20, 0xA0, 0x2C6, 0x2DC, 0x302, 0x303, 0x221A}  # wide accents and the radical: KaTeX draws those as SVG


# ------------------------------------------------------------------ helpers
def resolve(spec, cache):
    if spec.startswith('tl:'):
        p = os.path.join(TEXMF, spec[3:])
        if not os.path.exists(p):
            sys.exit(f'missing TeX Live font {p}')
        return p
    name = spec.rsplit('/', 1)[1]
    p = os.path.join(cache, name)
    if not os.path.exists(p):
        print('  download', spec)
        os.makedirs(cache, exist_ok=True)
        with urllib.request.urlopen(spec) as r, open(p + '.part', 'wb') as f:
            f.write(r.read())
        os.rename(p + '.part', p)
    return p


def load(spec, cache):
    index = 0
    if isinstance(spec, tuple):
        spec, index = spec
    path = resolve(spec, cache)
    if path.lower().endswith(('.ttc', '.otc')):
        return TTCollection(path).fonts[index]
    return TTFont(path)


def name_strings(font):
    out = {}
    for rec in font['name'].names:
        if rec.nameID in (0, 1, 13, 14) and rec.nameID not in out:
            try:
                out[rec.nameID] = rec.toUnicode().strip()
            except UnicodeDecodeError:
                pass
    return out


def glyph_bounds(glyphset, name):
    bp = BoundsPen(glyphset)
    glyphset[name].draw(bp)
    return bp.bounds


class Reference:
    """KaTeX's own fonts: advance and ink box of each glyph (per 1000), each font's line metrics, and the
    italic corrections of its metrics table."""

    def __init__(self):
        self.italics = {}
        text = open(KATEX_METRICS).read()
        for m in re.finditer(r'"([A-Za-z0-9-]+)": \{(.*?)\n    \}', text, re.S):
            self.italics[m.group(1)] = {int(cp): float(v.split(',')[2]) * 1000 for cp, v in re.findall(r'"(\d+)": \[([^\]]*)\]', m.group(2))}
        self.fonts = {}
        for face, fname in {**KATEX_FONT, **REFERENCE_ONLY}.items():
            f = TTFont(os.path.join(KATEX, f'KaTeX_{fname}.ttf'))
            self.fonts[face] = f

    def cmap(self, face):
        return self.fonts[face].getBestCmap()

    def glyph(self, face, cp):
        f = self.fonts[face]
        g = f.getBestCmap().get(cp)
        if g is None:
            return None
        gs = f.getGlyphSet()
        k = 1000 / f['head'].unitsPerEm
        b = glyph_bounds(gs, g)
        adv = f['hmtx'][g][0] * k
        return adv, (tuple(v * k for v in b) if b else None)

    def line(self, face):
        f = self.fonts[face]
        k = 1000 / f['head'].unitsPerEm
        return round(f['hhea'].ascent * k), round(-f['hhea'].descent * k)


class MathSource:
    def __init__(self, font):
        self.font = font
        self.gs = font.getGlyphSet()
        self.cmap = font.getBestCmap()
        self.upem = font['head'].unitsPerEm
        self.hmtx = font['hmtx']
        self.variants = {}
        mv = font['MATH'].table.MathVariants if 'MATH' in font else None
        if mv is not None and mv.VertGlyphCoverage is not None:
            for g, cons in zip(mv.VertGlyphCoverage.glyphs, mv.VertGlyphConstruction):
                self.variants[g] = [r.VariantGlyph for r in (cons.MathGlyphVariantRecord or [])]
        self.italic = {}
        info = font['MATH'].table.MathGlyphInfo if 'MATH' in font else None
        ic = info.MathItalicsCorrectionInfo if info is not None else None
        if ic is not None and ic.Coverage is not None:
            self.italic = {g: r.Value for g, r in zip(ic.Coverage.glyphs, ic.ItalicsCorrection)}
        x = glyph_bounds(self.gs, self.cmap[ord('x')])
        # font units → output units (per 1000) with the x-height made Computer Modern's
        self.scale = CM_X_HEIGHT / x[3]

    def bounds(self, g):
        return glyph_bounds(self.gs, g)

    def advance(self, g):
        return self.hmtx[g][0]

    def recording(self, g):
        rp = DecomposingRecordingPen(self.gs)
        self.gs[g].draw(rp)
        return rp


def build_face(glyphs, family, line, xheight, names, out):
    """glyphs: [(cp, recording, (a, b, c, d, e, f) transform, advance)] → a CFF-flavoured woff2."""
    order = ['.notdef'] + [f'u{cp:04X}' for cp, *_ in glyphs]
    fb = FontBuilder(1000, isTTF=False)
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap({cp: f'u{cp:04X}' for cp, *_ in glyphs})
    charstrings, metrics = {}, {}
    pen = T2CharStringPen(500, None)
    charstrings['.notdef'] = pen.getCharString()
    metrics['.notdef'] = (500, 0)
    for cp, rec, xf, adv in glyphs:
        name = f'u{cp:04X}'
        adv = max(0, round(adv))
        pen = T2CharStringPen(adv, None)
        rec.replay(TransformPen(pen, xf))
        charstrings[name] = pen.getCharString()
        bp = BoundsPen(None)
        rec.replay(TransformPen(bp, xf))
        metrics[name] = (adv, math.floor(bp.bounds[0]) if bp.bounds else 0)
    ps = family.replace(' ', '')
    fb.setupCFF(ps, {'FullName': family, 'FamilyName': family}, charstrings, {})
    fb.setupHorizontalMetrics(metrics)
    asc, desc = line
    fb.setupHorizontalHeader(ascent=asc, descent=-desc)
    fb.setupNameTable({'familyName': family, 'styleName': 'Regular', 'uniqueFontIdentifier': ps, 'fullName': family, 'psName': ps,
                       'copyright': names.get(0, ''), 'licenseDescription': names.get(13, ''), 'licenseInfoURL': names.get(14, '')})
    fb.setupOS2(sTypoAscender=asc, sTypoDescender=-desc, sTypoLineGap=0, usWinAscent=asc, usWinDescent=desc, sxHeight=round(xheight),
                achVendID='OLYX', fsType=0, fsSelection=0x40 | 0x80, version=4)
    fb.setupPost()
    fb.font.flavor = 'woff2'
    os.makedirs(os.path.dirname(out), exist_ok=True)
    fb.save(out)
    return os.path.getsize(out)


def scaled(s, dx=0.0, dy=0.0):
    return (s, 0, 0, s, dx, dy)


def build_math(mid, spec, cache, ref):
    font = load(spec, cache)
    src = MathSource(font)
    names = name_strings(font)
    s = src.scale
    outdir = os.path.join(OUT, 'math', mid)
    faces = {}

    # main: identity, then the accents and \not
    main = []
    for cp in sorted(set(ref.cmap('main')) | set(ref.cmap('ams')) | set(MAIN_EXTRA)):
        g = src.cmap.get(cp)
        if g is None or cp in ACCENTS or cp in FIT_MAIN or cp < 0x21 or 0xE000 <= cp <= 0xF8FF:
            continue
        main.append((cp, src.recording(g), scaled(s), src.advance(g) * s))
    for kcp in FIT_MAIN:
        g, kg = src.cmap.get(kcp), ref.glyph('main', kcp)
        b = src.bounds(g) if g else None
        if not b or not kg or not kg[1]:
            continue
        kadv, kb = kg
        k = (kb[3] - kb[1]) / (b[3] - b[1])
        main.append((kcp, src.recording(g), scaled(k, (kb[0] + kb[2]) / 2 - k * (b[0] + b[2]) / 2, kb[1] - k * b[1]), kadv))
    for kcp, candidates in ACCENTS.items():
        g = next((src.cmap[c] for c in candidates if c in src.cmap and src.bounds(src.cmap[c])), None)
        kg = ref.glyph('main', kcp)
        if g is None or kg is None or kg[1] is None:
            continue
        kadv, kb = kg
        b = src.bounds(g)
        dx = (kb[0] + kb[2]) / 2 - s * (b[0] + b[2]) / 2
        dy = kb[1] - s * b[1]
        main.append((kcp, src.recording(g), scaled(s, dx, dy), kadv))
    slash = src.cmap.get(0x338) or src.cmap.get(0x2F)
    eq = src.cmap.get(0x3D)
    kn = ref.glyph('main', NOT_SLASH)
    if slash and eq and kn and kn[1] and src.bounds(slash):
        b = src.bounds(slash)
        dx = src.advance(eq) * s / 2 - s * (b[0] + b[2]) / 2
        dy = (kn[1][1] + kn[1][3]) / 2 - s * (b[1] + b[3]) / 2
        main.append((NOT_SLASH, src.recording(slash), scaled(s, dx, dy), 0))
    faces['main'] = main

    # the alphabets
    for face, table in ALPHABETS.items():
        glyphs = []
        italics = ref.italics.get(ITALIC_METRICS.get(face, ''), {})
        for kcp, ucp in table.items():
            g = src.cmap.get(ucp)
            if g is None:
                continue
            adv = (src.advance(g) + src.italic.get(g, 0)) * s
            if italics.get(kcp, 0) > 0:
                adv = max(adv * 0.5, adv - italics[kcp])
            glyphs.append((kcp, src.recording(g), scaled(s), adv))
        faces[face] = glyphs

    # the big operators and delimiters
    for n in (1, 2, 3, 4):
        face = f'size{n}'
        glyphs = []
        for kcp in sorted(ref.cmap(face)):
            if kcp in SIZE_SKIP or 0x239B <= kcp <= 0x23B7 or kcp >= 0xE000:
                continue
            kg = ref.glyph(face, kcp)
            if kg is None or kg[1] is None:
                continue
            kb = kg[1]
            height = kb[3] - kb[1]
            base = next((src.cmap[c] for c in [kcp] + SIZE_ALIASES.get(kcp, []) if c in src.cmap), None)
            if base is None:
                continue
            best = None
            for g in [base] + src.variants.get(base, []):
                b = src.bounds(g)
                if not b or b[3] <= b[1]:
                    continue
                ratio = height / ((b[3] - b[1]) * s)
                if best is None or abs(math.log(ratio)) < abs(math.log(best[1])):
                    best = (g, ratio, b)
            if best is None or not (0.6 < best[1] < 1.7):
                continue
            g, ratio, b = best
            k = s * ratio
            dy = (kb[1] + kb[3]) / 2 - k * (b[1] + b[3]) / 2
            adv = src.advance(g)
            italic = src.italic.get(g, 0)
            if italic > 0:
                # KaTeX's operators (Computer Modern's) overhang their advance by the italic correction, which
                # it adds for the limits; an OpenType operator's advance covers it
                adv = min(adv, b[2] - italic + max(b[0], 0))
            glyphs.append((kcp, src.recording(g), scaled(k, 0, dy), adv * k))
        faces[face] = glyphs

    sizes = {}
    for face, glyphs in faces.items():
        if not glyphs:
            continue
        family = f'OLM {mid}{FACE_SUFFIX[face]}'
        sizes[face] = build_face(glyphs, family, ref.line(face), CM_X_HEIGHT, names, os.path.join(outdir, f'{face}.woff2'))
    return sizes, names


def instance(font, location):
    if location:
        font = instancer.instantiateVariableFont(font, location)
    return font


def ranges_css(ranges):
    return ', '.join(f'U+{lo:04X}' if lo == hi else f'U+{lo:04X}-{hi:04X}' for lo, hi in ranges)


def rename(font, family, style):
    name = font['name']
    ps = (family + '-' + style).replace(' ', '')
    for rec in list(name.names):
        if rec.nameID in (1, 2, 3, 4, 6, 16, 17, 21, 22, 25):
            name.removeNames(nameID=rec.nameID)
    name.setName(family, 1, 3, 1, 0x409)
    name.setName(style, 2, 3, 1, 0x409)
    name.setName(ps, 3, 3, 1, 0x409)
    name.setName(family + ' ' + style, 4, 3, 1, 0x409)
    name.setName(ps, 6, 3, 1, 0x409)
    if 'CFF ' in font:
        cff = font['CFF '].cff
        cff.fontNames = [ps]
        top = cff.topDictIndex[0]
        top.FullName = family + ' ' + style
        top.FamilyName = family


def build_text(tid, roles, cache):
    rules, names, xh, total = [], None, None, 0
    for role, styles in roles.items():
        family = f'OLT {tid}' + ('' if role == 'text' else f' {role}')
        for style, spec in styles.items():
            location = None
            if isinstance(spec, tuple) and isinstance(spec[1], dict):
                spec, location = spec
            base = instance(load(spec, cache), location)
            if role == 'text' and style == 'regular':
                names = name_strings(base)
                b = glyph_bounds(base.getGlyphSet(), base.getBestCmap()[ord('x')])
                xh = b[3] / base['head'].unitsPerEm
            cmap = base.getBestCmap()
            for part, ranges in (('latin', LATIN), ('ext', EXT)):
                cps = [cp for lo, hi in ranges for cp in range(lo, hi + 1) if cp in cmap]
                if part == 'ext' and (tid not in EXT_FACES or len(cps) < 20):
                    continue
                font = instance(load(spec, cache), location)
                opts = subset.Options()
                opts.layout_features += ['onum', 'lnum', 'pnum', 'tnum']  # the defaults (kerning, ligatures, marks) and figures
                opts.hinting = False
                opts.desubroutinize = True
                opts.name_IDs = ['*']
                opts.name_languages = [0x409]
                opts.notdef_outline = True
                opts.drop_tables += ['DSIG', 'MATH']
                opts.flavor = 'woff2'
                sub = subset.Subsetter(opts)
                sub.populate(unicodes=cps)
                sub.subset(font)
                rename(font, family, style)
                font.flavor = 'woff2'
                rel = f'text/{tid}/{role}-{style}-{part}.woff2'
                out = os.path.join(OUT, rel)
                os.makedirs(os.path.dirname(out), exist_ok=True)
                font.save(out)
                total += os.path.getsize(out)
                fs, fw = STYLE[style]
                rules.append(f'@font-face {{ font-family: "{family}"; src: url("./{rel}") format("woff2"); font-style: {fs}; font-weight: {fw}; font-display: swap; unicode-range: {ranges_css(ranges)}; }}')
    return rules, names, xh, total


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cache', default=os.path.expanduser('~/.cache/overlyx-fonts'))
    ap.add_argument('--only', default='')
    ap.add_argument('--missing', action='store_true', help='only the fonts not built yet (build-state.json)')
    args = ap.parse_args()
    only = set(filter(None, args.only.split(',')))
    ref = Reference()
    state_path = os.path.join(OUT, 'build-state.json')
    state = json.load(open(state_path)) if os.path.exists(state_path) else {'math': {}, 'text': {}}

    for mid, spec in MATH.items():
        if only and f'math:{mid}' not in only and mid not in only or args.missing and mid in state['math']:
            continue
        print('math', mid)
        sizes, names = build_math(mid, spec, args.cache, ref)
        state['math'][mid] = {'faces': sorted(sizes), 'bytes': sum(sizes.values()), 'names': names}
        json.dump(state, open(state_path, 'w'), indent=1, sort_keys=True)
    for tid, roles in TEXT.items():
        if only and f'text:{tid}' not in only and tid not in only or args.missing and tid in state['text']:
            continue
        print('text', tid)
        rules, names, xh, total = build_text(tid, roles, args.cache)
        state['text'][tid] = {'rules': rules, 'xHeight': round(xh, 4), 'bytes': total, 'names': names}
        json.dump(state, open(state_path, 'w'), indent=1, sort_keys=True)

    state['math'] = {k: v for k, v in state['math'].items() if k in MATH}
    state['text'] = {k: v for k, v in state['text'].items() if k in TEXT}
    css = ['/* Generated by scripts/build-editor-fonts.py — do not edit. The editor\'s text faces ("OLT <id>") and math fonts',
           '   ("OLM <id> <face>"), fonts/catalog.ts; a browser fetches a file only when text on the page uses it. */']
    for tid in TEXT:
        css.extend(state['text'].get(tid, {}).get('rules', []))
    for mid in MATH:
        for face in state['math'].get(mid, {}).get('faces', []):
            fs, fw = FACE_CSS.get(face, ('normal', 400))
            family = f'OLM {mid}{FACE_SUFFIX[face]}'
            url = f'./math/{mid}/{face}.woff2'
            css.append(f'@font-face {{ font-family: "{family}"; src: url("{url}") format("woff2"); font-style: {fs}; font-weight: {fw}; font-display: swap; }}')
            if face == 'main':
                # \\mathbb-like AMS symbols (.amsrm) must not take the upright ASCII letters
                css.append(f'@font-face {{ font-family: "OLM {mid} AMS"; src: url("{url}") format("woff2"); font-display: swap; unicode-range: U+00A0-10FFFF; }}')
    with open(os.path.join(OUT, 'webfonts.css'), 'w') as f:
        f.write('\n'.join(css) + '\n')

    xh = {tid: state['text'][tid]['xHeight'] for tid in TEXT if tid in state['text']}
    with open(os.path.join(OUT, 'metrics.gen.ts'), 'w') as f:
        f.write('/** Generated by scripts/build-editor-fonts.py — do not edit. */\n\n')
        f.write('/** x-height (em) of each self-hosted text face (fonts/web/text), for the size of formulas */\n')
        f.write('export const TEXT_X_HEIGHT: Record<string, number> = ' + json.dumps(xh, indent=2).replace('"', "'") + ';\n\n')
        faces = {mid: state['math'][mid]['faces'] for mid in MATH if mid in state['math']}
        f.write('/** the faces built for each math font (fonts/web/math) */\n')
        f.write('export const MATH_FACES: Record<string, string[]> = ' + json.dumps(faces).replace('"', "'") + ';\n')

    with open(LICENSES, 'w') as f:
        f.write('Fonts of the OverLyX editor (Settings ▸ Editor ▸ Text font / Math font)\n')
        f.write('=' * 72 + '\n\n')
        f.write('The editor serves these fonts as web fonts, subset and (for the math fonts) rearranged for KaTeX by\n'
                'scripts/build-editor-fonts.py, under family names of its own. Each file keeps its copyright and licence\n'
                'notices. The licences: SIL Open Font License 1.1 (OFL.txt below, https://openfontlicense.org), GUST Font\n'
                'License (Latin Modern, TeX Gyre, New Computer Modern: https://www.gust.org.pl/projects/e-foundry/licenses),\n'
                'Bitstream Charter and Bitstream Vera licences (XCharter, DejaVu), CC BY 4.0 (Luciole).\n\n')
        for kind in ('math', 'text'):
            for fid, info in sorted(state[kind].items()):
                n = info.get('names') or {}
                f.write(f'{kind} {fid}: {n.get(1, "")}\n')
                for key in (0, 13, 14):
                    if n.get(key):
                        f.write('  ' + n[key].replace('\n', '\n  ') + '\n')
                f.write('\n')
        ofl = os.path.join(ROOT, 'packages/client/public/licenses/firamath-OFL.txt')
        text = open(ofl).read()
        i = text.find('SIL OPEN FONT LICENSE')
        f.write('-' * 72 + '\nOFL.txt\n\n' + (text[i:] if i >= 0 else text))

    json.dump(state, open(state_path, 'w'), indent=1, sort_keys=True)
    tm = sum(v['bytes'] for v in state['math'].values())
    tt = sum(v['bytes'] for v in state['text'].values())
    print(f'math {tm / 1e6:.2f} MB, text {tt / 1e6:.2f} MB')


if __name__ == '__main__':
    main()

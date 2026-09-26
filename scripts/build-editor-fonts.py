#!/usr/bin/env python3
"""
Builds the editor's text fonts (Settings ▸ Editor ▸ Text font; the catalogue is
packages/client/src/fonts/catalog.ts) into packages/client/src/fonts/web/:

  text/<id>/<style>-<part>.woff2   a text face, subset into a Latin part and a Greek/Cyrillic part
                                   (unicode-range, so the second is fetched only when needed)
  webfonts.css                     the @font-face rules (families "OLT <id>…")
  metrics.gen.ts                   the x-height of every text face (formulas are scaled to it)

Formulas are MathJax's, in MathJax's own fonts (editor/lyxmath/mathfonts.ts): no math font is built
here any more (until 26 Sep 2026 this script took OpenType math fonts apart into stand-ins for
KaTeX's fonts).

Family names are our own (OFL "Reserved Font Names"); every file keeps its source's copyright and
licence strings, collected in packages/client/public/licenses/editor-fonts.txt.

Requires fontTools and brotli (`pip install fonttools brotli`), TeX Live for most sources (the rest
are downloaded from CTAN / google/fonts into --cache). Usage:
python3 scripts/build-editor-fonts.py [--cache DIR] [--only id,id] [--missing]
"""
import argparse
import json
import os
import re
import subprocess
import sys
import urllib.request

from fontTools import subset
from fontTools.pens.boundsPen import BoundsPen
from fontTools.ttLib import TTCollection, TTFont
from fontTools.varLib import instancer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'packages/client/src/fonts/web')
LICENSES = os.path.join(ROOT, 'packages/client/public/licenses/editor-fonts.txt')
CTAN = 'https://ftp.fau.de/ctan/fonts/'  # any CTAN mirror
GF = 'https://raw.githubusercontent.com/google/fonts/main/ofl/'

try:
    TEXMF = subprocess.run(['kpsewhich', '-var-value', 'TEXMFDIST'], capture_output=True, text=True).stdout.strip()
except OSError:
    TEXMF = ''
TEXMF = TEXMF or '/usr/share/texlive/texmf-dist'


def tl(p):
    return 'tl:fonts/' + p


# ------------------------------------------------------------------ sources
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
    state_path = os.path.join(OUT, 'build-state.json')
    state = json.load(open(state_path)) if os.path.exists(state_path) else {'text': {}}
    state.pop('math', None)
    for tid, roles in TEXT.items():
        if only and f'text:{tid}' not in only and tid not in only or args.missing and tid in state['text']:
            continue
        print('text', tid)
        rules, names, xh, total = build_text(tid, roles, args.cache)
        state['text'][tid] = {'rules': rules, 'xHeight': round(xh, 4), 'bytes': total, 'names': names}
        json.dump(state, open(state_path, 'w'), indent=1, sort_keys=True)

    state['text'] = {k: v for k, v in state['text'].items() if k in TEXT}
    css = ['/* Generated by scripts/build-editor-fonts.py — do not edit. The editor\'s text faces ("OLT <id>"),',
           '   fonts/catalog.ts; a browser fetches a file only when text on the page uses it. */']
    for tid in TEXT:
        css.extend(state['text'].get(tid, {}).get('rules', []))
    with open(os.path.join(OUT, 'webfonts.css'), 'w') as f:
        f.write('\n'.join(css) + '\n')

    xh = {tid: state['text'][tid]['xHeight'] for tid in TEXT if tid in state['text']}
    with open(os.path.join(OUT, 'metrics.gen.ts'), 'w') as f:
        f.write('/** Generated by scripts/build-editor-fonts.py — do not edit. */\n\n')
        f.write('/** x-height (em) of each self-hosted text face (fonts/web/text), for the size of formulas */\n')
        f.write('export const TEXT_X_HEIGHT: Record<string, number> = ' + json.dumps(xh, indent=2).replace('"', "'") + ';\n')

    with open(LICENSES, 'w') as f:
        f.write('Text fonts of the OverLyX editor (Settings ▸ Editor ▸ Text font)\n')
        f.write('=' * 72 + '\n\n')
        f.write('The editor serves these fonts as web fonts, subset by scripts/build-editor-fonts.py, under family\n'
                'names of its own (the math fonts are MathJax\'s: licenses/mathjax.txt). Each file keeps its copyright and licence\n'
                'notices. The licences: SIL Open Font License 1.1 (OFL.txt below, https://openfontlicense.org), GUST Font\n'
                'License (Latin Modern, TeX Gyre, New Computer Modern: https://www.gust.org.pl/projects/e-foundry/licenses),\n'
                'Bitstream Charter and Bitstream Vera licences (XCharter, DejaVu), CC BY 4.0 (Luciole).\n\n')
        for fid, info in sorted(state['text'].items()):
            n = info.get('names') or {}
            f.write(f'text {fid}: {n.get(1, "")}\n')
            for key in (0, 13, 14):
                if n.get(key):
                    f.write('  ' + n[key].replace('\n', '\n  ') + '\n')
            f.write('\n')
        ofl = os.path.join(ROOT, 'packages/client/public/licenses/firamath-OFL.txt')
        text = open(ofl).read()
        i = text.find('SIL OPEN FONT LICENSE')
        f.write('-' * 72 + '\nOFL.txt\n\n' + (text[i:] if i >= 0 else text))

    json.dump(state, open(state_path, 'w'), indent=1, sort_keys=True)
    tt = sum(v['bytes'] for v in state['text'].values())
    print(f'text {tt / 1e6:.2f} MB')


if __name__ == '__main__':
    main()

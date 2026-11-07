#!/usr/bin/env python3
"""Embed the existing open fonts so each scientific starter remains a single portable HTML file."""
from pathlib import Path
import base64
import json

root = Path(__file__).resolve().parent.parent
fonts = root / 'packages/client/src/fonts'
faces = {}
assets = '../../../core/src/html/template-assets/'
# (family, weight or weight range, style, stretch range or None, file): variable faces declare their axes' ranges
for family, weight, style, stretch, rel in [
    # Instrument Sans: the full variable faces (width 75-100 %, weight 400-700), only converted to WOFF2
    ('Instrument Sans', '400 700', 'normal', '75% 100%', assets + 'InstrumentSans-Roman.woff2'),
    ('Instrument Sans', '400 700', 'italic', '75% 100%', assets + 'InstrumentSans-Italic.woff2'),
    ('Carlito', 400, 'normal', None, assets + 'Carlito-400.woff2'),
    ('Carlito', 700, 'normal', None, assets + 'Carlito-700.woff2'),
    ('Fira Sans', 400, 'normal', None, 'web/text/fira/text-regular-latin.woff2'),
    ('Fira Sans', 300, 'normal', None, assets + 'FiraSans-Light.woff2'),
    ('Fira Sans', 700, 'normal', None, 'web/text/fira/text-bold-latin.woff2'),
    ('CMU Sans', 400, 'normal', None, 'computer-modern/cmunss.otf'),
    ('CMU Sans', 700, 'normal', None, 'computer-modern/cmunsx.otf'),
    # DejaVu Sans: fonts-dejavu-core 2.37, subset (Latin, Greek, punctuation, arrows, operators); see DejaVu-LICENSE.txt
    ('DejaVu Sans', 400, 'normal', None, assets + 'DejaVuSans-Regular.woff2'),
    ('DejaVu Sans', 700, 'normal', None, assets + 'DejaVuSans-Bold.woff2'),
    ('DejaVu Sans', 400, 'italic', None, assets + 'DejaVuSans-Oblique.woff2'),
    ('DejaVu Sans', 700, 'italic', None, assets + 'DejaVuSans-BoldOblique.woff2'),
]:
    file = fonts / rel
    mime, fmt = ('font/woff2', 'woff2') if file.suffix == '.woff2' else ('font/otf', 'opentype')
    data = base64.b64encode(file.read_bytes()).decode()
    axes = f'font-stretch:{stretch};' if stretch else ''
    faces.setdefault(family, []).append(f'@font-face{{font-family:"{family}";font-weight:{weight};font-style:{style};{axes}font-display:block;src:url(data:{mime};base64,{data}) format("{fmt}");}}')
license_text = (
    'Instrument Sans: ' + (root / 'packages/core/src/html/template-assets/InstrumentSans-OFL.txt').read_text() + '\n'
    + (root / 'packages/core/src/html/template-assets/Carlito-OFL.txt').read_text()
    + '\nFira Sans: Digitized data copyright 2012-2018, The Mozilla Foundation and Telefonica S.A., bBox Type GmbH and Carrois Corporate GbR, with Reserved Font Name Fira. SIL OFL 1.1.\n'
    + (root / 'packages/client/public/licenses/cm-unicode-OFL.txt').read_text()
    + '\n' + (root / 'packages/core/src/html/template-assets/DejaVu-LICENSE.txt').read_text()
)
dest = root / 'packages/core/src/html/scientific-fonts.ts'
dest.write_text('// Generated from the bundled open fonts by scripts/gen-template-fonts.py.\n'
                '// Instrument Sans, Carlito, Fira Sans and CMU Sans: SIL Open Font License 1.1; DejaVu Sans: Bitstream Vera and Arev licences.\n'
                'export const TEMPLATE_FONTS: Record<string, string> = '
                + json.dumps({k: '\n'.join(v) for k, v in faces.items()}, indent=2) + ';\n'
                + 'export const TEMPLATE_FONT_LICENSE = '
                + json.dumps('\n'.join(line.rstrip() for line in license_text.splitlines()) + '\n') + ';\n')

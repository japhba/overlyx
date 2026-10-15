#!/usr/bin/env python3
"""Embed the existing open fonts so each scientific starter remains a single portable HTML file."""
from pathlib import Path
import base64
import json

root = Path(__file__).resolve().parent.parent
fonts = root / 'packages/client/src/fonts'
faces = {}
for family, weight, rel in [
    ('Carlito', 400, '../../../core/src/html/template-assets/Carlito-400.woff2'),
    ('Carlito', 700, '../../../core/src/html/template-assets/Carlito-700.woff2'),
    ('Fira Sans', 400, 'web/text/fira/text-regular-latin.woff2'),
    ('Fira Sans', 300, '../../../core/src/html/template-assets/FiraSans-Light.woff2'),
    ('Fira Sans', 700, 'web/text/fira/text-bold-latin.woff2'),
    ('CMU Sans', 400, 'computer-modern/cmunss.otf'),
    ('CMU Sans', 700, 'computer-modern/cmunsx.otf'),
]:
    file = fonts / rel
    mime, fmt = ('font/woff2', 'woff2') if file.suffix == '.woff2' else ('font/otf', 'opentype')
    data = base64.b64encode(file.read_bytes()).decode()
    faces.setdefault(family, []).append(f'@font-face{{font-family:"{family}";font-weight:{weight};font-style:normal;font-display:block;src:url(data:{mime};base64,{data}) format("{fmt}");}}')
license_text = (
    (root / 'packages/core/src/html/template-assets/Carlito-OFL.txt').read_text()
    + '\nFira Sans: Digitized data copyright 2012-2018, The Mozilla Foundation and Telefonica S.A., bBox Type GmbH and Carrois Corporate GbR, with Reserved Font Name Fira. SIL OFL 1.1.\n'
    + (root / 'packages/client/public/licenses/cm-unicode-OFL.txt').read_text()
)
dest = root / 'packages/core/src/html/scientific-fonts.ts'
dest.write_text('// Generated from the bundled open fonts by scripts/gen-template-fonts.py.\n'
                '// Carlito, Fira Sans and CMU Sans: SIL Open Font License 1.1; see bundled font metadata.\n'
                'export const TEMPLATE_FONTS: Record<string, string> = '
                + json.dumps({k: '\n'.join(v) for k, v in faces.items()}, indent=2) + ';\n'
                + 'export const TEMPLATE_FONT_LICENSE = '
                + json.dumps('\n'.join(line.rstrip() for line in license_text.splitlines()) + '\n') + ';\n')

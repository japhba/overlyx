#!/usr/bin/env python3
"""The app icons as PNG, from packages/client/public/icon.svg (run again after changing it).

iOS's home screen (apple-touch-icon) and Android's launcher (the manifest) take no SVG. Drawn in the
light scheme on a square of the disc's colour: iOS fills a transparent corner with black, and a
maskable icon has to fill its square (the ring and the letters stay inside its safe circle).
Needs rsvg-convert (librsvg).
"""
import re
import subprocess
import tempfile
from pathlib import Path

PUBLIC = Path(__file__).resolve().parent.parent / 'packages/client/public'
SIZES = {'apple-touch-icon.png': 180, 'icon-192.png': 192, 'icon-512.png': 512}

svg = (PUBLIC / 'icon.svg').read_text()
# the light scheme only (librsvg does not ask for the colour scheme)
light = re.sub(r'@media\s*\(prefers-color-scheme:\s*dark\)\s*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}', '', svg)
disc = re.search(r'\.disc\s*\{\s*fill:\s*(#[0-9a-fA-F]{3,8})', light)
background = disc.group(1) if disc else '#ffffff'

with tempfile.TemporaryDirectory() as tmp:
    src = Path(tmp) / 'icon.svg'
    src.write_text(light)
    for name, size in SIZES.items():
        subprocess.run(['rsvg-convert', '-w', str(size), '-h', str(size), '-b', background, '-o', str(PUBLIC / name), str(src)], check=True)
        print(f'{name}: {size} px')

#!/bin/sh
# fonts/anodyne from a checkout of Anodyne's own repository (github.com/japhba/anodyne, where the font is
# built: `make release` there writes fonts/variable, fonts/static and fonts/webfonts). The web files are
# copied as they are; the TeX files are made by that repository's sources/build.py install step (the
# static faces and "Anodyne Variable" without the Indic, Thai and CJK shaping), then the MathJax font and
# the decks' embedded faces are regenerated from them. Takes ~5 min and well under 1 GB.
#
#   scripts/anodyne/install.sh <anodyne checkout>
# fontTools and brotli on PYTHONPATH (default /mnt/HC_Volume_107166861/jan/pylib).
set -eu
src=$(cd "$1" && pwd)
repo=$(cd "$(dirname "$0")/../.." && pwd)
export PYTHONPATH="${PYTHONPATH:-/mnt/HC_Volume_107166861/jan/pylib}"
# the fonts' timestamps from the Anodyne commit: the same checkout gives the same files
export SOURCE_DATE_EPOCH="$(git -C "$src" log -1 --format=%ct)"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/flat"
cp "$src"/fonts/variable/*.ttf "$src"/fonts/static/*.ttf "$src/OFL.txt" "$work/flat/"
python3 "$src/sources/build.py" --lisnoti - --noto - --install-only --out "$work/flat" --repo "$work/served"
cp "$src"/fonts/webfonts/* "$repo/fonts/anodyne/web/"
rm -f "$repo"/fonts/anodyne/tex/*
cp "$work"/served/tex/* "$repo/fonts/anodyne/tex/"
cp "$src/OFL.txt" "$repo/fonts/anodyne/OFL.txt"
cd "$repo"
t=fonts/anodyne/tex
python3 scripts/build-mathjax-font.py --id anodyne --prefix ANOD --name Anodyne --math $t/Anodyne-Regular.ttf \
  --bold $t/Anodyne-Bold.ttf --italic $t/Anodyne-Italic.ttf --bold-italic $t/Anodyne-BoldItalic.ttf
python3 scripts/gen-template-fonts.py
echo "Anodyne $(git -C "$src" describe --always) installed: commit fonts/anodyne, packages/client/src/fonts/@mathjax/mathjax-anodyne-font, packages/core/src/html/scientific-fonts.ts"

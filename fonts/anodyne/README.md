# Anodyne

OverLyX's sans-serif: the interface's font, an editor face (Settings ▸ Editor ▸ Text font), a deck
font, and a font documents can name (`\setsansfont{Anodyne}`, `\setmathfont{Anodyne}`, a markdown
document's `sansfont:`, the toolbar's font list). SIL Open Font License 1.1 (`OFL.txt`).

Anodyne is a fork of [Lisnoti](https://github.com/Lisnoti/Lisnoti) 2.006 by Tim Gordon, itself Noto
Sans with the characters that get confused in maths, science and code redrawn (I l 1, O 0, the
operators on one maths axis, brackets, α), Noto Sans Math's formula machinery in the same file (an
OpenType MATH table) and many more symbols. "Lisnoti" is a Reserved Font Name, so a changed version
needs another name. What Anodyne changes:

- **Weight, 100–900** (`wght`), one variable font per style. Glyphs Lisnoti kept from Noto Sans use
  Noto Sans's own masters (Thin, Bold, Black; Noto's avar, so every weight is Noto's design). Glyphs
  Lisnoti redrew or added use Lisnoti Bold as their 700 master, made point-compatible with the
  Regular: contours matched, nodes aligned along each contour, the other master's extra nodes
  inserted at the same arc-length fraction, each run refitted as a cubic and converted with cu2qu's
  multi-master conversion (as fontmake does); Thin and Black extrapolated at Noto's stem ratios. About
  5 % (rare symbols whose Bold has other contours) are emboldened point by point instead.
- **Grade, −100–150** (`GRAD`): the stems of weight 400+GRAD at the widths of 400, so text darkens or
  lightens without moving. OverLyX takes 25 off in the dark theme and lets each browser set its own
  (Settings ▸ Appearance ▸ Text grade).
- **Small capitals** (`smcp`, `c2sc`) again, for `\textsc` and small-caps headings.

Files: `web/` the variable fonts as woff2 by Unicode range with `anodyne.css` (the client imports it;
the server serves the same files to decks and frames), `tex/` static Regular, Bold, Italic and Bold
Italic at grade 0 with the MATH table (LuaLaTeX; the server copies them into a build that names
Anodyne).

Rebuild (≈11 min; fontTools and brotli on `PYTHONPATH`):

    python3 scripts/anodyne/build.py --lisnoti <Lisnoti>/font-Lisnoti/Lisnoti-ttf \
      --noto <dir with NotoSans[wdth,wght].ttf, NotoSans-Italic[wdth,wght].ttf from google/fonts ofl/notosans> \
      --out <scratch dir> --repo fonts/anodyne

Keep the Unicode ranges of `scripts/anodyne/build.py` (`WEB_RANGES`) and
`packages/server/src/googlefonts.ts` (`ANODYNE_RANGES`) the same.

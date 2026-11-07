# Anodyne

OverLyX's sans-serif, published on its own at https://github.com/japhba/anodyne (with a demo page,
https://japhba.github.io/anodyne/): the interface's font, an editor face (Settings ▸ Editor ▸ Text font), a deck
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
- **Width, 62.5–100** (`wdth`): Noto Sans's own condensed masters for the glyphs Lisnoti kept from
  Noto; Lisnoti's redrawn and added glyphs squeezed to Noto's width at each weight master, their stems
  brought back horizontally to Noto's condensed stems (no condensed drawing of them exists).
- **Grade, −100–150** (`GRAD`): the stems of weight 400+GRAD at the widths of 400, so text darkens or
  lightens without moving. OverLyX takes 25 off in the dark theme and lets each browser set its own
  (Settings ▸ Appearance ▸ Text grade).
- **Features Lisnoti dropped but kept the glyphs of**: small capitals (`smcp`, `c2sc`, for `\textsc`
  and small-caps headings), old-style, proportional, tabular and lining figures (the zero stays
  slashed), case forms (not for figures and the maths-axis brackets), the Greek alternates (`ss06`,
  `ss07`), and Noto Sans Math's dotless i and j for accents (`dtls`).

Files: `web/` the variable fonts as woff2 by Unicode range with `anodyne.css` (the client imports it;
the server serves the same files to decks and frames). `tex/`, for LuaLaTeX (the server copies them
into a build that names Anodyne), without the Indic, Thai and CJK shaping Lisnoti carries:
- `Anodyne-{Regular,Bold,Italic,BoldItalic}.ttf`, static, normal width, grade 0, with the MATH table:
  what a plain `\setmainfont{Anodyne}` / `\setmathfont{Anodyne}` finds by name;
- `AnodyneVariable{,-Italic}.ttf`, family "Anodyne Variable": the text as a variable font, which
  `\olfont` takes for any weight, width and grade (core fontface.ts).

LuaTeX caches a font the first time a build loads it; Anodyne's faces take ~0.8 GB each to cache, all
at once more than a build may use (2.5 GB), so a build first loads each face its HOME has not cached,
one per run (googlefonts.ts `houseFontWarmups`). With the caches, a document using all of it takes
~1.3 GB.

Rebuild (≈15 min, ~2.8 GB a style: run it as its own unit, `systemd-run --user --collect
-p MemoryMax=3200M …`, one style per process with `--only roman` / `--only italic`, then `--install-only`;
fontTools and brotli on `PYTHONPATH`):

    python3 scripts/anodyne/build.py --lisnoti <Lisnoti>/font-Lisnoti/Lisnoti-ttf \
      --noto <dir with NotoSans[wdth,wght].ttf, NotoSans-Italic[wdth,wght].ttf, NotoSansMath-Regular.ttf> \
      --out <scratch dir> --repo fonts/anodyne

Keep the Unicode ranges of `scripts/anodyne/build.py` (`WEB_RANGES`) and
`packages/server/src/googlefonts.ts` (`ANODYNE_RANGES`) the same.

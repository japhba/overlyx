# Third-party notices

OverLyX for VS Code is licensed under the GNU General Public License v3.0 or later (see LICENSE).
It contains, or is a derivative of, the following third-party material:

- **LyX** (https://www.lyx.org) — GPL-2.0-or-later. The bundled `lyxlib/` data (layout files,
  `languages`, `unicodesymbols`, `symbols`, `latexfonts`) and the toolbar icons
  (`webview/lyxicons/`, from LyX `lib/images`) come from the LyX distribution, and parts of the
  editing engine are TypeScript ports of LyX source code (math parser/writer/cursor, LaTeX
  export). LyX is a trademark of the LyX team; this project is not affiliated with or endorsed by
  the LyX team.
- **MathJax 4** (https://www.mathjax.org) — Apache-2.0. Formula rendering, with MathJax's fonts
  (New Computer Modern, Latin Modern, MathJax TeX, STIX Two, TeX Gyre, Asana, Fira Math, Euler; their
  OpenType sources under the GUST Font License and the SIL OFL 1.1). OverLyX adds TeX commands of its
  own. Licence and font credits: `dist/webview/licenses/mathjax.txt`.
- **pdf.js** (https://mozilla.github.io/pdf.js/) — Apache-2.0. The PDF panel viewer.
- **ProseMirror** (https://prosemirror.net) — MIT. The rich-text editing framework.
- **Yjs / y-prosemirror / y-protocols / lib0** — MIT.
- **Preact** — MIT.
- **nspell** (https://github.com/wooorm/nspell) — MIT. Hunspell-style spell checking.
- **Spell-checker dictionaries** (`dict/`): `dictionary-en`, `dictionary-en-gb` (BSD-style /
  SCOWL licenses), `dictionary-de` (igerman98, GPL-2.0 or GPL-3.0), `dictionary-fr` (MPL-2.0).
- **IBM Plex** — SIL OFL 1.1.
- **Computer Modern Unicode / CMU Serif** (https://ctan.org/pkg/cm-unicode) — SIL OFL 1.1.
  Unmodified Roman, bold, italic and bold italic text fonts; copyright the original Metafont
  authors and Andrey V. Panov. Full license and copyright notices: `dist/webview/licenses/cm-unicode-OFL.txt`.
- **Editor text fonts** (Settings ▸ Editor ▸ Text font) — the text faces of `fonts/web` (New Computer
  Modern, STIX Two, XITS, Libertinus, TeX Gyre, Charis SIL, XCharter, Erewhon, Kp, Concrete, Old Standard,
  GFS Neohellenic, IBM Plex, PL46, Fira, Lato, Noto Sans, Arsenal, Luciole, Pennstander, DejaVu, Crimson Pro,
  EB Garamond), subset by `scripts/build-editor-fonts.py` under family names of their own. SIL OFL 1.1,
  GUST Font License, the Bitstream Charter and Vera licences and CC BY 4.0 (Luciole). Every font's
  copyright and licence: `dist/webview/licenses/editor-fonts.txt`.

Corresponding source: the extension is built from the OverLyX source tree. A copy of the
complete corresponding source for any released .vsix is available to anyone on request —
open an issue at https://github.com/japhba/overlyx, or contact the maintainer via https://overlyx.app
(Help ▸ Report a problem).

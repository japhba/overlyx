# Third-party notices

OverLyX for VS Code is licensed under the GNU General Public License v3.0 or later (see LICENSE).
It contains, or is a derivative of, the following third-party material:

- **LyX** (https://www.lyx.org) — GPL-2.0-or-later. The bundled `lyxlib/` data (layout files,
  `languages`, `unicodesymbols`, `symbols`, `latexfonts`) and the toolbar icons
  (`webview/lyxicons/`, from LyX `lib/images`) come from the LyX distribution, and parts of the
  editing engine are TypeScript ports of LyX source code (math parser/writer/cursor, LaTeX
  export). LyX is a trademark of the LyX team; this project is not affiliated with or endorsed by
  the LyX team.
- **KaTeX** (https://katex.org) — MIT. Formula rendering; portions of the math renderer are
  adapted from KaTeX source.
- **pdf.js** (https://mozilla.github.io/pdf.js/) — Apache-2.0. The PDF panel viewer.
- **ProseMirror** (https://prosemirror.net) — MIT. The rich-text editing framework.
- **Yjs / y-prosemirror / y-protocols / lib0** — MIT.
- **Preact** — MIT.
- **nspell** (https://github.com/wooorm/nspell) — MIT. Hunspell-style spell checking.
- **Spell-checker dictionaries** (`dict/`): `dictionary-en`, `dictionary-en-gb` (BSD-style /
  SCOWL licenses), `dictionary-de` (igerman98, GPL-2.0 or GPL-3.0), `dictionary-fr` (MPL-2.0).
- **IBM Plex / KaTeX fonts** — SIL OFL 1.1.

Corresponding source: the extension is built from the OverLyX source tree. A copy of the
complete corresponding source for any released .vsix is available to anyone on request —
open an issue at https://github.com/japhba/overlyx, or contact the maintainer via https://overlyx.app
(Help ▸ Report a problem).

# OverLyX

A web-based, LyX-compatible, collaborative WYSIWYG editor for LaTeX documents — an
Overleaf/LyX blend.

* **Native `.lyx` files are the source of truth.** Documents are parsed and written back
  byte-for-byte compatible with LyX 2.4/2.5 (`\lyxformat` ≥ 620): you can keep using desktop
  LyX on the same files; external saves are picked up live.
* **WYSIWYG without compiling.** Text, insets, floats, tables and math render as you type.
  Formulas (inline and display, `equation`/`align`/`gather`/`multline`/…) are edited in place
  with KaTeX; document macros (`FormulaMacro` insets, preamble `\newcommand`/`\def`,
  `\input{macros}` files, child documents) render immediately.
* **Multi-user editing** (Yjs CRDT, per-user undo, live cursors) with automatic and named
  **versions** (diff & restore).
* **Notes and comments**: LyX notes (Note / Comment / Greyed out) render like LyX; OverLyX
  comment threads (author, time, replies, resolve) are stored as ordinary `Note Comment` insets so
  LyX users see them too. *View ▸ Notes & comments in the margin* moves them into a right-hand
  column (Google-Docs style).
* **Export**: LaTeX (a port of LyX's `output_latex` driven by LyX's own layout files) and PDF via
  `latexmk`; a native-LyX build as reference; embedded graphics (SVG/PDF/EPS/…) are rendered to
  PNG for the editor and downloadable as PNG.
* **LyX math editor**: formulas are edited with our own port of LyX's mathed (`packages/core/src/math`:
  the LyX cell/inset model, a port of `MathParser.cpp` and of LyX 2.5's writer so that edited formulas
  are written exactly as LyX writes them, and a port of `Cursor.cpp`/`InsetMathNest` for the cursor)
  rendered with KaTeX (`packages/client/src/editor/lyxmath`). Everything behaves as in LyX: cursor
  movement into and out of insets, `^`/`_`, `\` command mode with name completion by Space, Space
  leaves the inset, Backspace/Delete at cell edges dissolve the inset (`pullArg`), big insets are
  selected before deletion, empty scripts vanish, Enter adds rows (an inline formula becomes align),
  Tab moves between cells, LyX's corner markers around every inset on the cursor path, macros with
  arguments are expanded from their definitions with editable argument cells. Right-click menus on
  formulas, cross-references (go to label, reference format), citations, hyperlinks, child documents,
  insets and tracked changes; `Ctrl/⌘+click` follows a reference or opens a child document; **tabs**
  for open documents (new tabs open right of the current one); the text column is centred and its
  width is a View setting (*View ▸ Text width*, `Ctrl+Alt+±`).
* **LyX-style dialogs**: Paragraph settings (`Ctrl+Alt+P`: alignment, line spacing, indentation,
  label width), Table settings (cell / column / row / table tabs incl. longtable), Document settings
  (class & options, page & margins, text layout, numbering & floats, fonts, branches, PDF properties,
  preamble, raw header), Graphics (scale, width/height, rotation, clipping, LaTeX options), math
  Delimiters and Matrix insertion — all writing exactly the LyX parameters. Right-click menus on formulas, cross-references (go
  to label, reference format), citations, hyperlinks, child documents, insets and tracked changes;
  `Ctrl/⌘+click` follows a reference or opens a child document; **tabs** for open documents (new
  tabs open right of the current one); *View ▸ Master + child documents in one
  view* shows a paper and its `\include`d children as one scrolling page; an editable **Source pane**
  (live LyX source that follows the cursor — edit and *Apply* — plus the exported LaTeX); wide display
  formulas overflow symmetrically into the margins (Google-Docs style) with equation numbers kept
  clear of the formula.
* **LyX keyboard bindings** (`cua.bind`/`menus.bind`/`math.bind`): `Ctrl+M`, `Ctrl+Shift+M`,
  `Alt+P …` layouts, `Alt+M …` math, `Alt+A …` paragraph, `Ctrl+E/B/U`, `Ctrl+L` (TeX code),
  `Ctrl+Alt+F/M/N/C` (footnote / margin / note / comment), `Ctrl+Shift+E` (track changes), …
  See *Help ▸ Keyboard shortcuts*.

## Layout

```
packages/core     LyX AST + parser/writer (lossless), ProseMirror schema, AST⇄PM conversion,
                  macro/bib/comment helpers, LaTeX exporter (latex/) with a LyX layout-file parser
packages/server   Express + WebSocket (Yjs sync/awareness), SQLite persistence, auth (scrypt,
                  JWT cookie, optional Google OAuth), .lyx file sync & watcher, versions, export
packages/client   Vite + Preact UI, ProseMirror editor, LyX math editor (editor/lyxmath, KaTeX), LyX keymap,
                  numbering/margin/change-tracking/find plugins
tests/            vitest: byte-exact round trips over 400+ LyX files, PM/Yjs conversions,
                  LaTeX export unit tests, latexmk compile tests
e2e/              Playwright: login, rendering, collaboration, math, layouts, comments,
                  margin mode, tables, insets, external edits, versions, PDF export
```

## Running

```bash
npm install
npm run seed -- admin "Admin" jan "Jan Bauer"     # creates users, prints strong passwords
                                                   # (also appended to data/credentials.txt)
npm run dev          # server on :3000 + Vite dev server on :5173 (proxying /api and /ws)
npm run build        # production client build -> packages/client/dist (served by the server)
npm start            # production server (serves the built client)
```

Environment: `PORT` (default 3000), `OVERLYX_PROJECTS_DIR` (default `/root/projects`; every
sub-directory is a project holding `.lyx` files, figures and `.bib`s), `OVERLYX_DATA_DIR`
(SQLite, caches, builds, `credentials.txt`), `LYX_LAYOUT_DIR` (LyX `lib/layouts`),
`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` + `OVERLYX_PUBLIC_URL` to enable Google sign-in.

A systemd unit is installed as `overlyx.service` (see `deploy/`).

## Tests

```bash
npm test                                  # vitest (round trips, conversions, LaTeX, compile)
npx playwright test                       # e2e (needs the dev servers running)
```

## Compatibility notes

* Byte-exact round trips are guaranteed for LyX ≥ 2.4 files; older files are re-wrapped exactly
  like LyX does on save.
* The document header (class, preamble, options) is edited through *Document ▸ Settings*; raw
  header editing is available for anything else.
* Change tracking: insertions/deletions are marked per author (matched by the LyX author name);
  the status bar shows who you are tracking as and the change under the cursor; *Edit ▸ Track
  Changes* / the context menu accept or reject single changes or all of them.
* Macro rendering follows LyX's positional semantics (a `FormulaMacro` applies from its position on;
  later definitions — including ones nested in notes — override earlier ones). Macros with
  arguments are expanded from their definitions with the argument cells kept editable (`core/src/math/katex.ts`).
  calls when the formula is written to the file (`packages/core/src/mathedit.ts`).
* Large documents: formulas render statically first and become editable fields when they
  scroll into view or are hovered/entered.
* Every document's Yjs history carries an *epoch*; a browser tab whose editor belongs to an older
  epoch (server restarted with a changed file) reloads instead of merging stale content. Cross-tab
  BroadcastChannel syncing of y-websocket is disabled for the same reason.

# OverLyX

A web-based, LyX-compatible, collaborative WYSIWYG editor for LaTeX documents — an
Overleaf/LyX blend.

* **Native `.lyx` files are the source of truth.** Documents are parsed and written back
  byte-for-byte compatible with LyX 2.4/2.5 (`\lyxformat` ≥ 620): you can keep using desktop
  LyX on the same files; external saves are picked up live.
* **WYSIWYG without compiling.** Text, insets, floats, tables and math render as you type.
  Formulas (inline and display, `equation`/`align`/`gather`/`multline`/…) are edited in place
  with MathLive; document macros (`FormulaMacro` insets, preamble `\newcommand`/`\def`,
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
packages/client   Vite + Preact UI, ProseMirror editor, MathLive node views, LyX keymap,
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
  *Edit ▸ Track Changes* accepts/rejects all.

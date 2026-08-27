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
* **Autosave and offline editing** (Google-Docs style): there is no Save button — every edit goes
  to the server over the WebSocket and is written to the `.lyx` file 1.5 s after the last change
  (the status bar shows *Saving…* / *All changes saved*, confirmed by the server). Every opened
  document is mirrored in the browser (IndexedDB), so it opens instantly the next time and can be
  read and edited without a connection; a service worker keeps the app itself available offline.
  Offline edits sync automatically when the connection is back and merge with what others did in
  the meantime (CRDT), and an external save from desktop LyX only replaces the paragraphs that
  actually changed. See *Offline mode* below.
* **Notes and comments**: LyX notes (Note / Comment / Greyed out) render like LyX; OverLyX
  comment threads (author, time, replies, resolve) are stored as ordinary `Note Comment` insets so
  LyX users see them too. *View ▸ Notes & comments in the margin* moves them into a right-hand
  column (Google-Docs style).
* **Export**: LaTeX (a port of LyX's `output_latex` driven by LyX's own layout files) and PDF via
  `latexmk`; a native-LyX build as reference; embedded graphics (SVG/PDF/EPS/…) are rendered to
  PNG for the editor and downloadable as PNG. PDF builds only start on request (Ctrl+R, the
  toolbar or the PDF panel) and run as **background jobs**: the LaTeX export runs in a worker
  thread, `latexmk` runs `nice`d with at most `OVERLYX_MAX_BUILDS` (2) in parallel, the PDF panel
  shows the phase / elapsed time / last log line and has a *Cancel* button, and a build keeps
  running if you switch documents or tabs (the panel picks it up again). A request while a build
  is running re-builds once more afterwards with the latest content.
* **Ruler**: a Google-Docs-style ruler above the page (*View ▸ Ruler*) with draggable margin
  handles sets the text width (also *View ▸ Text width*, `Ctrl+Alt+±`); double-click resets it.
* **LyX math editor**: formulas are edited with our own port of LyX's mathed (`packages/core/src/math`:
  the LyX cell/inset model, a port of `MathParser.cpp` and of LyX 2.5's writer so that edited formulas
  are written exactly as LyX writes them, and a port of `Cursor.cpp`/`InsetMathNest` for the cursor)
  rendered with KaTeX (`packages/client/src/editor/lyxmath`). Everything behaves as in LyX: cursor
  movement into and out of insets, `^`/`_`, `\` command mode with name completion by Space, Space
  leaves the inset, Backspace/Delete at cell edges dissolve the inset (`pullArg`), big insets are
  selected before deletion, empty scripts vanish, Enter adds rows (an inline formula becomes align),
  Tab moves between cells, LyX's corner markers around every inset on the cursor path, macros with
  arguments are expanded from their definitions with editable argument cells; typing `\` starts a
  command shown red until it names a real command (then green), with LyX's completion in grey — Tab
  completes it. Right-click menus on
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
(SQLite, caches, builds, `credentials.txt`), `OVERLYX_CLIENT_DIST` (built client to serve, default
`packages/client/dist`), `OVERLYX_UNLOAD_MS` (how long an idle document stays loaded, default 6 h),
`OVERLYX_MAX_BUILDS` (parallel PDF builds, default 2), `OVERLYX_BUILD_NICE` (niceness of latexmk,
default 10),
`LYX_LAYOUT_DIR` (LyX `lib/layouts`), `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` +
`OVERLYX_PUBLIC_URL` to enable Google sign-in. The Vite dev server proxies to `OVERLYX_API_PORT`
(default 3000).

A systemd unit is installed as `overlyx.service` (see `deploy/`).

## Tests

```bash
npm test                                  # vitest (round trips, conversions, LaTeX, compile)
npx playwright test                       # e2e (needs the dev servers running)
```

The e2e suites copy real papers into scratch projects; to keep them away from the production
server and its data, run them against an isolated instance:

```bash
S=/tmp/overlyx-e2e; mkdir -p $S/projects $S/data; cp -r /root/projects/recurrent_feature $S/projects/
OVERLYX_DATA_DIR=$S/data npx tsx packages/server/src/seed.ts admin Admin
OVERLYX_DATA_DIR=$S/data OVERLYX_PROJECTS_DIR=$S/projects OVERLYX_CLIENT_DIST=$S/dist PORT=3001 npx tsx packages/server/src/index.ts &
(cd packages/client && OVERLYX_API_PORT=3001 npx vite --port 5174 &)
export OVERLYX_PROJECTS_DIR=$S/projects OVERLYX_E2E_CREDENTIALS=$S/data/credentials.txt
OVERLYX_E2E_BASE=http://localhost:5174 npx playwright test e2e/smoke.spec.ts e2e/editing.spec.ts e2e/features.spec.ts e2e/dialogs.spec.ts
# offline mode needs the built client (service worker): build into $S/dist, then
(cd packages/client && npx vite build --outDir $S/dist)
OVERLYX_E2E_BASE=http://127.0.0.1:3001 npx playwright test e2e/offline.spec.ts
```

## Offline mode

How it works, in order of what happens when you open a document:

1. **Local copy first.** The editor loads the document's Yjs state from IndexedDB
   (`overlyx:<project>/<file>`, written by `y-indexeddb`) and renders it right away, then connects
   to the server. The initial sync only exchanges what the two sides are missing, so re-opening a
   document is fast even on a slow connection.
2. **Editing.** Every keystroke is a Yjs update: applied locally, appended to IndexedDB and — while
   connected — sent to the server immediately. The server writes the `.lyx` file 1.5 s after the
   last change and then tells all clients *"the file now contains state X"* (message type 3);
   the status bar switches from *Saving…* to *All changes saved* when that confirmation covers
   everything this browser has sent.
3. **Offline.** When the connection drops (the browser's `offline` event, or y-websocket's
   30 s watchdog), the status bar shows *⚡ Offline — changes kept on this device*. Editing continues
   against the local copy; the service worker (`packages/client/src/sw.js`, generated into
   `dist/sw.js` with the list of built files) serves the app shell and the last responses of the
   few read-only API calls the editor needs (`/api/auth/me`, the project list, a document's
   metadata, rendered graphics), so a reload while offline still works. Documents with a local
   copy are marked ⬇ in the file browser; a document that was never opened on this device cannot
   be shown offline.
4. **Back online.** y-websocket reconnects; the Yjs sync sends the offline edits and receives
   everybody else's. Because the document is a CRDT, concurrent edits merge without conflicts
   (two people editing the same sentence simply both get their words in). External saves from
   desktop LyX are applied on the server as a *diff* (`packages/server/src/ydiff.ts`), so
   paragraphs that LyX did not touch keep their identity and offline edits inside them survive.
5. **Unmergeable case.** If the server's copy of the document has a *different history* (its Yjs
   state was reset with *POST /api/docs/…/reset*, or its database was wiped) the local copy cannot
   be merged: the editor stores the unsynced edits as a version named *"offline changes by …"*
   (Versions panel: compare / restore), discards the local copy and reloads the server's document.
   Logging out deletes the local copies and cached API responses on that browser.

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
* Large documents: the editor opens the local copy and starts syncing while the document's
  metadata loads; formulas near the top are rendered synchronously (a ~40 ms budget), the rest
  show their source and are rendered in idle time or when scrolled near, and become editable
  fields when they scroll into view or are hovered/entered. Macro tables are shared and cached
  per document, so a 300-formula paper paints in well under a second.
* Every document's Yjs history carries an *epoch*; a browser tab whose editor belongs to an older
  epoch (server restarted with a changed file) reloads instead of merging stale content. Cross-tab
  BroadcastChannel syncing of y-websocket is disabled for the same reason.

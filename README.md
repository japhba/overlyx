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
  thread, `latexmk` runs `nice`d with at most `OVERLYX_MAX_BUILDS` (2) in parallel (XeTeX or LuaTeX
  when the document uses non-TeX fonts or asks for them via its default output format), the PDF panel
  shows the phase / elapsed time / last log line and has a *Cancel* button, and a build keeps
  running if you switch documents or tabs (the panel picks it up again). A request while a build
  is running re-builds once more afterwards with the latest content.
* **Copy & paste** keeps every inset: a paragraph copied and pasted elsewhere (or into another
  OverLyX tab) still has its citations, cross-references, labels, formulas, tables and figures; the
  plain-text form of the clipboard is LaTeX-ish (`$…$`, `\ref{…}`, `\citep{…}`), so pasting into a
  `.tex` file or a chat gives something useful; HTML from a web page or another editor pastes as
  LyX content (headings, bold/italic/typewriter, lists, tables).
* **Safe with the file on disk.** The `.lyx` file is written atomically (temporary file + rename,
  fsync'ed). If somebody else wrote the file meanwhile (desktop LyX, git, another editor), that
  change is merged *three-way* at paragraph level before we write: only the paragraphs they changed
  are taken over, edits made here in other paragraphs are kept (the disk wins where both changed
  the same paragraph). A document whose file was deleted is closed and its content kept as a
  version instead of being silently re-created; a large deletion keeps the previous content as a
  version; the writer refuses to replace a document with something that is not a LyX document.
  Damaged files (an unterminated inset, unknown tokens, latin-1 bytes) open and are written back
  structurally complete.
* **Sharing** (Google-Docs model): a project is private to its owner until it is shared. The owner
  invites people by username or e-mail address as *viewers* or *editors* (an e-mail that has not
  signed in yet is kept as an invitation and bound to the account on its first Google sign-in), or
  turns on *Anyone with the link* (`/#/share/<token>`; switching back to *Restricted* revokes
  everyone who came in through the link). Viewers can read and compile but every change is refused
  — in the UI, on the API and on the WebSocket. Administrators (`OVERLYX_OWNER_EMAIL`, or
  `is_admin` in the database) see everything; directories that exist without an owner are adopted
  by the instance owner. *File ▸ Share project…*, the 👥 button in the file browser, or the start
  screen. Anyone with a Google account may sign in (they only see their own and shared projects);
  set `OVERLYX_SIGNUP=invited` to allow only e-mails that were invited to a project.
* **Every project is a git repository** you can clone, pull and push from your own machine
  (*File ▸ Git repository…*, the ⎇ button in the file browser, or *Git…* on a project card):
  `git clone https://<server>/git/<project>.git` with your username and an **access token** created
  in that dialog (or your OverLyX password; Google accounts have no password). The project directory
  is the working tree, so desktop LyX, OverLyX and git all work on the same files. OverLyX commits
  what people edit in the browser by itself — a couple of minutes after the last change and always
  right before a clone, pull or push (attributed to the people who edited) — so the repository is
  never behind the editor; *Commit now* in the dialog commits at once with a message of your own. A
  `git push` goes straight into the project (the checked-out branch is updated in place; open
  documents merge the change like an external save; uncommitted changes in files the push does not
  touch are kept — a push that would clash with one is refused, and a push behind what OverLyX
  committed meanwhile has to `git pull` first, as usual). Viewers can clone and pull but not push.
  A `.gitignore` for LaTeX build products and LyX backups is created with the repository; symlinks
  are never checked out as links. `OVERLYX_GIT=off` disables all of this.
* **Personal example project**: every account gets *Welcome to OverLyX* — a tour of the editor
  written for that user (`packages/server/templates/welcome`, generated by
  `scripts/gen-welcome.py`): layouts, formulas incl. a macro and `\llangle`, a figure, a table,
  citations, notes and comments, sharing, compiling. The start screen (no document open) lists it
  first, then the user's projects and what others shared.
* **Interactive tour** (`packages/client/src/app/Tour.tsx`): on the first visit (once per browser,
  `localStorage.ol.tour`) OverLyX offers a three-minute hands-on walkthrough that opens the example
  document and asks the user to try the essentials — type, make a paragraph a Section, insert a
  formula, watch the autosave indicator, start a comment thread, build the PDF, open the Versions
  tab, open the sharing dialog — each step highlights the part of the interface it talks about and
  notices by itself when the task is done (or is skipped with one click); the tour never blocks the
  interface or takes the focus away from the editor, can be left at any time, and is restarted with
  *Help ▸ Take the tour* or *Start the tour* on the start screen. Specs suppress it (`login()` in
  `e2e/helpers.ts` marks it as seen); `e2e/tour.spec.ts` walks through it.
* **Feedback straight to GitHub** (`packages/server/src/feedback.ts`, `app/Feedback.tsx`): *Help ▸
  Report a problem / send feedback…* (available on the start screen too) creates an issue in the
  project's repository (`GITHUB_REPO`, default `japhba/overlyx`) through the GitHub API with
  `GITHUB_TOKEN` — a fine-grained token with *Issues: read and write* on that repository. The dialog
  says what is sent (name and user name, app version, browser; the document name and the last error
  message only when ticked; never document content) and that the tracker is public; 10 reports per
  person and hour. Uncaught browser errors (`main.tsx`) and server errors (`unhandledRejection`) are
  reported automatically as one issue per distinct message (numbers / ids normalised), repeats become
  a count and at most one comment per 10 minutes; `OVERLYX_ERROR_REPORTS=off` keeps only the manual
  dialog. Without a token the dialog opens GitHub's pre-filled *new issue* form in a new tab instead.
* **File browser, one project at a time**: a switcher at the top lists your projects, the ones
  shared with you and (administrators) all others; the tree shows the selected project only. LaTeX
  build products (`.aux`, `.log`, `.bbl`, …) and LyX backups are hidden unless *All files* is on.
* **Text editor** for the other files of a project (`.tex`, `.bib`, `.sty`, `.cls`, `.bst`, `.md`,
  `.txt`, `latexmkrc`, …): they open in a tab like documents, with line numbers, autosave 1.5 s
  after the last change (or `Ctrl+S`), and a conflict check — if the file changed on the server
  meanwhile (someone else, desktop LyX, git) the save is refused and you choose between the server's
  version and yours. Viewers get it read-only. `+ File` in the file browser creates one.
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
* **LyX toolbars** (a port of `lib/ui/stdtoolbars.inc`): the *Standard* and *Extra* rows, and the
  contextual *Math*, *Math panels*, *Table* and *Review* rows that appear automatically when the cursor
  is in a formula / a table / a document with tracked changes (or always / never: *View ▸ Toolbars*,
  and the three toggle buttons at the end of the Standard row). The math row has LyX's buttons plus a
  **delimiter palette** (pairs × sizes: `\left…\right`, plain, `\big`, `\Big`, `\bigg`, `\Bigg`, incl.
  `| |`, `‖ ‖`, `⟨ ⟩`, `⟪ ⟫`, `⌊ ⌋`, `⌈ ⌉`, `⟦ ⟧`, arrows) and all of LyX's symbol panels (Greek, arrows,
  relations, operators, dots, decorations, big operators, AMS sets, functions, spacings, styles,
  fractions, fonts) rendered with KaTeX. `⟪ ⟫` (`\llangle … \rrangle`) are no LaTeX/LyX delimiters:
  the first use adds a small macro to the document preamble (`packages/core/src/math/llangle.ts`) that
  makes the plain, `\left…\right` and `\bigl…\bigr` forms compile with symmetric scaled brackets. The
  table row implements LyX's `tabular-feature` commands (`packages/client/src/editor/tablecommands.ts`).
* **Presence**: the avatars in the status bar are the connected users; click one to jump to where
  that user is editing (their cursor is scrolled into view and flashes).
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
* **Find & replace** (`Ctrl+F`): find next/previous, replace, replace all, case-sensitive and
  whole-word options, live match count and highlighting. *Document ▸ Statistics* counts words and
  characters of the selection / the document (notes excluded).
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
default 10), `OVERLYX_SANDBOX` (`auto` — use bubblewrap when installed, the default; `bwrap` — required;
`none`),
`LYX_LAYOUT_DIR` (LyX `lib/layouts`), `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` +
`OVERLYX_PUBLIC_URL` to enable Google sign-in, `OVERLYX_OWNER_EMAIL` (the instance owner: made an
administrator at sign-in and given every project directory that has no owner yet),
`OVERLYX_SIGNUP` (`open` — anyone with a Google account may sign in, the default — or `invited`),
`OVERLYX_GIT` (`off` to not expose projects as git repositories), `OVERLYX_GIT_COMMIT_MS` (idle time
before OverLyX commits what changed, default 2 min) and `OVERLYX_GIT_COMMIT_MAX_WAIT` (longest time
changes stay uncommitted while editing goes on, default 15 min), `GITHUB_REPO` / `GITHUB_TOKEN` /
`GITHUB_API_URL` (feedback and error reports as issues, see above) and `OVERLYX_ERROR_REPORTS` (`off`
disables the automatic ones). Git itself runs with an empty
environment (`HOME=<data dir>/git-home`, `safe.directory=*` because projects may belong to another
account) — the server's own git configuration never applies.
The Vite dev server proxies to `OVERLYX_API_PORT` (default 3000).

Deleted projects are moved to `<data dir>/trash/<name>-<timestamp>`, never removed.

**Sandboxing.** LaTeX is a programming language and a project's `latexmkrc` is Perl, so a PDF build
is arbitrary code. `latexmk`, native LyX and the image converters therefore run under
[bubblewrap](https://github.com/containers/bubblewrap) (`apt install bubblewrap`): the system is
read-only, only the build directory (and the `svg-inkscape` cache next to the document) is writable,
the project directory is mounted read-only, there is no network, a private `/tmp` and `HOME`
(`<data dir>/sandbox-home`, where TeX/fontconfig/inkscape caches and LyX's user directory persist),
and an empty environment. Without bubblewrap the server starts with a warning and runs the tools
unsandboxed (`packages/server/src/sandbox.ts`).

A systemd unit is installed as `overlyx.service` (see `deploy/`). `deploy/overlyx-backup.timer` runs
`scripts/backup.sh` every night: an online backup of the SQLite database and a tarball of the
projects directory (without build products) into `<data dir>/backups/<timestamp>/`, keeping the
newest 14 (`OVERLYX_BACKUP_KEEP`). The server logs unhandled promise rejections instead of dying;
on an uncaught exception it saves the open documents and exits so that systemd restarts it.

## Secrets

Everything secret (the Google OAuth client secret, the GitHub token) stays out of the repository —
which is public — in `deploy/secrets.env` (git-ignored, mode 600), read by the systemd unit through
`EnvironmentFile=`; `deploy/secrets.env.example` lists the variables. The file exists on the server
and in the nightly backup, nowhere else — deliberately no secret store: both values can be re-created
in minutes (the OAuth client in the Google Cloud console under *APIs & Services ▸ Credentials*, a
fine-grained personal access token with *Issues: read & write* on the repository in GitHub's
*Developer settings*), and a second machine gets the file by `scp`. Without it the app runs with
password login only and the feedback dialog falls back to GitHub's issue form. The per-instance JWT
secret (`<data dir>/secret.key`) is generated on first start and is part of every backup too.

Do not put a broad-scope token (your `gh` login) in there: the server runs user-supplied LaTeX, and a
token with *Issues* on one repository is all the feedback channel needs.

## Backups and restoring

`deploy/overlyx-backup.timer` runs `scripts/backup.sh` every night (SQLite online backup, `secret.key`,
a tarball of the projects without build products; the newest 14 are kept). Restoring — do the drill
once in a while:

```bash
B=data/backups/$(ls data/backups | tail -1)
scripts/restore.sh $B /tmp/restore/data /tmp/restore/projects            # integrity check, counts
OVERLYX_DATA_DIR=/tmp/restore/data OVERLYX_PROJECTS_DIR=/tmp/restore/projects OVERLYX_GIT=off PORT=3002 HOST=127.0.0.1 npx tsx packages/server/src/index.ts
# log in with a real password (hashes are in the database), list projects, open a document; then
# for a real restore: systemctl stop overlyx; scripts/restore.sh $B data /root/projects --force; systemctl start overlyx
```

`--force` moves the existing database and projects directory aside (`*.before-restore-<timestamp>`)
instead of deleting them. `data/credentials.txt` (seeded passwords in clear) is not part of a backup.

## Tests

```bash
npm test                                  # vitest (round trips, conversions, LaTeX, compile)
npx playwright test                       # e2e (needs the dev servers running)
```

The e2e suites copy real papers into scratch projects; to keep them away from the production
server and its data, run them against an isolated instance:

```bash
S=/tmp/overlyx-e2e; mkdir -p $S/projects $S/data
rsync -a --exclude _build --exclude .git /root/projects/recurrent_feature /root/projects/bayesian_chaos $S/projects/   # features.spec compiles bayesian_chaos
OVERLYX_DATA_DIR=$S/data npx tsx packages/server/src/seed.ts admin Admin bob Bob carol Carol u1 U1 u2 U2 u3 U3 u4 U4 u5 U5 u6 U6
OVERLYX_DATA_DIR=$S/data OVERLYX_PROJECTS_DIR=$S/projects OVERLYX_CLIENT_DIST=$S/dist PORT=3001 npx tsx packages/server/src/index.ts &
(cd packages/client && OVERLYX_API_PORT=3001 npx vite --port 5174 &)
export OVERLYX_PROJECTS_DIR=$S/projects OVERLYX_E2E_CREDENTIALS=$S/data/credentials.txt
OVERLYX_E2E_BASE=http://localhost:5174 npx playwright test e2e/smoke.spec.ts e2e/editing.spec.ts e2e/features.spec.ts e2e/dialogs.spec.ts
OVERLYX_E2E_BASE=http://localhost:5174 npx playwright test e2e/sharing.spec.ts e2e/textfiles.spec.ts e2e/toolbar.spec.ts e2e/collab.spec.ts   # bob, carol, u1…u6
OVERLYX_E2E_BASE=http://localhost:5174 npx playwright test e2e/tour.spec.ts e2e/feedback.spec.ts e2e/misc.spec.ts e2e/clipboard.spec.ts
# offline mode needs the built client (service worker): build into $S/dist, then
(cd packages/client && npx vite build --outDir $S/dist)
OVERLYX_E2E_BASE=http://127.0.0.1:3001 npx playwright test e2e/offline.spec.ts e2e/git.spec.ts   # git: a real clone / push / pull with a token
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

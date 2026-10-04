# OverLyX in depth

Everything the [README](README.md) summarises, in full: features, the `.tex` format,
architecture, self-hosting, development and tests.

A web-based, LyX-like, collaborative WYSIWYG editor for LaTeX documents — an Overleaf/LyX
blend.

* **Plain `.tex` files are the source of truth.** A document is an ordinary LaTeX file that any
  editor, Overleaf or `latexmk` understands; OverLyX reads it into a LyX-style document model
  (paragraph layouts, insets, formulas) driven by LyX's own layout files, renders it as you type
  and writes it back — a file that was written by OverLyX is reproduced byte for byte until
  somebody edits it. Whatever the model has no place for (unknown commands, environments,
  `\verb`, TikZ, …) is kept verbatim as raw LaTeX and stays editable. Change tracking lives in the
  file as LyX's `\lyxadded{author}{time}{…}` / `\lyxdeleted{…}` macros (defined in a managed
  block of the preamble, shown or hidden in the PDF by a setting), notes and comment threads as
  `%% @note` / `%% @comment` comment blocks that every other LaTeX tool ignores. See *The .tex
  format* below. Existing `.lyx` documents are imported once (file browser ▸ click the file, or
  `scripts/import-lyx.ts`); the `.lyx` file is kept but no longer used.
* **WYSIWYG without compiling.** Text, insets, floats, tables and math render as you type.
  Formulas (inline and display, `equation`/`align`/`gather`/`multline`/…) are edited in place
  and rendered with MathJax 4; document macros (`FormulaMacro` insets, preamble `\newcommand`/`\def`,
  `\input{macros}` files, child documents) render immediately. Formulas are typed the LaTeX way
  too: `$` opens an inline formula, `$` inside it closes it (Space does not leave such a formula —
  `$r \ll d$` types as written), `$$` opens a display formula, and
  Backspace in the empty formula gives the typed dollar back as text (the way to type a literal
  `$`; in TeX code and listings the dollar is always a character). The math toolbar's ( )↑ / ( )↓
  grow and shrink the delimiter pair around the cursor (`( )` → `\big` → `\Big` → `\bigg` →
  `\Bigg` → `\left…\right` and back). A script on a macro whose definition ends in a script
  (`\q := q_{a}`, typed `\q^x_y`) is drawn greedily on screen — `x` above the `q`, `y` appended to
  the `a` — where TeX hangs both off the right of the whole `q_a`; the LaTeX is unchanged.
* **Multi-user editing** (Yjs CRDT, per-user undo, live cursors) with automatic and named
  **versions** (diff & restore).
* **Autosave and offline editing** (Google-Docs style): there is no Save button — every edit goes
  to the server over the WebSocket and is written to the `.tex` file 1.5 s after the last change
  (the status bar shows *Saving…* / *All changes saved*, confirmed by the server). Every opened
  document is mirrored in the browser (IndexedDB), so it opens instantly the next time and can be
  read and edited without a connection; a service worker keeps the app itself available offline.
  Offline edits sync automatically when the connection is back and merge with what others did in
  the meantime (CRDT), and an external change of the file (git, another editor) only replaces the
  paragraphs that actually changed. See *Offline mode* below.
* **Notes and comments**: LyX-style notes (Note / Comment / Greyed out) and OverLyX comment
  threads (author, time, replies, resolve) are kept in the `.tex` file as `%%` comment blocks.
  On screen a note is a yellow sticky, a greyed-out part a quiet grey box, and a comment thread a
  card with an avatar, name and time per message (the header paragraph `Name (time):` stays as
  text in the file — `numbering.ts` decorates it, `styles.css` draws it) and Reply / Resolve at
  the top right. *View ▸ Notes & comments in the margin* moves them into a right-hand column
  (Google-Docs style). A thread is a point in the text (`%% @comment` has no range): commenting on
  selected text keeps the text and anchors the thread right after it (`editor/commands.ts insertComment`).
* **Figures keep up with their files**: the server watches the projects (chokidar) and tells the
  open editors over the project's event stream (`/api/projects/:p/events`, `{"kind":"graphics"}`)
  when a graphics file is rewritten — a plot script ran, an upload landed — and the image reloads
  in place (the URL carries the file's mtime). In the dark theme figures get an iOS-style *smart
  invert*: a plot or diagram (dark strokes on a light or transparent ground, judged from a small
  canvas copy of the pixels, `figureinvert.ts`) is shown light-on-dark with a CSS filter, a
  photograph keeps its colours; *Settings ▸ Editor ▸ Figures* switches it off.
* **The start page** lists the user's projects, then those shared with them, each most recent first:
  the later of when they last opened a document of it (`user_doc_state` *opened*, every open; the
  activity log for older history) and when a file of it last changed; the card says which
  (“opened 3 min ago”, “changed 2 days ago”; `app/recency.ts`). Every card has **Open** (a project
  without documents opens on a small page of its own with *+ New document*, `ProjectRootPanel`) and
  **Download**: the whole project as a .zip (`GET /api/projects/<key, URL-encoded>/zip`, view rights,
  without `.git` and LaTeX's build byproducts; `server/src/zip.ts` writes it). The Git dialog
  has the same link.
* **Questions are in-app dialogs**, never the browser's `prompt()`/`confirm()`/`alert()`
  (`uiPrompt`/`uiConfirm`/`uiAlert` in `app/Dialogs.tsx`, one `DialogHost` per shell, VS Code
  webview included): Enter accepts, Esc cancels, the proposed text is selected. A new file or
  document whose name exists asks again for another name. Insert ▸ Child document… lists the
  project's documents to `\include`/`\input`, or creates a *new child document* (an empty fragment)
  and includes it.
* **Import from Overleaf** (start page, and the landing page for visitors who have no account yet): paste the links of the projects to bring over and an
  Overleaf Git token — each ticked project is cloned by the server from `git.overleaf.com` into a
  new project (Overleaf's Git access, paid and institutional plans; history and `origin` are kept,
  the token is passed to git through `GIT_ASKPASS` and never stored) — or upload the zip Overleaf's
  *Menu ▸ Download ▸ Source* produces (every account; several at once). Overleaf has no API that
  lists projects, so the selection is made from pasted links. `server/zip.ts` is a small ZIP reader
  (central directory, deflate) with a traversal-safe extraction. The download of a whole project
  list ("Overleaf Projects -N items.zip", one zip per project inside) is recognised as a bundle:
  every project in it becomes a project named after its zip (`bundledZips`). On the landing page
  (*Coming from Overleaf?*, `app/OverleafStart.tsx`) the zips (or links + token) are parked in
  IndexedDB (`app/pendingImport.ts`), survive the Google round trip, and the start page imports
  them the moment there is an account and opens a lone project's document; guests cannot import.
* **PDF** via `latexmk` on the document's own `.tex` file (plus the child documents it inputs),
  with `-f`: an error TeX recovers from (an undefined macro) does not stop it before bibtex / biber
  and the reruns, so the first build of an imported paper has its citations and references (not
  "??" until a second build); embedded graphics (SVG/PDF/EPS/…) are rendered to PNG for the editor and downloadable as PNG,
  and formats pdflatex cannot include are converted to PDF for the build. PDF builds start on
  request (Ctrl+R, the toolbar or the PDF pane) or **by themselves** (Overleaf's auto compile: the ▾
  beside *View PDF*, or *Settings ▸ Editor ▸ PDF* — off, *while the PDF is shown* (the default) or
  *always*, which keeps a public PDF link current; a delay after the save, 1 s by default). An
  automatic build starts when the document was saved after the PDF was written, never while a build
  runs (the client asks again when it is done and the document is still newer), never twice for the
  same save (a failing document is not rebuilt in a loop, a cancelled build is not restarted), and it
  is quiet: no message, the log does not open. Builds run as **background jobs**: `latexmk` runs
  `nice`d with at most `OVERLYX_MAX_BUILDS` (2) in parallel (XeTeX or LuaTeX when the document uses
  non-TeX fonts or asks for them via its default output format), the PDF pane shows the phase /
  elapsed time / last log line in a small note floating over the pages (a thin line runs along the
  top — nothing moves) and has a *Cancel* button, and a build keeps running if you switch documents
  or tabs (the pane picks it up again). A request while a build is running re-builds once more
  afterwards with the latest content (`requestBuild`; an automatic request never does, so several
  open editors reacting to the same save do not build twice). **How old the PDF is** stands in the
  pane's bar (“✓ built 2 min ago”, amber *· outdated* once the document was saved after it, red after
  errors) and in the status bar, also with the pane closed (a click shows the PDF and rebuilds an
  outdated one); the build status carries the PDF file's time (`pdf_at`) and the server's clock
  (`now`), so the age is right whatever the browser's clock says (`app/pdfstatus.ts`).
  A TeX magic comment in the first lines (`%!TEX TS-program = lualatex`, `% !TeX program =
  xelatex`) names the engine; without one, `fontspec` (LyX's *use non-TeX fonts*) means XeTeX, the
  LyX output format *pdf5* LuaTeX, everything else pdfTeX. A `latexmkrc` in the document's
  directory is honoured, except that preview-continuous mode is switched off (`-pvc-`).
* **Copy & paste** keeps every inset: a paragraph copied and pasted elsewhere (or into another
  OverLyX tab) still has its citations, cross-references, labels, formulas, tables and figures; the
  plain-text form of the clipboard is LaTeX-ish (`$…$`, `\ref{…}`, `\citep{…}`), so pasting into a
  `.tex` file or a chat gives something useful; HTML from a web page or another editor pastes as
  LyX content (headings, bold/italic/typewriter, lists — numbered ones as Enumerate, Google Docs'
  `<li><p>` items too —, tables). Several blocks pasted into the middle of a paragraph split it and
  land as paragraphs: ProseMirror's content fitting never wraps them into an inset (the only inline
  node that holds paragraphs — a Note by default, missing from the PDF) or a table, which
  `core/src/schema.ts` marks as not generatable; pasted into an empty paragraph they replace it, so the
  first keeps its layout (a pasted heading stays a heading: `editor/plugins/paste.ts pasteBlocksIntoEmpty`). **Rows of a table** (any cell
  selection — drag across cells, Shift+click, Shift+↓) paste as in LyX (`InsetTabular::pasteClipboard`):
  cell by cell from the cursor's cell, overwriting, with rows and columns added past the table's end;
  cut empties the cells, and outside a table they paste as a new table. Ctrl+V, the right-click menu
  and the toolbar's Paste take the same way (`editor/clipmenu.ts pasteFromClipboard` feeds the async
  clipboard's HTML through the editor's paste handling). **Rows of a formula** (`align`, `eqnarray`,
  matrices) copy as `x&=1\\y&=2` and paste into a formula as rows (`MathCursor.paste`, LyX's
  InsetMathGrid LFUN_PASTE): Enter at the end of the last row opens an empty row, ← its first cell,
  and the pasted rows fill it and are added below; what a formula cannot grow for (`$…$`) is kept in its last cell.
* **Safe with the file on disk.** The `.tex` file is written atomically (temporary file + rename,
  fsync'ed). If somebody else wrote the file meanwhile (git, another editor, Overleaf), that
  change is merged *three-way* at paragraph level before we write: only the paragraphs they changed
  are taken over, edits made here in other paragraphs are kept (the disk wins where both changed
  the same paragraph). A document whose file was deleted is closed and its content kept as a
  version instead of being silently re-created; a large deletion keeps the previous content as a
  version; the writer refuses to replace a document with something that is not a LyX document.
  Damaged files (an unterminated inset, unknown tokens, latin-1 bytes) open and are written back
  structurally complete.
* **Saving keeps the file as it is where nothing changed** (`core/src/tex/preserve.ts`). A save
  writes the document *into the text the file holds*: every paragraph nobody edited keeps its own
  LaTeX byte for byte (hard line breaks, comments, the author's macro spellings, CRLF line ends),
  and so do the preamble and the glue between paragraphs; only edited paragraphs are written by
  the writer, and a document setting changed in the dialog is merged into the preamble line by
  line. A file without a managed block gets one (right before `\begin{document}`) only when the
  content comes to need a package or macro the file does not load, or uses something only the
  block defines (layout objects, the change-tracking macros); a block is brought up to date when
  the writer's differs (an update of OverLyX's macros), and removed when it would hold nothing but
  the settings line. A co-author's `git diff` after one typed word shows that paragraph, not a
  reformatted file. How: the parser records where every body paragraph came from
  (`ParseTexResult.sources`), the writer where it wrote each one (`spans`); paragraphs are matched
  by the writer's text for them, and the base's glue is kept where the writer's glue is the same;
  the base text a rewritten paragraph replaces must open and close the same environments and
  groups as the writer's text in its place (else more is rewritten: a `\begin{center}` in one
  paragraph and its `\end{center}` after the next go together). The result is always parsed again and must give the document being saved (or, where the writer
  itself does not reproduce a paragraph it wrote, what a full rewrite reads back as); otherwise
  more is rewritten, in the end the whole file — never worse than writing it all. Every save path
  goes through it: the server (`server/src/docwork.ts renderDoc`, so autosave, MCP edits, agent
  turns, restores), and the VS Code extension (`DocSession`, against the TextDocument's text). Costs
  one extra parse per save; the base's parse and writer output are cached per document between saves.
* **One document's work never stalls the others** (`server/src/docpool.ts`, `docworker.ts`). Making
  a save's text, opening a document, merging a change on disk, an agent's edit (parse, merge,
  tracked diff) take seconds for a big paper — on the server's single event loop that stalled every
  user of the instance (10 papers saving at once: 0.2 s; an 850 kB thesis being edited: 5 s; an
  agent editing it: 20 s and more). This work runs in `OVERLYX_DOC_WORKERS` worker threads (default:
  the cores less two, 1–4; `0` does it on the main thread as before). Each keeps a mirror Y.Doc of the
  open documents of the projects it serves (all documents of a project share one worker: a master
  includes its children's live state), brought up to date with the CRDT updates the main thread
  sends along with each request; it answers with the text, or with the CRDT update an edit made,
  which the main thread applies (`docwork.ts` holds the functions both sides run; tests compare
  their bytes). The main thread keeps the CRDT, the files and the database, and does each change of
  a document in turn (`OpenDoc.exclusive`): `saveToFile` resolves once the file holds the state of
  the call; edits that arrive while a save's text is made leave the document dirty and outside that
  save's *All changes saved*; a change written to the file meanwhile is merged before writing; a
  file deleted meanwhile is not re-created. A document whose save took a while (seconds, a big one)
  is saved at most every other such period while people type in it; an idle one still 1.5 s after
  the last change. A client's first sync of a document over 100 kB is encoded by the worker too,
  and a big document opened from its file is applied in steps. A worker that dies is replaced and
  its mirrors rebuilt from the main thread; five deaths in a minute put the work back on the main thread.
* **Sharing** (Google-Docs model): a project is private to its owner until it is shared. The owner
  invites people by username or e-mail address as *viewers* or *editors* (an e-mail that has not
  signed in yet is kept as an invitation and bound to the account on its first Google sign-in), or
  turns on *Anyone with the link* (`/#/share/<token>`; switching back to *Restricted* revokes
  everyone who came in through the link). The link means *anyone*: a visitor without an account
  lands in the document straight away as a **guest** — `POST /api/share/:token/accept` (outside
  the authenticated router) creates a temporary account ("Anonymous Otter", `users.is_guest`,
  same-origin only, ≤ 30 per address and hour) and sets the session cookie; the client shows a
  *Sign in* button top right with a dismissable callout (`app/Guest.tsx`) suggesting Google sign-in
  to keep the project. Guests act only inside the projects their links opened (no projects, tokens,
  agent, administration or example project of their own; `GUEST_DENIED` in index.ts) and get no
  tour. Signing in — Google or password — while holding a guest cookie moves the guest's link
  memberships and activity to the account and deletes the guest (`access.ts adoptGuest`; the
  guest's open editors are kicked to reconnect); `/api/auth/google?next=#/…` returns to the
  document afterwards (the landing page's Google buttons carry the current hash). Guests older than
  the session are pruned at startup (`pruneGuests`). `OVERLYX_SIGNUP=invited` instances admit no
  guests (the link asks to sign in). Viewers can read and compile but every change is refused
  — in the UI, on the API and on the WebSocket. Administrators (`OVERLYX_OWNER_EMAIL`, or
  `is_admin` in the database) do **not** see other people's projects: the start screen lists them
  under *Administration*, and *Open as administrator…* grants owner rights for one hour — logged in
  that project's **activity log**, which its owner sees in the Share dialog together with who
  opened, built, pulled, pushed or changed the sharing (`GET /api/projects/:p/activity`). A
  directory without an owner in a namespace is adopted by that namespace's account, one put at the
  top level by hand moves into the instance owner's namespace. *File ▸ Share project…*, the 👥
  button in the file browser, or the start screen. Anyone with a Google account may sign in (they only see their own and shared projects);
  set `OVERLYX_SIGNUP=invited` to allow only e-mails that were invited to a project.
* **Project addresses** (`core/src/projectKey.ts`, `server/src/namespaces.ts`): projects live in
  their owner's namespace, like repositories on GitHub. The project *thesis* of the account *jan* is
  `jan/thesis` — its directory `<projects dir>/jan/thesis`, its documents `jan/thesis/<path>` — and
  that is also its URL: `https://<server>/#/jan/thesis/main.tex` opens the same document for
  everybody who has access, so a link from the address bar can be sent to a collaborator as it is
  (someone without access needs the share link). Two accounts can each have a *thesis*. The same key
  names the git remote (`/git/jan/thesis.git`), the MCP connection (`/mcp/jan/thesis`, the keys
  `list_projects` returns) and the REST routes (`/api/projects/jan%2Fthesis/…`, one path segment as
  the client sends it; `/api/projects/jan/thesis/…` works too). New projects (start screen, Overleaf
  import, CLI, MCP `create_project`) are created in the creator's namespace; the welcome project is
  `<user>/welcome`. Handing a project to another account (`POST /api/projects/:p/share/owner`) moves
  it into the new owner's namespace. Until 25 Sep 2026 projects were top-level directories with one
  global name (`/root/projects/thesis`): at startup every such project moves into its owner's
  namespace together with everything that names it — the rows of every table, document ids, build
  directories (`moveFlatProjects`, journalled in `project_moves` so an interrupted move is finished
  at the next start). Every earlier name stays an **alias** (`project_aliases`): old links (the
  client asks `GET /api/resolve?id=` and rewrites its URL before opening the document), git remotes
  (`/git/thesis.git`), MCP clients (`/mcp/thesis`, `project: "thesis"`, fetch ids) and API calls keep
  working. The VS Code extension keys its local folders the same way, `local/<folder name>`, so the
  shared editor code reads document ids alike.
* **Public PDF link** (Share dialog ▸ *Public PDF link*, per document; also 🔗 *Public link* in
  the PDF panel): `https://<server>/pdf/<token>/<name>.pdf` serves the document's latest build to
  anyone, no account — the address a personal web page links its CV to. The last PDF is served at
  once; when the project's files are newer than the build, a rebuild is queued in the background
  (at most one a minute per document), and a document that was never built is built while the
  first reader waits (`server/pdflinks.ts`, table `pdf_links`; ETag / 304, `?download=1`, no frame
  restrictions so the PDF can be embedded elsewhere; fetches are counted for the owner). Turning
  the link off kills the address; turning it on again keeps the token people already point at.
  **Publishing into a GitHub repository** (administrators; `GITHUB_PUBLISH_TOKEN`, a fine-grained
  token with *Contents: read & write* on the target repositories): after every successful build
  the PDF is committed to `<owner>/<repo>` at a path (a Hugo site's `static/uploads/cv/cv.pdf`
  keeps its old address) through the Contents API — one request, no clone, nothing committed when
  the file is byte-identical; failures show in the dialog with *Push now* (`server/pdfpublish.ts`,
  table `pdf_publish`).
* **Every project is a git repository** you can clone, pull and push from your own machine
  (*File ▸ Git repository…*, the ⎇ button in the file browser, or *Git…* on a project card):
  `git clone https://<server>/git/<owner>/<project>.git` with your username and your **account access
  token** created in that dialog (or your OverLyX password; Google accounts have no password). The project directory
  is the working tree, so desktop LyX, OverLyX and git all work on the same files. OverLyX commits
  what people edit in the browser by itself — a couple of minutes after the last change and always
  right before a clone, pull or push (attributed to the people who edited) — so the repository is
  never behind the editor; *Commit now* in the dialog commits at once with a message of your own. A
  `git push` goes straight into the project (the checked-out branch is updated in place; open
  documents merge the change like an external save; uncommitted changes in files the push does not
  touch are kept — a push that would clash with one is refused, and a push behind what OverLyX
  committed meanwhile has to `git pull` first, as usual). Viewers can clone and pull but not push.
  The downloadable CLI adds a `gh`-style import path for work that already exists locally:

  ```sh
  curl -fsSL https://overlyx.app/install-cli.sh | sh      # then: sign in through the browser (offered)
  overlyx auth login --host https://overlyx.app --username NAME --with-token
  overlyx repo create my-paper --source . --push     # creates <your username>/my-paper
  # shorthand, and safe to retry after a failed first push:
  overlyx repo push . --name my-paper
  ```

  `overlyx build <owner>/<project>/<file>.tex` compiles a document on the server like the PDF button
  (`POST /git/api/build`; errors `file:line`, exit code 1 on failure, `--pdf FILE` fetches
  `GET /git/api/pdf`, `--log`), and `overlyx restore <owner>/<project> <commit>` puts the whole
  project back to an earlier commit (`POST /git/api/restore`). Both use the account token and roles
  (restore needs edit access). `restoreProject` in `server/git.ts` (also *Restore* next to each commit
  in the Git dialog, `POST /api/projects/:p/git/restore`, and the MCP tool `restore_project`) commits
  what is pending, reads the commit's tree into index and working tree (`read-tree -u --reset`: files
  it lacked are removed, ignored build products stay), commits that on top — nothing is rewritten, so
  a restore is undone the same way — and open documents take the restored text over.

  `repo push` initialises and commits an ordinary folder; an existing repository must be clean so
  no uncommitted work is silently omitted. The server creates an unborn repository for the first
  push, preserving the local history without an unrelated synthetic merge. Its Basic-authenticated
  `/git/api/user` and `/git/api/projects` endpoints use the account token and the same rate limiting
  as smart HTTP. The remote URL stores the username but not the token.
  Projects created in the app get a `.gitignore` for LaTeX build products and LyX backups; CLI
  imports preserve the local project's own ignore rules. Symlinks are never checked out as links.
  `OVERLYX_GIT=off` disables all of this.
* **Personal example project and starters**: every account gets *Welcome to OverLyX* — a tour of the editor
  written for that user (`packages/server/templates/welcome`, generated by
  `scripts/gen-welcome.py`): layouts, formulas incl. a macro and `\llangle`, a figure, a table,
  citations, notes and comments, sharing, compiling. The start screen (no document open) lists it
  first, then the user's projects and what others shared. Beside it every account gets four
  **starter projects** to build on (`packages/server/templates/starters/<id>`, `ensureStarterProjects`
  in `server/access.ts`): *Example: beamer slides* (`<user>/example-slides`, an ordinary linear beamer
  deck that demos frames, `[<+->]`, `\item<2->`, `\pause`, `\only` / `\uncover` / `\alert` / `\alt`,
  columns, blocks, a theorem, a figure, a table and speaker notes, and says how to present it),
  *Example: slide deck* (`example-deck`, a 16:9 canvas deck in Layout mode — a 15-slide talk on why
  the sky is blue in one palette and grid: title and section slides drawn from shapes, a formula
  built up step by step, a diagram, a pgfplots plot with callouts, a cropped picture, a table, a
  timeline, transitions — whose speaker notes are a guided tour of how each slide was made),
  *Example: poster* (`example-poster`, an A0 poster in Layout mode that explains how to edit one) and
  *Example: paper* (`example-paper`, an article with equations and cross-references, a theorem and
  proof, a figure, a table and natbib citations from `refs.bib`); the account's name is the author.
  They are ordinary projects of the account (kind `project`), created once — new accounts on their
  first visit, older accounts on their next — and never again once deleted (table `starter_projects`,
  one row per account and template; guests get none). `scripts/gen-starters.ts` writes them from
  `scripts/starters-src/` (the poster is laid out in the script, the slide deck in
  `starters-src/deck.ts`, their text boxes as high as their text in the compiled PDF) through
  OverLyX's own parser and writer, so they are in the canonical form and opening or saving one
  changes nothing; `--figures` recompiles the pgfplots/TikZ figures reproducibly, and naming starters
  (`… gen-starters.ts deck`) regenerates only those. The deck's texts keep room to spare in every line
  (the editor sets text up to ~4 % wider or narrower than TeX), so the layout check marks none of
  its boxes. `tests/starters.test.ts` checks the seeding, the canonical form, that all of them
  compile and that no text box of the poster or the deck overflows in the PDF.
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
  a count and at most one comment per 10 minutes. The no-account VS Code extension uses its own
  narrow, IP-rate-limited `/api/vscode-telemetry` receiver for errors when both VS Code telemetry and
  `overlyx.errorReports` are enabled. VS Code sanitizes the exception first; only extension/VS Code
  versions, OS/CPU family and local/remote host kind accompany it — never document text, filenames,
  paths, account details, email or stable IDs (`packages/vscode/telemetry.json` declares the schema).
  `OVERLYX_ERROR_REPORTS=off` keeps only the manual dialog. Without a token the dialog opens GitHub's
  pre-filled *new issue* form in a new tab instead.
* **Anonymous usage statistics** (`packages/client/src/usage.ts`, `packages/server/src/usage.ts`,
  `usageReport.ts`): the web app records the *kind* of every deliberate action — a menu entry
  ("Edit ▸ Text Style ▸ Bold"), toolbar button, shortcut or Alt+P chord, and whether its command did
  anything — plus modifier combinations that reached the editor unanswered, dialogs (applied or
  dismissed, how long open), error messages as templates, uncaught errors, undo/redo, the kind of
  screen, and once per page load the platform / browser / width class. Every event carries where it
  happened (text, formula, table, inset, dialog) and a random per-page-load session id; no user id,
  document, project or file name, text or formula: quoted strings, file names, e-mail addresses and
  numbers are scrubbed in the browser and again on the server, the Navigate menu's heading entries
  become `<heading>`. Batches go to `POST /api/usage` (authenticated, rate-limited per account, the
  account is not stored); rows are kept 180 days. *Settings ▸ Privacy* switches it off per browser
  (the browser's Global Privacy Control signal does too), `OVERLYX_USAGE_STATS=off` for the whole
  instance. The VS Code extension sends nothing. The point is to find counter-intuitive parts of the
  interface: `npx tsx scripts/usage-report.ts [--days 30]` (read-only on the database; `--json` for
  the raw summary) and `GET /api/admin/usage` rank actions by how often they failed, were undone
  within 5 s or were repeated in bursts, list the unanswered shortcuts, the dismissed dialogs and the
  error templates.
* **Documents panel, one project at a time** (`app/DocPanel.tsx`, Google-Docs style, left; `Ctrl+Alt+O`):
  the project switcher at the top lists your projects and the ones shared with you — choosing another
  one opens *its* main document (there is no tab bar across projects any more; the hash names the one
  file shown). Below it one tree of the project's files (`app/FileBrowser.tsx`, VS Code-like: folders
  start closed, except the ones holding the open document), where a **`.tex` document expands into its
  outline**: the open one by itself — the live outline (headings numbered, with the ▲ ▼ ◀ ▶ section
  tools), its row brought near the top of the panel — and any other with its ▸, showing the file's
  headings (`GET /api/docs/<id>/outline`, `core/tex/headings.ts`, no parse), where a heading opens that
  document at the heading (`#/<doc>?heading=<n>`). A click on a row opens the file in place (figures,
  `.bib`, `.sty` … in the text editor or a browser tab); `+ Doc` / `+ File` / `+ Folder`, and what was
  just created, moved or uploaded is revealed; files — or whole folders — dragged in from the
  computer are uploaded to where they are dropped (the project, or the folder row under the pointer);
  LaTeX build products (`.aux`, `.log`, `.bbl`, …) and LyX
  backups are hidden unless *All files* is on. The *Navigate* menu lists the sections as well
  (so the command palette finds them).
* **Text editor** for the other files of a project (`.tex`, `.bib`, `.sty`, `.cls`, `.bst`, `.md`,
  `.txt`, `latexmkrc`, …): they open in a tab like documents, with line numbers, autosave 1.5 s
  after the last change (or `Ctrl+S`), and a conflict check — if the file changed on the server
  meanwhile (someone else, git) the save is refused and you choose between the server's
  version and yours. Viewers get it read-only. `+ File` in the file browser creates one.
* **Layout documents** (Pages' *page layout* next to its word processing; `editor/layout/`, core
  `layout/`): slides, posters and free-form pages — fixed-size pages whose objects sit anywhere:
  **text boxes** (ordinary OverLyX text: formulas, lists, colours, citations…), **vector shapes**
  (SVG path data: rectangles, ellipses, stars, arrows, lines, Bézier curves), **images** (cropped),
  **groups** and **raw LaTeX** (TikZ, pgfplots, `\qrcode`… shown as its compiled image). *File ▸ New
  slides / poster / page…* (`app/NewLayoutDialog.tsx`) offers beamer's slide sizes (16:9, 16:10, 4:3),
  A0/A1 posters and A4 / Letter pages (`layout/templates.ts`); *Page size* on the Layout toolbar
  changes it later (the document's custom paper size). A document is a layout document when it has
  pages; a project holds both kinds side by side.
  * **The file is a plain beamer `.tex`** (so it compiles anywhere, git diffs stay readable, the
    agent and MCP edit it like any document). A page is `\begin{frame}[plain] … \end{frame}`, its
    objects lines of a small macro package the managed block defines (`layout/latex.ts`: TikZ overlay
    pictures anchored at the page corner, adjustbox for crops, beamer's `\only` for steps):
    `\begin{olbox}{x=20mm,y=30mm,w=100mm,h=40mm,fill=paleblue,radius=3mm,pad=4mm,font=25pt} … \end{olbox}`,
    `\olshape{x=…,vb=0 0 40 30,fill=red!20,draw=black,line=0.8pt,arrows=-Stealth}{M 0 0 L 40 0 …}`,
    `\olimage{x=…,crop=0.1 0 0 0.2}{figures/plot.pdf}`, `\begin{olgroup}{step=2-} … \end{olgroup}`,
    `\begin{olraw}{x=…} …LaTeX… \end{olraw}`, `\olpage{fill=…,transition=fade}` and `\note{…}` (speaker
    notes). Geometry is millimetres from the page's top left, `rotate` TikZ's (counter-clockwise,
    about the centre); colours are xcolor's (`jblue!25`, the document's own `\definecolor`s,
    `[HTML]D62728` for a picked colour); keys a version does not know are kept. In the document model a
    page is a paragraph of layout `OLPage` holding object insets (as LyX keeps a box in a paragraph),
    so diffs, merges, tracked agent edits and the source map work on pages unchanged; the editor
    converts them to typed ProseMirror nodes (`ol_page`, `ol_box`, `ol_shape`, `ol_image`, `ol_group`,
    `ol_raw`, `ol_notes`; `convert.ts`). The writer puts every shape's path into its box's millimetres
    (`shapeInBoxUnits`: TikZ overflows on a path stretched much more one way than the other).
    Anything else inside a layout frame is kept verbatim where it stood (an unplaced raw object).
  * **Canvas** (`editor/layout/controller.ts`, a plugin of the shared assembly, so the VS Code
    extension has it too): Keynote's selection with Inkscape's modifiers — a click selects (Shift adds or
    takes out), a drag moves; **Ctrl/⌘ (Inkscape) or Shift constrains** every gesture: a move goes only
    horizontally or only vertically (objects, and nodes in the node editor), a resize keeps the
    proportions (images keep them by default), a rotation and a drawn line or pen segment go in 15°
    steps (a line drawn with Shift in 45°), a rectangle or ellipse is square — pressed or released
    mid-drag it applies at once (`runGesture` replays the pointer on modifier keys). **Space** while
    dragging leaves a copy where the objects are at that moment (Inkscape's stamp; formerly Ctrl-drag);
    Alt disables snapping (and resizes about the centre). A drag on empty page **or on the canvas
    beside it** (the scroller's padding too: `onCanvasDown`) is a rubber band selecting what it
    encloses; with Shift a drag that starts on an object is one as well. A click on nothing selects
    nothing — no objects and no caret in a box (`deselectAll`: a hidden gap cursor at the page's start,
    where typing, Delete and Enter do nothing, and pasted text becomes a new text box; *Insert ▸
    Graphics* places an image object on that page, and the other inserts ask for a text box first —
    ProseMirror would otherwise put them into the page's speaker notes or onto a new page:
    `editor/commands.ts outsideLayoutText`). The pointer is
    an arrow on the canvas and over objects, the text cursor over the box being edited or a selected
    one (`ol-edited` / `ol-sel` marks). The Layout toolbar keeps its width whatever is selected
    (disabled position fields and box style when nothing applies), so the page never jumps under the
    pointer. A second click (or a double click, or typing) edits a text box, Esc returns
    to the box. Moves and resizes snap to the page's edges and centre and the other objects' edges and
    centres, with guides; arrow keys nudge 1 mm (Shift 10, Alt 0.1). Objects dropped on another page
    move there. Live previews are transactions outside the undo history; the result is one undoable
    step (and collaborators see objects move live). Everything on a page is sized in CSS through
    `--ol-mm` / `--ol-pt` (never CSS zoom or transforms on the editor). A document opens with its whole
    page in the window; a trackpad pinch or Ctrl/⌘ + wheel zooms the canvas about the pointer (Safari's
    gesture events too), Ctrl+Plus / Minus and the status bar's zoom step through the usual percentages
    of the paper's real size, *Fit* returns to the whole page (`layoutZoomStep`, which both shells'
    zoom commands try first). Text boxes with *height follows the text* grow with what is typed.
  * **Tools** (the *Layout* toolbar, `app/layouttoolbar.tsx`, and Inkscape's keys): select (V), text
    box (T), shapes (R rectangle, E ellipse, palette), line (L), arrow (A), Bézier pen (B: click =
    corner, drag = smooth node, click the first node / double-click / Enter finishes), pencil (P,
    smoothed), node editor (N or double-click a shape: drag nodes and handles — smooth nodes keep their
    handles in line — double-click the outline for a node, Delete removes one, C toggles smooth /
    corner), crop (C or double-click an image: the handles crop, dragging the picture pans it), images
    (upload, the project's files, paste or drop onto a page), raw LaTeX. Arrangement: front / forward /
    backward / back (Ctrl+Shift+] … — the order in the file is the drawing order), align and distribute
    (one object aligns on the page), group / ungroup (Ctrl+G / Ctrl+Shift+G), rotate and flip, lock
    (a locked object is not hit by clicks: backgrounds). Style: fill and outline (the document's own
    colours first, LaTeX's, a picker, lighter / darker mixes), line width in pt, dashes, arrow tips,
    opacity; a text box's margin, corner radius, vertical and horizontal alignment (ragged right by
    default, like Keynote; *justified* writes `align=justify`), base font size and line spacing;
    X / Y / W / H / angle fields in millimetres. Pages: new, duplicate, delete, move, background,
    transition, name, speaker notes under the pages. The documents panel lists the pages.
  * **Slide rail** (`editor/layout/rail.ts`, PowerPoint's thumbnail pane; created by the layout
    controller for a deck — several pages, or one slide-sized beamer page — so both shells have it): a
    live miniature of every page left of the canvas, numbered, the current one marked as the canvas
    scrolls or an object is picked. A thumbnail is a copy of the page's own DOM drawn at 320 px and
    scaled (as the presenter view draws pages), redrawn when that page's DOM changes (a mutation
    observer; selection marks do not count); it is not inside `.lyx-editor`, so the page's objects
    appear twice in the DOM — e2e specs scope their locators to `.lyx-editor`. The rail lies over the
    scroller's left edge inside the editor column (`--ol-rail-w` makes room on the canvas, `fit()`
    subtracts it); « folds it to a strip (remembered, `ol.slides`; folded by default on a phone). A
    click goes to a page, a drag reorders (`movePageTo`), right-click or ⋯ has New slide ▸ layouts,
    duplicate, delete, cut / copy / paste of whole slides, move, transition and *Present from this
    slide*; with the rail focused ↑ ↓ Home End move, Enter adds a slide, Delete removes one,
    Ctrl+D duplicates, Ctrl+↑ / ↓ reorder, Ctrl+Z undoes (each command is its own undo step:
    `stopCapturing`), F5 presents, Esc returns to the canvas.
    *Notes* in its header (and the Layout toolbar's notes button) shows the speaker notes under the
    pages, remembered per browser (`ol.notes`); a page without notes then offers *Click to add speaker
    notes* (`PageView`), so showing them adds nothing to the file. In notes, keys type (the canvas's
    tool letters and object keys stay out of them).
    **One slide at a time** (PowerPoint's Normal view; `controller.ts syncShownPage`): in a deck the
    canvas shows only the page that holds the selection — the other pages are `display: none`
    (`.ol-single`, `.ol-shown`) but keep their DOM, which the thumbnails copy and where formulas are
    still drawn in idle time. So everything that moves the selection turns the slide: the rail, the
    sorter, the outline, Find. PageDown / PageUp (not while text is being edited), the arrows and
    Home / End with nothing selected, and the wheel beyond the slide's top or bottom edge (once per
    flick: 60 px of scrolling, then 450 ms of rest) turn it too. The slide is fitted to the window with
    its notes under it, centred, and nothing scrolls at the fit; the fit uses the scroller's offset
    size, so the scroll bars a zoom brings do not change it. Zoomed, its margins stay what they were at
    the fit, on both sides (`--ol-single-top` / `--ol-single-bottom`), so a pinch keeps the point under
    the pointer anywhere on the slide. Hidden pages are not measured against the PDF; a page is measured
    when it is shown. Objects can no longer be dragged onto another page of a deck — cut and paste them.
    Rail and sorter address pages by their node views' live positions (`livePos`): their own remembered
    positions are as old as their last refresh, a quarter second after an edit.
    **Slide sorter** (`editor/layout/sorter.ts`, PowerPoint's View ▸ Slide Sorter; the grid button in
    the rail's header or its folded strip, or the rail's menu): every slide as a card over the canvas
    and the rail, with its number, name (or first words), transition, animation clicks and whether it
    has notes. Click selects, Shift+click a range, Ctrl/⌘+click toggles; dragging moves the selection
    (`movePagesTo`, only the moved pages are taken out and put back); Delete, Ctrl+D (copies after the
    last selected), Ctrl+C / X / V (the rail's slide clipboard), Ctrl+Z / Y, arrows and Shift+arrows by
    the grid's columns, Ctrl+A, F5 / Shift+F5; the right-click menu sets a transition for the whole
    selection. Enter or a double click opens the slide in the canvas (the double click's target is the grid, which
    captured the pointer — the card is looked up under it), Esc or *Done* returns to the focused one
    (the canvas behind follows the focus all along). The slider sizes the cards
    (`ol.sorter`); only their scale changes. Rail and sorter share `slidekit.ts` (thumbnails, the
    mutation filter, the layout picker, the clipboard, `undoStep`).
    **New slide layouts** (`editor/layout/slidelayouts.ts`): Title slide, Title and content, Section
    header, Two content, Comparison, Title only, Big statement, Blank — in the deck's own style, read off
    its pages since a beamer file has no masters (`deckStyle`: the title box most content pages share,
    the largest box below it, the most common background, the objects repeated on at least 60 % of the
    content pages — footer bars, logos — which come along; the Title slide is the first page with its
    text taken out). New boxes are empty and named (`name=Title`, `Text`, `Subtitle`, …): the editor
    shows *Click to add title* in them (`BoxView` prompt, gone while the caret is in the box, never in
    the PDF, a thumbnail or the presentation), and text typed into an empty title starts with the
    deck's title formatting (the layout plugin re-sets the stored marks, also after the box grows).
    An empty page is written with `\olpage{}`, so it is read back as a page, not as a linear frame.
  * **Animations and presentation** (`editor/layout/present.ts`): an object's *step* is a beamer
    overlay specification (`2-`, `2-4`, `1,3-`): the PDF gets one page per step, as beamer does, and
    the badge on the canvas shows it; *Animation* picks the step ("appear next") and an entrance for
    the live presentation (fade, fly in from a side, zoom, wipe). **F5** (or *View ▸ Presentation
    mode*, Ctrl+Enter from the current page) presents full screen: pages at the screen's size (copies
    of the editor's DOM re-sized through `--ol-mm`, so text and formulas stay sharp), →/Space/click
    for the next step, ←/right-click back, a number + Enter jumps, B / W black / white screen, L a
    laser pointer, S the presenter view in a second window (this page, the next, notes, timer), Esc
    ends. Page transitions: fade, push, wipe. Beamer's overlays in a box's text work there too
    (`editor/layout/overlays.ts`): `\pause`, `\item<2->`, a list's `[<+->]`, `\only` / `\uncover` /
    `\visible` / `\invisible` / `\alert` / `\textbf<…>` / `\alt`, blocks and theorems with an action,
    `+` and `.` counted like beamer's `beamerpauses`.
  * **Ordinary beamer decks** (frames of text, `editor/layout/beamerslides.ts`): F5 presents them the
    same way, one frame per slide at the deck's aspect ratio in the default theme's look (the frame
    title, content centred or `[t]`, `columns` side by side, blocks and theorems with their titles,
    the title page from the Title… paragraphs or the preamble's `\title` / `\author`, `\setbeamercovered{transparent}`),
    with the overlays above. The parser reads beamer's syntax as LyX does (`tests/beamer.test.ts`):
    arguments with their own delimiters (`\begin{frame}<2->[<+->][fragile]{Title}{Subtitle}`,
    `\item<2->`, `\only<1>{…}`), `\frametitle` / `\pause` / `\column` nested in their frame, a
    separator between two environments of the same style (frames, lists) so they are not merged, item
    commands (`\onslide` in `overprint`), `\mode<article>`, `\begin{column}{w}…\end{column}` as LyX's
    Column paragraph (like `\column{w}`), `\parbox` as a frameless box (its text may have paragraphs);
    the writer no longer drops the arguments
    after an absent optional one. In the editor the frame title and the overlay arguments carry
    LyX's labels (*Frame title*, *On slide*, *Action*, *Default overlay*).
  * **Raw LaTeX objects** are typeset with the document's preamble on a page of the object's size in
    the build sandbox and shown as SVG (`POST /api/docs/:id/snippet`, `server/snippets.ts`; cached by
    content in `data/cache/snippets/`, two at a time) — TikZ, pgfplots or `\qrcode` look as in the PDF.
  * **Fidelity**: pages use the PDF's fonts (`pageFontsOf` in core `layout/model.ts`): beamer's text
    face (CMU Sans Serif, bundled; Noto / Fira / Lato when the preamble loads them, CMU Serif with
    `\usefonttheme{serif}`) at the scale its package loads it (notomath: 0.9 of the nominal size —
    the baselines stay the nominal size's), formulas in Fira Math when the PDF's math is sans-serif
    (beamer's default font theme, notomath's `sfdefault`, sfmath…; `setLayoutMathFont` overrides the
    editor's math font while a layout document is open) at the text's nominal size, without the
    formula fields' padding, an empty script base (`$^{1}$`) taking no room. LaTeX's named sizes are
    the class's absolute sizes (`\small` in a 25 pt box is 10 pt — also in a formula's `\text{\small …}`,
    which becomes the size class `lyx-size-small`), justified boxes hyphenate, colours come from the
    preamble. **Lines as TeX sets them** (a text box is a minipage; styles.css, measured against the
    PDF box by box): the first line's letters touch the top of the box and the last baseline is its
    bottom (a browser puts half the leading plus the font's whole ascent above the first baseline —
    that put every top-aligned text 0.25 em too low); the controller measures the page font with a
    canvas (`--ol-fhalf`, `--ol-asc`, then `--ol-tex-lines: 1`). A display formula gets the class's
    `\abovedisplayskip`/`\belowdisplayskip` (`displaySkips(base)` in `fontsize.ts`, in pt at every box
    size), TeX's empty line above it when it starts a paragraph (then `\belowdisplayshortskip`), no
    line after it when it ends one (ProseMirror's trailing break overlaps it) and no skip at the end
    of the box; the layout plugin marks those displays and paragraphs (`ol-disp-first`/`-last`,
    `ol-par-disp-first`/`-last`). Beamer's lists: the text `\leftmargini` in (2 em of `\normalsize`),
    the label `\labelsep` before it, 3 pt between items, the bullet of the preamble's
    `\setbeamertemplate{itemize item}[triangle|circle|square|ball]` in its `\setbeamercolor{itemize item}`
    (`--ol-leftmargin`, `--ol-bullet`, `--ol-item-color`; copied into a presentation with
    `TEX_LINE_VARS`). What remains different is horizontal: the browser breaks lines greedily where
    TeX optimises the paragraph, and glyph widths differ by about 1 %.
  * **The check against the PDF** (core `layout/check.ts`): the `olbox` macro sets a box's text at
    its natural height first (then places it exactly as before — the PDF is unchanged, pixel for
    pixel) and writes `<job>.olx`: the class's display and list spacing once (`\abovedisplayskip`…,
    `\leftmargini`, `\labelsep`, `\itemsep` from `\@listi`), and per box and slide its frame, geometry,
    natural height, inner height and baselineskip. The server keeps the source as built
    (`<job>.olsrc`, before the path rewriting) and answers `GET /api/docs/:id/layoutcheck`
    (`layoutCheckOf`): each record paired with its box by frame and geometry (the n-th of equal ones),
    `fresh` while the box's source is unchanged since the build. A document last saved before these
    macros builds with today's managed block anyway (`freshManagedBlock`; the file changes on its next
    save). The editor fetches the check after every build (App.tsx on a new PDF and on opening; VS
    Code: the host posts `built`, the bridge answers `layoutcheck` from the `.olx` beside the file and
    the source it compiled), puts TeX's spacing in place of its tables (`applyTexParams`), and
    compares each fresh box's text height (its paragraphs' margin boxes, in layout pixels) with TeX's:
    a **red !** where the text runs out of its box in the PDF by more than a quarter line (a click
    makes the box that tall), an **amber ≠** where it has another number of lines (or, with display
    formulas, another height) than here. Marks belong to the node: editing or moving a box drops its
    mark until the next build. Empty boxes (background cards) are not compared. A box whose formulas
    are not drawn yet (pages far from the viewport draw theirs in idle time) is measured once they are,
    and again once the fonts they brought in have loaded; such statically drawn formulas have the
    editable ones' metrics on pages (no field padding, displays at the text size). Macro files the preamble `\input`s
    keep OverLyX's `%% @display` forms (`macrosFromLatex`). The example `poster_bernstein26` (a beamerposter of minipages and
    tcolorboxes) was rebuilt as native objects by `scratch/layoutmode/poster-gen.mts` and compiles to
    the same poster.
  * **Builds of documents in sub-folders**: `\input{../macros}`, `\graphicspath{{../figures/}}` and
    `\includegraphics{../logos/x}` are rewritten to project paths for the build (`server/texpaths.ts`)
    — TeX runs with `openin_any=p`, which refuses `../`, and the project root is on TEXINPUTS; the
    editor's image route finds extension-less graphics names the way graphicx does.
* **Font sizes everywhere** (`editor/fontsize.ts`, `app/fontsize.tsx`): the standard toolbar's size box
  (− / field / list / +) sets the size of selected text, of table cells (a cell selection), of a formula
  as a whole (`{\small $…$}` — LaTeX sizes do not work inside math; the formula draws at that size) and
  of a selected text box. Sizes are LaTeX's: a named size (`\small` … `\Huge`) wherever the points match
  one at the document's base size, `\fontsize{N}{1.2N}\selectfont` otherwise (the size mark's `Npt`
  value, read back from the file); on layout pages a point ladder. Colours and sizes set on a selection
  now reach the formulas and insets in it too (their `marks` attribute).
* **Presentation mode**: *View ▸ Presentation mode* (Shift+F11, rebindable) shows the document alone —
  menu bar, all toolbars (the docked contextual ones too), status bar, rulers and side panels are hidden,
  the page keeps its layout and stays editable; Esc leaves, a hint in the corner says so for a moment.
  One module for both shells (`app/presentation.ts`, `html[data-presenting]` in styles.css).
* **Dark mode**: follows the system preference by default. The theme switch in the menu bar (sun =
  light, moon = dark, half circle = default) opens a menu on a click or a right-click (both shells:
  `app/MenuBar.tsx ThemeToggle` / `themeMenuItems`): *Default (follows the system)* — in VS Code,
  where the switch sits in the editor's top bar next to WYSIWYG / TeX / Split, *Default (follows
  VS Code)* —, *Light* or *Dark* (remembered in this browser / webview as `ol.theme`; Default
  removes it), as do *View ▸ Theme* and *Settings ▸ Appearance* in the web client. Below them the
  text tone of the dark theme — white, or a sepia / grey tone like Apple Books' reading themes, for
  everything white on the page (text, formulas, caret; `prefs.darkTone` → `data-tone` on html,
  tokens in styles.css). e2e tests switch with `pickTheme()` (e2e/helpers.ts). Text and formulas are white on a near-black page; everything in
  `packages/client/src/styles.css` goes through the theme tokens at the top of the file (light values
  on `:root`, dark ones on `html[data-theme="dark"]`, set by `app/theme.ts`).
* **Fonts, for the editor and for the PDF separately** (like LyX's screen fonts and document fonts;
  catalogue in `client/src/fonts/catalog.ts`). *Settings ▸ Editor* (per browser, both shells) has two
  choices. *Text font* (`prefs.editorFont`): Computer Modern (bundled CMU Serif, the default), the text
  fonts of the OpenType math fonts listed on https://tex.stackexchange.com/q/425098 and a few more —
  New Computer Modern, Libertinus, STIX Two, XITS, TeX Gyre Termes / Pagella / Bonum / Schola, DejaVu
  Serif, EB Garamond, Crimson Pro, Charis, XCharter, Erewhon, Kp Roman, Concrete, Old Standard, GFS
  Neohellenic, IBM Plex Serif, PL46, Fira Sans, Lato, Noto Sans, Arsenal, Luciole, Pennstander — the
  computer's own Palatino, or *Sans-serif*: San Francisco where the system has it (`--sf-font` in
  styles.css: `-apple-system` / `BlinkMacSystemFont`, then an installed SF Pro by name; on phones —
  coarse pointer, narrow — an installed SF Compact first), else Fira Sans (a saved `noto` preference
  maps to it). Or *As in the document*: the face closest to the open document's roman font (each shell
  reports its header through `setDocumentFonts`, `tests/parity.test.ts`). *Math font*
  (`prefs.editorMathFont`): *Matching the text font* (the MathJax font closest in style to the face,
  the default) or one of MathJax 4's fonts — New Computer Modern, Latin Modern, MathJax TeX (the
  KaTeX look), STIX Two, TeX Gyre Termes / Pagella / Bonum / Schola / DejaVu, Asana, Euler (Zapf's
  letters over New Computer Modern, the font extension) and Fira Math — each made by MathJax from an
  OpenType math font, which MathJax lays formulas out with: its spacing, radicals, wide accents and
  extensible delimiters (`editor/lyxmath/mathfonts.ts`; a saved id of the KaTeX days, 26 Sep 2026,
  gets the closest, `FORMER_MATH_FONTS`). New Computer Modern is in the bundle; another font's module
  is loaded when chosen, and every formula is drawn again (static ones in idle time). MathJax's fonts
  have no public build tools, so the OpenType math fonts MathJax has no font for (Libertinus,
  Garamond, XCharter, KpMath, …) are not offered. The sample under the choices is the test document of
  https://tex.stackexchange.com/q/425098 plus a line of accents. The text fonts are served with the
  client (`client/src/fonts/web`, generated by `scripts/build-editor-fonts.py` from TeX Live, CTAN and
  google/fonts — run it again after changing its tables; needs `pip install fonttools brotli`),
  declared in `fonts/web/webfonts.css` and fetched by the browser only once text uses them; MathJax's
  woff2 files and per-block font data come with the bundle too (`assets/mathjax/<font>/`; the service
  worker precaches only New Computer Modern, and caches the chosen math font whole once the page names
  it — `'math-font'` message on every load, on a change and to a new worker — so that offline no
  formula style that had not been drawn yet falls back; `e2e/offline.spec.ts`). The CSPs allow no other font source. Formulas are
  sized so that their x-height is 1.1 times the text face's (`mathScale`, from the face's and the math
  font's x-heights); `\text` in formulas is the text face (MathJax's `mtextInheritFont`). *Document ▸ Settings
  ▸ Fonts ▸ Font set* writes LyX's `\font_roman` / `\font_sans` / `\font_typewriter` / `\font_math`
  (a .lyx file opens with the same fonts in LyX): each text font with the math font made for it —
  Latin Modern, Libertinus + Libertinus Math, Times + Helvetica + Courier + newtx math, Palatino
  (mathpazo), Charter (Mathdesign), Utopia (Fourier), Crimson Pro + newtx math (Cochineal) — all TeX
  fonts of TeX Live, built with pdfLaTeX; the fields below the set stay editable (*Custom*), and with
  non-TeX fonts the sets step aside. `tests/fonts.test.ts`, `e2e/fonts.spec.ts`.
* **Lists, Google-Docs style** (`editor/commands.ts leaveList`, `editor/plugins/mdrules.ts`): `- ` or `* ` at
  the start of a paragraph starts a bullet list, `1. ` a numbered one, `## ` a heading (Backspace right
  after brings the marker back); Enter continues a list, Enter on an *empty* item ends it, and Backspace
  at the start of an item takes the bullet away and keeps the text instead of joining the paragraphs — a
  nested item moves out one level first. Tab / Shift+Tab nest and unnest (`listIndent`), Alt+Enter always
  starts a plain paragraph.
* **Ruler**: a Google-Docs-style ruler above the page (*View ▸ Ruler*) with draggable margin
  handles sets the text width (also *View ▸ Text width*, `Ctrl+Alt+±`); double-click resets it.
* **LyX math editor**: formulas are edited with our own port of LyX's mathed (`packages/core/src/math`:
  the LyX cell/inset model, a port of `MathParser.cpp` and of LyX 2.5's writer so that edited formulas
  are written exactly as LyX writes them, and a port of `Cursor.cpp`/`InsetMathNest` for the cursor)
  rendered with MathJax 4 (`packages/client/src/editor/lyxmath`: `mathjax-tex.ts` is the TeX input —
  MathJax's packages plus OverLyX's own commands `\htmlClass`, `\includegraphics`, `\raisebox`,
  `\textsc`, stmaryrd's `\llangle`/`\llbracket` as stretchy delimiters, a `\middle` that works inside
  a cell, the document's macros looked up per formula, undefined commands shown in red; `mathjax.ts`
  the CHTML output, one per math font; `core/src/math/mathjax.ts` translates the LyX model into that
  TeX — the cell markup would hide a big operator from TeX's limits rule, so `\sum` & co. are wrapped
  in `\mathop{…}` (MathJax's movable limits: above/below in display style, to the side under
  `\textstyle`, in a numerator or inline, as TeX's `\displaylimits`) and only a written `\limits`
  or a brace forces `\mathop{…}\limits`; `core/src/math/mathjax-macros.json`, from `scripts/gen-mathjax-macros.ts`, is the part of
  LyX's `lib/symbols` MathJax lacks; `scripts/math-mathjax-check.ts` parses a corpus of real
  formulas). Everything behaves as in LyX: cursor
  movement into and out of insets, `^`/`_`, `\` command mode with name completion by Space, Space
  leaves the inset, Backspace/Delete at cell edges dissolve the inset (`pullArg`), big insets are
  selected before deletion, empty scripts vanish, an empty formula left with ←/→ (or Backspace/Delete)
  is removed again, Enter adds rows (an inline formula becomes align),
  Tab moves between cells, LyX's corner markers around every inset on the cursor path, macros with
  arguments are expanded from their definitions with editable argument cells; typing `\` starts a
  command shown red until it names a real command (then green), with LyX's completion in grey — Tab
  completes it; Esc keeps a green command and cancels a red one (LyX cancels both). **The mouse works on LyX's coordinate model** (`editor/lyxmath/geometry.ts`): the
  renderer wraps every cell *and every atom* in `\htmlClass` boxes (MathJax mrows, transparent for
  TeX's spacing; an atom that is one character carries the class itself), so every atom has a box
  and every cell a baseline (a probe in each cell, read in one layout) and a content-tight height —
  MathJax's boxes are exactly as tall and deep as their content, and the glue between two atoms is a
  margin before the second one. On top of that sit ports of `MathData::x2pos` (the nearest boundary, insets kept in
  front), `InsetMathNest::editXY` (nearest cell, down into the inset under the pointer),
  `Cursor::moveToClosestEdge`, `lfunMouseMotion`'s anchor rule (a drag never dives deeper than its
  anchor; an inset off the anchor's chain is taken whole at its closest edge), `normalAnchor` /
  `setCursorSelectionTo` (an anchor inside an inset selects it whole from outside; Shift+click takes
  the clicked inset whole), double click = the cell, triple click = all cells; a drag that leaves the
  formula continues in the text with the formula whole and comes back into it when the pointer
  returns. **Long display formulas break into lines** to fit the text column (MathJax's display line
  breaking, TeX's rules: before relations and binary operators, never inside a script;
  `nodeviews/math.ts breakWidth` gives one-row formulas the column's width less the equation
  number's on both sides, and they break anew when it changes; formulas of several rows stay as
  written). The top cell then has a box per line: a click is resolved on the nearest line, ↑/↓ go
  from line to line before they leave the formula, a selection is painted per line
  (`e2e/mathbreak.spec.ts`); the file keeps the formula as written. At very narrow widths (under
  about 11 em) MathJax's breaker sometimes keeps a long first line when the editor's atom boxes are
  in the formula; that line overflows into the margin like any too-wide formula. The corner markers are drawn as `MathRow::drawMarkers` does (3px hooks one pixel outside
  the inset's box; four corners for fractions, grids and macros) and follow the anchor while the
  mouse selects. Right-click menus on
  formulas, cross-references (go to label, reference format), citations, hyperlinks, child documents,
  insets and tracked changes; `Ctrl/⌘+click` follows a reference or opens a child document; **tabs**
  for open documents (new tabs open right of the current one); the text column is centred and its
  width is a View setting (*View ▸ Text width*, `Ctrl+Alt+±`).
* **Inserting with a selection** (`editor/commands.ts`) never throws the selection away. An inset —
  footnote, note, box, branch, caption, a float — takes the selected text, object or paragraphs in, as
  LyX does (`doInsertInset`: the selection moves into the new inset): a clicked image with *Insert ▸
  Float ▸ Figure* becomes the figure's content (the cursor goes to its caption), *Insert ▸ Caption* on
  a clicked image outside a float makes it a figure with a caption, inside one adds the caption
  paragraph below it (above a table). A new table takes the selection into its first cell. A selected
  object (image, formula, table, inset) is never replaced by a label, reference, formula or other
  inline insertion — that goes right after it; selected table cells keep their content. A selection
  that cannot move in one piece (cells, from inside an inset to outside it) stays, and the inset goes
  after it. Selected text is replaced only by what is typed or pasted over it.
* **A caption is one paragraph** (LyX: `MultiPar false`; also an optional argument and an index
  entry): Enter and Alt+Enter do nothing there and the status bar says why — a paragraph break would
  end the LaTeX argument (`\caption{…}`) and break the build (`editor/commands.ts singleParagraphInset`).
* **LyX toolbars** (a port of `lib/ui/stdtoolbars.inc`): the *Standard* and *Extra* rows, and the
  contextual *Math*, *Math panels*, *Table* and *Review* rows that appear automatically when the cursor
  is in a formula / a table / a document with tracked changes (or always / never: *View ▸ Toolbars*,
  and the three toggle buttons at the end of the Standard row). The Standard row also has a **text colour**
  palette: LyX's named colours plus a native colour picker (custom colours are written as
  `\textcolor[HTML]{RRGGBB}{…}` and read back from the `HTML`, `rgb`, `RGB` and `gray` models). **In a formula** the same
  palette colours the formula's selection as LyX does (`InsetMathNest::handleFont2`: `{\color{red} …}`, a picked colour
  `{\color[HTML]{RRGGBB} …}`, `MathCursor.setColor`): a selected colour group (or all of its content) changes colour, colours
  inside a new selection give way, *Default colour* removes a group (`{\normalcolor …}` for part of one), and with no selection
  a group opens for what is typed next; the button shows the colour at the cursor (`colorAt`). The palette holds the formula
  (`TextColorPalette` in toolbars.tsx) so the native picker taking the focus does not drop its selection. Named colours are
  drawn with the same `.lyx-color-*` classes as coloured text (dark mode included) — also a whole formula coloured as part of
  a text selection (`applyNodeFont`) — others through MathJax's RGB model (it knows no `HTML` model); the writer requires
  `color` / `xcolor` for them. The math row has LyX's buttons plus a
  **delimiter palette** (pairs × sizes: `\left…\right`, plain, `\big`, `\Big`, `\bigg`, `\Bigg`, incl.
  `| |`, `‖ ‖`, `⟨ ⟩`, `⟪ ⟫`, `⌊ ⌋`, `⌈ ⌉`, `⟦ ⟧`, arrows) and all of LyX's symbol panels (Greek, arrows,
  relations, operators, dots, decorations, big operators, AMS sets, functions, spacings, styles,
  fractions, fonts) rendered with MathJax. `⟪ ⟫` (`\llangle … \rrangle`) are no LaTeX/LyX delimiters:
  the first use adds a small macro to the document preamble (`packages/core/src/math/llangle.ts`) that
  makes the plain, `\left…\right` and `\bigl…\bigr` forms compile with symmetric scaled brackets. The
  table row implements LyX's `tabular-feature` commands (`packages/client/src/editor/tablecommands.ts`).
  **Tables are as wide as LaTeX sets them**: `l` / `c` / `r` columns take their content's width and never
  wrap, a `p{…}` / `m{…}` / `b{…}` column (or a `\multicolumn{n}{p{…}}`) gets its width from the
  table's `<colgroup>` and wraps there (core `schema.ts` `lyxLengthCss`: `cm`/`in`/`pt`…, and
  `30text%` / `0.3\linewidth` of the text column, `--ol-column`), and the `X` columns of a
  `tabularx` (LyX's variable-width columns, `varwidth="true"`) wrap and share equally what the other
  columns leave of the table width — Table width, else `\columnwidth` — as tabularx sets them: the
  schema draws them `calc((width − var(--ol-xrest)) / n)` and `editor/plugins/tabularx.ts` measures
  `--ol-xrest`, the other columns' drawn width. **Wrapping text in a column** is the table toolbar's
  column width palette (also Table settings ▸ This column ▸ Width, Edit ▸ Table, and the right-click
  menu's "Wrap text in this column"): LyX 2.4's three kinds — natural (`l c r`), variable (`X`,
  wraps to fill the table) and fixed (`p{…}`, a width typed as `5cm`, `30%` or `0.4\linewidth`,
  stored as the LyX length) — with `Tabular::setColumnPWidth`'s side effects
  (`tablecommands.ts setColumnWidth`); a multi-column cell takes a width of its own (never `X`).
  A table typed as a formula (one `matrix` / `smallmatrix` / `array` alone in the formula) cannot
  wrap — LaTeX sets math on one line — so the palette says so there and offers **Convert to table**
  (also the formula's right-click menu and the math toolbar's `m-totable`): `editor/formulatable.ts`
  writes the grid as a tabular (`\text{…}` as text, `\mathbf{\text{…}}` as `\textbf`, other math as
  `$…$`, numbers as text) and reads it back through the pasted-LaTeX parser (`api.parseClip`).
  A **table on a line of its own** — a
  tabular, or a formula that is one `matrix` / `pmatrix` / `array` … (a table typed as
  `$\begin{matrix}…\end{matrix}$`) alone in its paragraph, blanks, labels, a caption, a display formula
  or a figure beside it allowed (`editor/plugins/widetables.ts`) — is centred on the text column; one
  wider than the column spills into both margins by the same amount, as far as the page reaches on
  the left, and the rest overflows to the right (the page scrolls) — the rule of wide display
  formulas. A table amid text stays in the line; a paragraph set flush left / right keeps its alignment.
  The dotted cell grid (LyX's hint for boundaries without a line) and the boxes of a formula's empty
  cells show only while the cursor is in that table / formula (`editor/plugins/envfocus.ts` marks the
  table with `ol-editing`; the static formula rendering hides its `lm-empty` outlines) — a document
  reads as it prints, the scaffolding appears where one works.
* **Landing page / sign-in** (`app/Login.tsx` + `app/landing.css`): a hero (wordmark, tagline, pitch
  list, GitHub links) with the sign-in card beside it — *Continue with Google* is the way in (repeated
  at the bottom of the page); the username + password form (accounts created by an administrator,
  e2e) is folded away behind a small link while Google sign-in is configured, and is the only form
  otherwise; *Get the VS Code extension* sits right under the Google button with the same weight,
  linking to the newest GitHub release. The Google buttons carry the location hash as `?next=`,
  so a deep link (`#/owner/project/doc.tex`, a share link) is where the sign-in returns to; a share link
  that did not open, or a guest asked to sign in, shows a note above the button (and *Continue as
  a guest for now* to go back). Below the hero, a demo gallery wheel with four clips
  (`public/landing/*.{webm,mp4,jpg}`): real recordings of the editor (WYSIWYG math typing, the raw
  .tex split, two authors live with a margin comment thread, the VS Code extension), each in a light
  and a dark variant picked by the visitor's theme. One clip shows at a time: it plays once when the
  wheel is scrolled into view, halts on its last frame for a beat, then the wheel slides to the next
  and wraps around; ". o .." dots under the wheel show the position and jump to a clip, and ↻ on the
  frame replays the one showing. Regenerate the recordings with `scripts/recording/` (see the
  comments in `record-demos.spec.ts` — an isolated instance — and `record-vscode.mjs` — xvfb);
  `e2e/landing.spec.ts` covers autoplay, rotation, the dots, replay and the theme swap.
* **PDF viewer and SyncTeX** (`app/PdfViewer.tsx`, pdf.js): the built PDF is shown in its pane
  by our own viewer (fit-to-width / zoom, page navigation). **Pinch zoom**: a trackpad pinch
  (Ctrl + wheel in Chromium and Firefox, Safari's gesture events) or Ctrl/⌘ + wheel zooms about the
  pointer, one step per frame; meanwhile the drawn pages stretch and are drawn anew once the pinch
  settles (160 ms). A page whose canvas would exceed 2²⁵ pixels (an A0 poster zoomed in — browsers
  draw nothing on far bigger canvases) is drawn coarser, with a sharp detail canvas (`.pdf-detail`)
  over the part in view and half a window around it. A **rebuilt PDF replaces the old one
  without a flicker**: the new document loads while the old pages stay in view (one shared pdf.js
  worker, so no worker start-up per build), each page is rendered off-screen and copied onto its
  canvas in one step, and the view stays on the same page at the same offset into it (not the
  scroll fraction, so pages added above do not move it). A project's `.pdf` files open in a tab of their own from the file browser (ids
  `pdf:<project>/<file>`), like an editor tab in VS Code. latexmk runs with `-synctex=1`; *Navigate ▸
  Sync to PDF* (`Ctrl+Alt+J`, the panel's ⇄ Sync button) finds the cursor's line in the LaTeX as
  built (`app/sourcelocate.ts`) and asks `synctex view` (server, `export.ts`) where it is — the
  viewer scrolls there and flashes the box; a double-click on the PDF asks `synctex edit` for the
  source line and puts the cursor into the paragraph or formula with those words (inverse search).
  *Document ▸ Start Appendix Here* marks the cursor's paragraph as the start of the appendix
  (LyX's `\start_of_appendix`, written as `\appendix`).
  **Dark pages** (`app/pdfdark.ts`, like PDF Expert's night mode): in the dark theme the pages are
  light on dark — the paper in the editor's page colour (`--page-bg`), the ink in its text tone
  (`--editor-fg`, so the sepia / grey tones apply), colours with their hue kept (inversion + a 180°
  hue rotation) — and the graphics are smart-inverted like the editor's figures
  (`editor/figureinvert.ts`: line art on white is inverted, a photograph is not). Each included figure
  (a form XObject — what `\includegraphics` of a PDF becomes; `formRects` walks the operator list for
  its box, through the transforms and transparency groups) is judged as a whole: a plot or diagram on
  white turns light-on-dark with everything in it, its heat maps and colour bars too (no patchwork of
  dark and light panels in one figure), except the photographs placed in it (grainy raster images,
  `texture` ≥ 0.25 — heat maps and charts are flat between their edges); a photo-like figure keeps its
  colours. A raster image outside any figure (a PNG or JPEG included by itself; pdf.js reports where
  it drew each, `recordImages`) is judged by itself. What keeps its colours is copied back from the
  unfiltered rendering; with *Invert figures* off every graphic keeps its colours. The classifier
  samples a picture without smoothing (fine black lines stay black) and takes a two-tone picture —
  dense black marks on white, a spike raster — as line art however dark it is. The colours are baked into the canvas when a
  page is drawn (an SVG filter through the canvas's `filter`, pixel by pixel where a browser lacks it —
  Safari); a CSS filter on the canvases cost a re-filter on every frame and halved the frame rate
  while scrolling. The ◐ button in the PDF toolbar (dark theme only) and *Settings ▸ Editor ▸ PDF*
  switch it (pref `darkPdf`); the VS Code PDF panel follows VS Code's dark themes the same way.
  `e2e/darkpdf.spec.ts` reads the canvas pixels back.
* **Panes: WYSIWYG · TeX · PDF** (web client, `app/panes.ts`, `app/PaneSwitch.tsx`): the writing
  area shows the rendered document, its LaTeX source and the PDF side by side — any one, two or all
  three, in any order (Overleaf's split view with a third pane). The switch in the middle of the menu
  bar has a chip per pane, standing in the panes' order: a click shows or hides one (the last one
  stays), a double-click shows it alone, dragging a chip sideways moves its pane; ▾ draws all fifteen
  arrangements as small pictures, plus *Mirror* and *Equal widths*. The dividers between panes are
  dragged; order, visibility and widths are kept per browser (`ol.panes`). A pane's width is its
  weight as `flex-grow`, scaled over the panes on screen to add up to their number (`paneGrow`):
  flexbox shares out only part of the row when the factors add up to less than 1, which left a blank
  column after the PDF was closed beside a narrowed document. The panes stay mounted in
  one DOM order and are placed with CSS `order`, so rearranging never reloads the editor or the PDF;
  the PDF pane is mounted the first time it is shown and kept. On a phone-width screen one pane at a
  time (the switch works like tabs). The PDF used to be a tab of the right sidebar; that sidebar now
  has *PDF* and *Source* switches beside Comments / Versions / Agent (a stored PDF tab becomes the
  PDF pane once). The VS Code extension keeps its WYSIWYG / TeX / Split switch — its PDF is a VS Code
  panel of its own.
* **The raw view** — *View ▸ LaTeX source beside the document* (or the TeX chip) opens
  `raw:<document>`: the same editor instance with its LaTeX source in the TeX pane (`app/SourcePane.tsx`;
  the hash asks for the pane, and switching it off drops the prefix, so Back undoes it). The server sends the source with a **source map** (`GET /tex?map=1`: the character
  range every top-level paragraph was written to, recorded by the writer — core `WriteTexResult.spans`,
  `latex/body.ts texOnePar`), and `app/sourcemap.ts` builds the mirroring on it: the two **scroll
  together** (the paragraph at the top of one view, and how far it is scrolled into, sets the other; a
  scroll a pane caused itself is recognised by its exact target and not answered), and **cursor and
  selection are mirrored both ways**: the document's selection is a thin bar (its head) and a tint (the
  range, a third `pre` layer) in the coloured source — the textarea's own selection is put there too
  while nobody types in it — and a click, arrow key or drag in the source puts the document's selection
  at those words (drawn as a blinking *mirror caret* / tint, `editor/plugins/mirrorcaret.ts`, while the
  editor has no focus). The words around the cursor are matched (`app/sourcelocate.ts`) *within the
  paragraph's own range only*, so repeated phrases cannot mislead; the pane with the keyboard leads.
  Edits in the source are applied to the document as one types — parsed on the server and merged as a
  diff — a moment after the last keystroke, held back while the LaTeX is structurally unsound: a
  linter (core `tex/lint.ts lintTex`) finds the brace, `\begin`/`\end`, `$` or `\[ \]` without a
  partner and names its line, with `%` comments, `\verb`, URL arguments and verbatim-like environments
  blanked first (`maskOpaque`, also behind the health check's brace count) so a `%` in a URL is no
  false alarm; `checkTexHealth` adds the document boundaries, fragment-aware for child documents. The
  pane's foot lists the problems, each with *go to line*; after an apply it lists what the parser kept
  as raw LaTeX (an unknown environment, with its line: `parseTex` warnings). `Ctrl+Enter` applies at once; the spans are carried through the edits typed so the mirroring keeps
  working meanwhile, and the source is regenerated from the document when the pane loses the focus,
  with the caret and the scroll position kept (mapped through the change; `Ctrl+Alt+S` toggles the pane).
  The menubar's right side names the project.
* **Section folding**, Google-Docs style (`editor/plugins/fold.ts`, both shells): an arrow left of a
  heading (Part … Subparagraph, numbered or not; shown on hover, always while folded) folds away
  everything up to the next heading of the same or a higher level. A right-click on the arrow, the
  text's right-click menu (*Sections*) and the View menu fold or expand this section, every heading
  of its level (*Fold all at this level* — all subsections, say — and *Expand all at this level*),
  or all of them (*Fold all sections / Expand all sections*). Folding is a way of looking, never a change: no step touches the document, and
  whatever puts the cursor into folded text — find, the outline, a label jump, Back — unfolds that
  section (a selection reaching into a fold from visible text, Select All, does not); ↑ / ↓ beside a
  fold skip it. **The folds are the user's**: kept with the account per document (`user_doc_state`,
  `GET/PUT /api/docs/<id>/folds`, by heading layout + text + which of the equal headings; viewers
  keep theirs too), so every browser and device shows them, other people see their own; the browser
  keeps a copy per user (`ol.fold:<user>:<doc>`) for offline use and a quick start, the newer of the
  two wins when a document opens, a change goes up half a second later (a keepalive request when the
  tab closes). A guest who signs in keeps theirs; they go with a deleted project. The VS Code
  extension keeps them in the webview. **Nothing jumps**: a fold holds the clicked heading (or, from
  the View menu, the first block in view that stays visible) at the same place on screen — the
  browser's own scroll anchoring is off for that moment, and a fold near the end gives the page a
  blank end so the heading can stay (recomputed on the next fold change). Closing a menu gives the
  focus back without scrolling to a cursor that is off screen. The folded headings are positions mapped through every transaction; a collaborator's
  change arrives from y-prosemirror as a whole-document replacement, so the heading is found again by
  node identity (unchanged paragraphs keep their node objects) or by layout and text.
* **Dashes**: Alt+- types an em dash (—), Alt+Shift+- an en dash (–) — the characters themselves,
  written as `---` / `--` (on a Mac ⌥⇧- stays the system's em dash). The hyphenation point `\-`
  that Alt+- used to insert is in *Insert ▸ Special Character*.
* **Command palette** (`app/MenuBar.tsx`): `Ctrl+Shift+P` (`⇧⌘P` on a Mac; `F1` as well) or the
  *Help* menu opens a search over every menu item and the shortcut table — results show the menu
  path and the shortcut, ↑/↓ + Enter runs one, Escape returns the keyboard to the text. The ✎ next
  to a result records a new shortcut for that command (Backspace: none, ↺: default); a key another
  command uses asks first and then moves over. User shortcuts live in `localStorage.ol.keys`
  (`app/keybindings.ts`): a global listener runs them and swallows the default keys of rebound
  commands, so the editor's built-in bindings never fire for them. Shortcuts are written once in LyX
  style (`Ctrl+Alt+O`) and rendered per platform (`⌥⌘O` on a Mac; `app/shortcuts.ts`). LyX's
  `Ctrl+Shift+P` (typewriter) gave way to the palette; give it a key there if you want one.
* **Shortcut tips** (`shortcuttips.ts`): an action that has a shortcut but is taken with the mouse —
  a toolbar button (the shortcut at the end of its tooltip), a menu entry, a palette result, the
  right-click menu — shows a small tip with the shortcut, below the button or where the entry was,
  from the third time on and five times per shortcut (counted per shortcut, so toolbar and menu add
  up; `localStorage.ol.shortcutTips`). Pressing the shortcut once ends its tips; the tip never takes
  the focus, lets clicks on its text through and closes after 5 s. *Don't show again* switches them
  all off (pref `shortcutTips`: *Tools ▸ Shortcut tips after mouse actions*, *Settings ▸ Editor ▸
  Shortcuts*, which can also start the counts over). Web client and VS Code extension alike.
* **Text-file tabs and the source pane** (`app/TextEditor.tsx`, `app/SourcePane.tsx`, shared logic
  in `app/codearea.ts`): a textarea under a coloured copy of the text (`app/texhighlight.ts`) with
  VS Code habits — own undo / redo (`Ctrl+Z`, `Ctrl+Shift+Z` / `Ctrl+Y`; the browser's breaks as soon
  as a script sets the textarea's value), the bracket pair at the cursor marked (and, when the
  cursor is not next to one, the enclosing pair underlined; `\{` only matches `\}`; comments are
  skipped), bracket pair colours by nesting depth, the current line marked, auto-closing `{ [ ( $`
  (only before whitespace / a closer / the end; typing the closer steps over it; Backspace inside an
  empty pair removes both; a selection gets wrapped), Enter keeps the indentation, opens `{}` over
  three lines and completes a `\begin{env}` line with its `\end{env}` when it is not closed yet,
  Tab / Shift+Tab and `Ctrl+]` / `Ctrl+[` indent the selected lines, `Ctrl+/` toggles `%` comments,
  `Alt+↑/↓` move lines (`Shift+Alt+↑/↓` copy them), `Ctrl+Shift+K` deletes them, Home goes to the
  first non-blank character first.
* **Back / Forward** (`app/navhistory.ts`): `Ctrl+Alt+←` / `Ctrl+Alt+→` (`⌥⌘←` / `⌥⌘→` on a Mac;
  *Navigate* menu) walk a VS Code-style history of the places the cursor has been — across the tabs
  of the workspace. Jumps make entries (following a cross-reference with Ctrl+click or the context
  menu, the outline, a presence avatar, *Go to label*, a far click or find hit, opening another
  tab); typing and stepping through the text only update the current entry, so Back lands where
  one was before the jump and Forward where one was at its target. Places are stored like the cursor
  memory (offset + the text before the cursor) and found again after edits; an entry in a closed
  tab reopens it. The stack survives a reload (`sessionStorage.ol.nav`). Both keys can be rebound
  from the command palette (e.g. to `Control+-` / `Control+Shift+-`, VS Code's Mac defaults, should
  the browser claim ⌥⌘←/→).
* **Outline operations** (`editor/outline.ts`, buttons ▲ ▼ ◀ ▶ on the hovered / active outline
  row, also *Edit ▸ Paragraph ▸ Move section up/down, Promote, Demote*): LyX's outline-up/down/in/out —
  a section (its heading up to the next heading of the same or a higher level) swaps places with
  its previous / next sibling, never leaving its parent; promote / demote change the level of its
  heading and of every sub-heading in it by one step of the class's ladder (an article has no
  Chapter, so Section promotes to Part).
* **Notes & comments in the margin** (*View* menu / toolbar): the note cards sit in a column right
  of the text, Google-Docs style, stacked without overlap and anchored by small coloured squares
  in the text (`editor/plugins/margin.ts`); a folded note is a card with its label and a one-line
  excerpt, its label unfolds it (and the cards below move down); the − / + buttons on the ruler over the note column make the text
  of notes and comments smaller / larger (`localStorage.ol.noteScale`, 60–130 % of the document
  text, 90 % by default, double-click the label to reset — inline notes follow the same setting); the
  column narrows on a small window and the text keeps at least 360px. Notes and comments are set
  in the interface's sans-serif.
* **Margin ink** (the pen button in the toolbar; `editor/plugins/ink.ts`, `core/ink.ts`): Goodnotes-style
  drawing in the space left and right of the text — the page grows wide gutters to pan into and snaps
  back to centre; on tablets the pen comes out by itself (`localStorage.ol.ink` overrides). Strokes
  and pasted images are anchored to the paragraph beside them (an invisible `\olsketch{figures/ink-….svg}`
  in the .tex, the drawing in a sidecar SVG the server writes; nothing shows in the PDF) and move with
  the text; the text column still fits the pane, so a narrow one (the PDF beside the text on a
  tablet) reflows the text instead of cutting it off at both sides. The bottom *Draw* row has a pen and a highlighter (each with its own colour and width),
  an eraser (whole strokes, also the pen's eraser end), a lasso (closes itself, selects whatever it
  touches; drag to move, corner handles to resize, Delete) and a **laser pointer**: a glowing trace
  over the text or the margins that stays while the pen is down and fades when it lifts — never
  saved, streamed to everyone in the document (in the pointer's presence colour, with their name).
  The colour swatches and width dots are **presets** as in Goodnotes: one click selects, a click on
  the selected one opens a picker (a colour grid / a slider with a preview) that replaces it. Nib
  widths are **millimetres on the page** (the ruler's 96 dpi: 1 mm = 3.78 px at 100 %; pen 0.1–3 mm,
  highlighter 1–10 mm; the strokes themselves stay in px in the SVGs); the pen case is per browser
  (`localStorage.ol.inkPensMm`, an older px case migrates) and shared with the whiteboards. Clicking the
  margin canvas takes the caret out of the text, so `Ctrl+V` then puts an image into the margin
  instead of a LaTeX figure.
* **Whiteboards** (`.board` files, *File ▸ New whiteboard…* or *+ Board*; `app/BoardEditor.tsx`,
  server `BoardDoc` in `docs.ts`): a Miro-style infinite canvas with the same pens, lasso and laser,
  images (paste / drop / upload, move and resize) and sticky notes, live-collaborative through the
  same websocket layer; saved as one JSON object per line, so git diffs stay readable.
* **Comments panel** (right sidebar, *Comments* tab; `app/Comments.tsx`, `editor/commentops.ts`):
  every comment thread of the open editors — open ones first, then the *Resolved* archive, like
  Google Docs' comment history. A resolved thread leaves the text and the margin: only a small grey
  marker stays where it was anchored (its title says so); the panel shows author, time, excerpt and
  reply count, jumps to a thread on click and can resolve / reopen it.
* **Ruler resizes keep the cursor in place**: changing the text width (handles, *View ▸ Text width*)
  reflows the document; the scroll position is corrected so the cursor stays where it was on screen.
* **Toolbars that come and go** (the math rows when the cursor enters a formula, the table and
  review rows) do not move the page: the scroll position is corrected by the height they add or
  take (`App.tsx`, a layout effect on the scroll container's top edge).
* **Sidebars**: the documents panel (left) and the Comments / PDF / Versions panels (right) hide
  with the « » buttons in their tab strip; a hidden sidebar leaves a thin rail with its panels' names
  that brings it back. The state is remembered per browser (`localStorage.ol.files`, `ol.right`; the
  right side starts hidden, a PDF build opens it).
* **Top right, Google-Docs style** (`app/MenuBar.tsx`): the **presence avatars** (profile pictures
  for Google accounts, initials otherwise) are the people in the document — click one to jump to
  where they are editing (their cursor is scrolled into view and flashes) —, then the **Share**
  button (the project's owner only; also *File ▸ Share project…*), the theme toggle and your own
  avatar, whose menu signs out.
* **Right-click menu** (`editor/editormenu.ts`, drawn by `editor/contextmenu.ts` with the line
  icons of `editor/menuicons.ts`), laid out like Google Docs': what the click landed on comes
  first (a cross-reference, citation, link — open, edit, copy, remove —, child document, graphics,
  inset, tracked change), then Cut / Copy / Paste / *Paste without formatting* / Delete, *Comment*,
  *Insert link* (⌘K), *Rewrite with AI* (⌘J, when switched on) and *Turn into a formula* for a
  selection, *Format options* (bold … typewriter, alignment, indent depth, paragraph settings),
  *Paragraph style* (the layouts), *Clear formatting* (⌘\\), the insert, sections and
  track-changes submenus, and the spell-checking switches. ↑/↓ choose an entry, → / ← open and
  close a submenu, Enter runs it. Formulas have their own menu (link, AI, numbering, environment,
  label, insert, fonts); a misspelt word puts its corrections first. Shift+right-click gives the
  browser's own menu.
* **Links** (`editor/links.ts`), as in Google Docs: ⌘K / Ctrl+K (also Ctrl+Alt+K, the toolbar's
  link button, Insert ▸ Link…, *Insert link* in the menus) opens the link box under the selection —
  the address for the selected text (plain text within one paragraph), text and address for a new
  link at the cursor, or the link under the cursor to change it; `arxiv.org/…` gets `https://`,
  `a@b.org` becomes `mailto:`. While the cursor is on a link a bubble under it shows the address
  (a click opens it in a new tab — only web, mail and ftp addresses), Copy, Edit and Remove link;
  ⌘/Ctrl+click follows a link, a double-click edits it, and an address pasted over selected text
  links that text. Text links are LyX's hyperlink insets (`\href{…}{…}` in the file). Inside a
  formula the same keys make `\href{target}{…}` in the math model (core `math/ast.ts`, an OverLyX
  addition LyX keeps as an unknown command): the selection — say the `Wang24` of a table's
  `\text{Wang24}` cell — becomes `\text{\href{https://…}{Wang24}}`, drawn in the link colour
  (`.lm-href`; not MathJax's own `\href`, which would navigate on a click), with the same bubble;
  the target is kept as LaTeX (`%`, `#` escaped) and the document loads hyperref.
* **Spell checking** (`editor/spell/`): OverLyX's own checker by default — a Hunspell dictionary
  (nspell) in a Web Worker, chosen by the document's language (English, British, German, French;
  served from `/dict/`, loaded on demand), checking starts as soon as a document opens and only the
  paragraphs an edit touched are re-checked; it knows LaTeX — formulas, cross references,
  citation keys, ERT / listings / typewriter text, acronyms and identifiers are left alone, and so
  is the word under the caret until you move on. Misspelt words get a wavy underline; the
  right-click menu offers Hunspell's suggestions, *Add to the dictionary* (kept per browser,
  `localStorage.ol.spell.words`) and *Ignore*. Preferences ▸ Checker switches to the browser's own
  checker instead (which checks slowly after a click and keeps its suggestions to itself). The
  abc✓ toolbar button, Tools ▸ Spell checking and the context menu switch checking off and on.
* **The Agent panel** (`app/AgentPanel.tsx`, server `agent.ts`): OpenAI Codex embedded in the
  right sidebar, driven over its app-server protocol (the same JSON-RPC interface the Codex VS
  Code extension speaks) — one `codex` child process per signed-in user, `CODEX_HOME` under
  `data/agent-home/<user>/` so ChatGPT credentials and codex's memories are per account and shared
  across that user's projects. Users sign in with their *own* ChatGPT account (device code). A
  thread works in its **private working copy** of the project (`agentwork.ts`,
  `data/agent-work/<thread>/<project>/`) and edits files the way coding agents do — `apply_patch`,
  a script — in codex's workspace-write sandbox whose only writable root is the copy (binary files
  are symlinked in read-only; the sandbox refuses writes through them). Every turn mirrors the
  live project in first (documents as their live source, with the tracked-change markup); every
  applied patch, command and finished turn takes the agent's changes back: a document is diffed
  against what was mirrored and merged into the live document as the agent's tracked changes,
  word by word (`docedit.ts` + `core/src/lyx/trackdiff.ts`, author `Agent panel (MCP)`; a
  neighbouring paragraph somebody changed meanwhile keeps their version — `mergeInPlace`), other
  files (`.bib`, a new figure or `.tex`) are copied into the project, build output stays in the
  copy. What was mirrored is kept beside the copy, so a restart mid-turn loses nothing.
  **Track changes box** (the composer's checkbox, remembered in the browser, sent with every turn):
  unticked, the turn's document changes go in directly (`applyPlainSource`, no marks; manifest
  `tracked: false`), the turn's message gets a note saying so (and another when it is ticked again),
  and the MCP document tools of the panel's agent default to `tracked: false` (`panelTracking`).
  The checkpoint takes such a turn back all the same.
  **Checkpoints and rollback:** every turn that changes files leaves a checkpoint
  (`data/agent-work/<thread>.turns/<n>/`): per file the version its changes can be taken back to (a
  document's live source before the turn's first change to it, with what people edited during the
  turn folded in — `foldEdits`) and the version the agent left; plus a document version "before an
  Agent panel change" (kind `agent`, File ▸ Versions) as a manual fallback. When the turn is over,
  the documents it changed are built (`buildIncluding` reuses a build that already includes the
  last change — the editor's auto-build, the agent's own `build_pdf`) if they had been built before,
  and the result is compared with that earlier build: the panel ends the turn with a card — files
  changed (+/− characters), "✓ builds" or "⚠ no longer builds" with the first errors — and **Undo**
  / **Ask the agent to fix it**. Undo (`undoCheckpoint`, route `…/checkpoints/:n/undo`, the thread's
  owner) restores exactly: the documents return to their state before the turn, marks and all,
  while everything edited since — typing, accepting or rejecting a change — survives (a paragraph
  both the turn and a person changed keeps its current text and is reported); files it copied in
  get their old content back unless changed since; files it created go to the trash; the working
  copy follows. The agent can do the same itself with the MCP tool `undo_turn` (turns_back 0 = the
  running turn, e.g. an edit that broke the build, 1 = the previous editing turn, …; only the
  panel's token has it), and `build_pdf` tells it whether its changes broke the build.
  OverLyX's own MCP connector (a managed `[mcp_servers.overlyx]` entry pointing at `/mcp` with an
  internal per-account token) remains for comments, `build_pdf` and `undo_turn`. Threads started before 27 Sep 2026
  keep their original setup (project directory as cwd, read-only sandbox, every edit through the
  MCP document tools — tracked word by word as well). A write outside the copy is a sandbox
  exception the panel asks the user to grant. The developer instructions steer the agent to explore
  and explain by default — document edits only on an explicit ask — and codex's web_search tool is
  enabled (internet access; sandboxed shell commands still ask). They also tell it the documents
  are live-edited: read a file afresh each turn, never restore earlier content from memory. The panel streams
  message/reasoning deltas, tool calls (folded) and diffs over SSE. Every message carries editor
  context automatically: the open documents and the current selection — as LaTeX (the ⌘J
  conversion) and marked ⟦SELECTION⟧…⟦/SELECTION⟧ in an excerpt of the file. Formulas in the
  transcript (assistant, user and reasoning text) render through the math editor's MathJax path
  with the document's macros; they select as one unit, and copying puts their LaTeX source on
  the clipboard (`app/richcopy.ts`) — so equations round-trip between the transcript, the
  editor (LaTeX paste) and the composer, and a paste into a formula sheds `$…$`/`\[…\]`. Threads belong to the
  project: every editor sees them and can read transcripts, only the creator drives one.
  Each user's codex child is owned by a detached keeper process (`scripts/agent-keeper.mjs`,
  JSON-lines over a unix socket at `data/agent-home/<id>/keeper.sock`): a server restart — a
  deploy — reconnects instead of killing a running turn; buffered events are replayed, pending
  approvals are re-delivered and also returned by the thread read, so the card reappears after a
  reload. Needs `KillMode=process` in the systemd unit. The keeper exits with codex, on idle
  (`KEEPER_IDLE_MS`, default 2 h without a server), or when its socket file is deleted.
  `OVERLYX_AGENT=off` disables it, `OVERLYX_CODEX_BIN` points at a stub for tests,
  `OVERLYX_AGENT_MODEL` overrides the model. The model picker lists what the installed codex
  offers, and new GPT models need a newer codex: `deploy/overlyx-codex-update.timer` runs
  `scripts/update-codex.sh` every night (newest `@openai/codex` from npm, checked by
  `scripts/codex-smoke.mjs` — `initialize` + `model/list` — else the previous version goes back;
  `journalctl -u overlyx-codex-update`). A keeper started on an older codex (the version is
  stamped in `data/agent-home/<id>/codex-version`) is stopped once quiet for `OVERLYX_AGENT_IDLE_MS`
  even with the panel open, so the next request runs the new one.
  **Agents from elsewhere** (`app/ExternalAgents.tsx`, see *MCP connector*): the account's agents
  connected over MCP — Claude Code, Codex, ChatGPT — get tabs of their own at the top of the panel
  (the Agent tab appears when AI assistance is on *or* the account has such agents): status
  (listening / working / connected / offline, the project and document it last worked in, whether
  messages reach it pushed), the conversation, a composer that sends the document and the
  selection along (the same context as a Codex turn), "take back" for a message it has not picked
  up, Forget. **Ask agent about this** in the editor's right-click menu (`editorContext.askAgent`,
  set only by a shell with the panel) pins the selection as the context of the panel's next
  message — to Codex or to an agent from elsewhere — and focuses the composer.
* **AI assistance** (`editor/ai/`, server `ai.ts`; off by default, Tools ▸ AI assistance or
  Preferences — the switches are menu items, so the command palette finds them): needs
  `OPENROUTER_API_KEY` on the server (the same key as "Escalate to AI"); Gemini 3.1 Flash Lite rewrites,
  Gemini 2.5 Flash Lite completes (`OVERLYX_AI_MODEL`, `OVERLYX_AI_COMPLETION_MODEL`). The ⌘J
  panel has its own model picker (kept as the rewrite preference), accepts follow-up instructions that
  refine the shown proposal (Enter with an empty box accepts), and also works in the source view
  (⌘J over selected raw LaTeX proposes raw source; accepting splices it and the live apply carries
  it into the document). Autocorrect (Tools ▸ Autocorrect typos, on by default): a minor typo is
  fixed when the word is finished — dictionary-based (adjacent-swap candidates checked directly:
  Hunspell never suggests 'the' for 'teh'), never in formulas or code, Backspace right after
  reverts and pins the word for the session.
  * *Rewrite with AI* — `⌘J` / `Ctrl+J` (⌘K is the link box, as in Google Docs): select a passage — or nothing, to write at the cursor — and describe the
    change in the small prompt under it. The passage, the instruction and the document's LaTeX
    (for context: notation, macros, citation keys) go to the model; the reply comes back as LaTeX
    parsed into real editor nodes and is previewed *in place* — old text struck through, the
    proposal rendered after it, formulas and citations included. Enter accepts, Esc rejects,
    nothing touches the shared document before that. Inside a formula the same key rewrites the
    formula (or its selected part) and shows the rendered proposal in the prompt.
  * *Autocomplete* — IDE-style inline suggestions: every keystroke schedules a request (200 ms
    throttle, adjustable; one in flight at a time, Gemini 2.5 Flash Lite answers in ~0.5–1 s); the model repeats the sentence up to the cursor and continues it, the overlap is stripped by matching (so spacing is never guessed); the
    continuation appears as grey ghost content after the caret, with any formula in it already
    rendered (the server returns editor nodes, not just text). Typing the suggestion's beginning
    keeps it and shortens it — a reply that arrives while you are typing its first words is shown
    trimmed — anything else dismisses it; Tab inserts the whole suggestion, `⌘/Ctrl+→` its next
    word, Esc dismisses. `✦ AI…` in the status bar shows a request in flight. Inside formulas the
    ghost is rendered by MathJax at the end of the cell (`\htmlClass{lm-ghost}`), typing its first
    characters keeps it, Tab inserts it as LaTeX. Replies are cached and rate-limited per user.
  * *The ✦ toolbar button* — off the toolbar until *Preferences ▸ Show the ✦ AI button* (or Tools ▸
    AI assistance) enables it; it is a plain on/off switch for autocomplete (text and formulas
    together), nothing else — rewriting stays on ⌘J / the Tools menu.
  * *Models* — Preferences ▸ Models chooses the model for ⌘J (rewrite) and for autocomplete separately (a
    list with measured notes, or any OpenRouter id typed in); the choice is per browser and sent with
    each request (`model`, validated on the server); the server defaults apply otherwise.
* **Cursor memory**: a document reopens with the cursor where it was the last time it was open in
  this browser (`localStorage.ol.cursor:<doc>`, `packages/client/src/editor/cursormemory.ts`; the text
  before the cursor is used to find the place again when the document changed meanwhile).
* **LyX-style dialogs**: Paragraph settings (`Ctrl+Alt+P`: alignment, line spacing, indentation,
  label width), Table settings (cell / column / row / table tabs incl. longtable), Document settings
  (class & options, page & margins, text layout, numbering & floats, fonts, branches, PDF properties,
  preamble, raw header), Graphics (scale, width/height, rotation, clipping, LaTeX options), math
  Delimiters and Matrix insertion — all writing exactly the LyX parameters. Right-click menus on formulas (a formula inside the selection — an equation selected whole, text
  dragged across one — gets that selection's Cut / Copy / Paste next to its own entries), cross-references (go
  to label, reference format), citations, hyperlinks, child documents, insets and tracked changes;
  `Ctrl/⌘+click` follows a reference or opens a child document (in place — the documents panel on
  the left is where one switches between the files of the project); *View ▸ Master + child documents in one
  view* shows a paper and its `\include`d children as one scrolling page; an editable **Source pane**
  beside the text (`Ctrl+Alt+S`, the *Source* switch in the right tab strip): the document's LaTeX with
  syntax colours (`app/texhighlight.ts`), following the cursor (`app/sourcelocate.ts`: the words before
  the cursor are searched in the source, or the current row of the formula being edited) — edit and
  *Apply* —, regenerated when the document or its settings change (the header lives in the CRDT's
  `meta` map, which the pane observes: a new class or package shows without an edit), drag its top edge to resize; wide display
  formulas overflow symmetrically into the margins (Google-Docs style) with equation numbers kept
  clear of the formula.
* **Citations from the literature** (`Ctrl+Shift+C` ▸ *Find online / paste BibTeX*): type a title,
  author names, a DOI, an arXiv id or a URL. With a key the search is Scholar-grade: **Google
  Scholar** itself through [SerpApi](https://serpapi.com) (`SERPAPI_KEY`; free tier 100 searches a
  month, its own "cited by" counts and BibTeX) or **Semantic Scholar** (`S2_API_KEY`, free from
  their [API form](https://www.semanticscholar.org/product/api#api-key-form); relevance close to
  Scholar's, BibTeX included) — the first available leads the ranking. Without keys the open indexes
  **OpenAlex** (title/abstract search, citation counts) and **DBLP** (computer science) are used, with
  noticeably weaker relevance. DOIs / arXiv ids are looked up directly. One click
  fetches the BibTeX (DBLP's record, else doi.org content negotiation, else generated from the
  metadata), gives it a Google-Scholar-style key (`vaswani2017attention`, made unique), appends it
  to the project's **`cited.bib`** (created on demand), adds `cited` to the document's BibTeX inset
  and selects it for insertion. A paper the project already has (same DOI, or same title and year, in
  any of its .bib files) is not added twice — its existing key is used. Google Scholar itself has no
  API and blocks servers, so the dialog links to a Scholar search for the query and accepts a pasted
  entry from Scholar's *Cite ▸ BibTeX* the same way. `packages/server/src/bibsearch.ts`;
  `OVERLYX_LITERATURE=off` disables the outbound requests, `OVERLYX_CONTACT_EMAIL` joins the
  OpenAlex / Crossref polite pools (better rate limits; nothing else about users is sent).
  Every added citation also fetches the paper's PDF into the project's **`pdf/`** directory in the
  background, named `authorYY_title.pdf` (`packages/server/src/pdffetch.ts`) — arXiv when the entry
  has an arXiv id, else an open-access PDF OpenAlex knows for the DOI; strictly additive (an
  existing file is never replaced), and paywalled papers are simply skipped.
* **Find & replace** (`Ctrl+F`): find next/previous, replace, replace all, case-sensitive and
  whole-word options, live match count and highlighting. *Document ▸ Statistics* counts words and
  characters of the selection / the document (notes excluded).
* **LyX keyboard bindings** (`cua.bind`/`menus.bind`/`math.bind`): `Ctrl+M`, `Ctrl+Shift+M`,
  `Alt+P …` layouts, `Alt+M …` math, `Alt+A …` paragraph, `Ctrl+E/I/B/U` (emphasis, italic, bold, underline), `Ctrl+L` (TeX code),
  `Ctrl+Alt+F/M/N/C` (footnote / margin / note / comment), `Ctrl+Shift+E` (track changes), …
  See *Help ▸ Keyboard shortcuts*.

## Layout

```
packages/core     document model (lyx/ast.ts, LyX-shaped), .tex parser/writer/importer (tex/),
                  LaTeX writer (latex/, a port of LyX's output_latex driven by LyX layout files),
                  ProseMirror schema, AST⇄PM conversion, macro/bib/comment helpers, LyX file
                  parser/writer (import only)
packages/server   Express + WebSocket (Yjs sync/awareness), SQLite persistence, auth (scrypt,
                  JWT cookie, optional Google OAuth), .tex file sync & watcher, versions, builds
packages/client   Vite + Preact UI, ProseMirror editor, LyX math editor (editor/lyxmath, MathJax 4), LyX keymap,
                  numbering/margin/change-tracking/find plugins
packages/vscode   the same editor inside VS Code (a custom editor for .tex files): an extension host
                  that parses/writes the file and a webview that imports the client's code (@client/*);
                  the outline is a panel inside the editor (the client's `app/Outline.tsx`: click to
                  jump, ▲▼ move a section, ◀▶ promote / demote; the toolbar's outline button, `Ctrl+Alt+O`),
                  the host's Structure tree view in the activity bar mirrors it
* **Theorem environments**: a document's own `\newtheorem{definition}{Definition}` declarations
  become real layouts (`latex/layouts.ts applyDocumentTheorems`, aliased onto the AMS theorem
  styles by label, `Theorem` as fallback) — parsing, writing (the environment keeps its declared
  name; the declaration is never duplicated), and the layout list in meta all honour them.
  Declarations typed into the body are moved to the user preamble on the next save. The math
  parser knows `\operatorname{…}` and `\operatorname*{…}` (symbols.json; the generator keeps
  shipped entries on regen). Markdown files (`.md`) are documents
  too — see *Markdown documents* below.

**One editor, two shells.** The web client (`app/App.tsx`) and the VS Code webview
(`packages/vscode/src/webview/EditorShell.tsx`) do not each assemble an editor: the plugins in their
order, the node views and every view handler (clicks, paste, drop, context menu) come from
`client/src/editor/assembly.ts` (`assemblePlugins`, `editorViewProps`, `installEditorDom`); a shell
adds only how the document is synced — `editor/editor.ts` a Yjs document over the WebSocket with the
IndexedDB copy, `vscode/.../localEditor.ts` a local Y.Doc fed from the file. The seven LyX toolbars
are one definition too (`app/toolbars.tsx buildToolbars`, from a `ToolbarContext`; what only one
shell has — files, navigation history, ink, the comments panel — goes into its *slots*), as are the
document helpers of the shells (`app/shellutil.tsx`). `tests/parity.test.ts` fails as soon as a shell
grows a plugin list, a toolbar button or one of those helpers of its own again — that is how the
extension once lacked autocorrect, markdown headings, image paste and the delimiter buttons. Zoom is
one of those helpers (`applyEditorZoom`: the `--editor-zoom` variable the editor's font size is
computed from); the extension used to zoom with CSS `zoom` on its scroll container instead, which puts
mouse coordinates and layout into different scales in Chromium — drags stopped following the pointer
and selection highlights disagreed with the selection as soon as the document was zoomed.

**How the extension syncs the file.** The TextDocument is authoritative. The webview sends its whole
ProseMirror document (debounced, `update` with the `base` it changed from and a sequence number
`sync`); the host (`host/session.ts writePmUpdate`) three-way merges it onto the file's current parse
(`core/lyx/merge.ts`, paragraph granularity, the disk wins a conflict), writes the LaTeX, and re-parses
it. The merge base is the *file-side form* of the webview's base — the parse of the text that model
was read from or written to (`baseDocument`), never the webview's model itself: the LaTeX cannot
carry a trailing space in a paragraph, a macro keeps the writer's spelling, an empty change-tracked
paragraph vanishes, so the raw model differs from the file's parse of the same state, and each such
spot counted as a change on disk that wins the merge — deleting the last word of a paragraph (its
space stays), then deleting on, brought the word back. A snapshot goes back to the webview
(`externalUpdate`) only when the file changed underneath or the merge altered the update. Every
snapshot names the last update it reflects (`ack`), and the webview merges it against the model of
*that* update (`shared/documentModel.ts SyncLedger`), not against a newer one still in flight: a
snapshot the host computed before a later update arrived (its re-read after an auto save, a refresh
on focus) used to be taken for the newer state and undid that update in the editor — text deleted a
moment ago came back. `tests/vscode-ledger.test.ts` and `tests/vscode-sync.test.ts` cover both;
`packages/vscode/test/probeEditing.mjs` reproduces them in the real extension.

**A save racing an outside write.** When the file changes on disk while the document has unsaved
edits, the host merges the change into the document (`readDisk`; the unsaved text is kept as a draft
in the extension's `recovery` folder first), but VS Code still holds the older file as "saved" and
refuses its own save (*file modified since*). That refusal used to be logged to the console only:
the user believed the file was saved, and the edit never reached the disk. `DocSession.save` now
writes the merged text itself and reverts the document's editor to the file — which then holds the
same text — so nothing is left modified (`resync` in `host/editorProvider.ts`; the revert runs only
once that editor is verifiably the active one), with a status-bar note; a save that still fails, or
an edit the host could not write into the document, is shown as an error with *Retry* / *Save now*.
The integration test (`test/suite/index.cjs`, step 4b) races both the host's save and the webview's.

tests/            vitest: .tex parse/write stability (tex.test.ts: features + a corpus of real
                  papers and LyX's example documents), LyX round trips (import path), PM/Yjs
                  conversions, LaTeX writer unit tests, latexmk compile tests
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

Environment: `PORT` (default 3000), `OVERLYX_PROJECTS_DIR` (default `/root/projects`; one
sub-directory per account, named by its username, and in it one directory per project holding
`.tex` files, figures and `.bib`s — `<dir>/<owner>/<name>`), `OVERLYX_DATA_DIR`
(SQLite, caches, builds, `credentials.txt`), `OVERLYX_CLIENT_DIST` (built client to serve, default
`packages/client/dist`), `OVERLYX_UNLOAD_MS` (how long an idle document stays loaded, default 6 h),
`OVERLYX_MAX_BUILDS` (parallel PDF builds, default 2), `OVERLYX_BUILD_NICE` (niceness of latexmk,
default 10), `OVERLYX_DOC_WORKERS` (worker threads for parsing and writing documents, default the
cores less two, 1–4; `0`: on the main thread), `OVERLYX_MOVE_RECORD_DAYS` (how long a paragraph
split or join is remembered, so that an editor coming back from offline after it still gets its edits
placed, default 30; see *Offline mode*), `OVERLYX_SANDBOX` (`auto` — use bubblewrap when installed, the default; `bwrap` — required;
`none`),
`LYX_LAYOUT_DIR` (LyX `lib/layouts`), `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` +
`OVERLYX_PUBLIC_URL` to enable Google sign-in, `OVERLYX_OWNER_EMAIL` (the instance owner: made an
administrator at sign-in; a project directory put at the top level of the projects directory moves
into its namespace),
`OVERLYX_SMTP_URL` (an SMTP URL with credentials, e.g.
`smtps://you%40gmail.com:app-password@smtp.gmail.com/` — the owner is e-mailed on every sign-up;
without it the notification is only logged, since outbound port 25 is blocked on typical hosts)
and `OVERLYX_MAIL_FROM` (optional From header override),
`OVERLYX_SIGNUP` (`open` — anyone with a Google account may sign in, the default — or `invited`),
`OVERLYX_GIT` (`off` to not expose projects as git repositories), `OVERLYX_GIT_COMMIT_MS` (idle time
before OverLyX commits what changed, default 2 min) and `OVERLYX_GIT_COMMIT_MAX_WAIT` (longest time
changes stay uncommitted while editing goes on, default 15 min), `GITHUB_REPO` / `GITHUB_TOKEN` /
`GITHUB_API_URL` (feedback and error reports as issues, see above), `OVERLYX_ERROR_REPORTS` (`off`
disables the automatic ones), `OVERLYX_USAGE_STATS` (`off` refuses the anonymous usage statistics), `OVERLYX_LITERATURE` (`off` disables the literature search of the
citation dialog) and `OVERLYX_CONTACT_EMAIL` (optional, for the OpenAlex / Crossref polite pools). Git itself runs with an empty
environment (`HOME=<data dir>/git-home`, `safe.directory=*` because projects may belong to another
account) — the server's own git configuration never applies.
The Vite dev server proxies to `OVERLYX_API_PORT` (default 3000).

Deleted projects are moved to `<data dir>/trash/<name>-<timestamp>`, never removed.

**Sandboxing.** LaTeX is a programming language and a project's `latexmkrc` is Perl, so a PDF build
is arbitrary code. `latexmk` and the image converters therefore run under
[bubblewrap](https://github.com/containers/bubblewrap) (`apt install bubblewrap`): the system is
read-only, only the build directory (and the `svg-inkscape` cache next to the document) is writable,
the project directory is mounted read-only, there is no network, a private `/tmp` and `HOME`
(`<data dir>/sandbox-home`, where TeX/fontconfig/inkscape caches and LyX's user directory persist),
and an empty environment. Without bubblewrap the server starts with a warning and runs the tools
unsandboxed (`packages/server/src/sandbox.ts`).

**Deploying.** Production runs from a separate clean checkout (`/root/lyx/overlyx-production`, the
systemd unit's `WorkingDirectory`), and the VS Code extension is released by
`.github/workflows/extension-release.yml` from `origin/master` (`packages/vscode/RELEASING.md`), so
both must come from the same commit: `scripts/deploy.sh` refuses a diverged `master`/`origin/master`,
pushes (which starts the extension release), fast-forwards the production checkout, runs `npm ci`
when the lockfile changed, builds the client, restarts the unit and checks that https://overlyx.app
serves the new bundle (`/api/version` reports the running commit). Run the checks below first — the
script deploys, it does not test. Pushes from any other machine deploy themselves:
`deploy/overlyx-autodeploy.timer` runs `scripts/autodeploy.sh` every two minutes on the server, which
fetches origin and, when origin/master is ahead of production, typechecks the client and the
extension and runs `npm test` in a throwaway worktree, then fast-forwards, builds, restarts and
verifies — reporting a `deploy/overlyx.app` commit status on GitHub (pending → success / failure;
`gh api repos/japhba/overlyx/commits/<sha>/status --jq '.statuses[] | "\(.state) \(.description)"'`, or
`curl -s https://overlyx.app/api/version` once it is live). A failed commit is not retried; the next push is.
Both scripts share one lock. Install the units with `cp deploy/overlyx-autodeploy.* /etc/systemd/system/
&& systemctl daemon-reload && systemctl enable --now overlyx-autodeploy.timer`; logs in
`journalctl -u overlyx-autodeploy`.
*Help ▸ OverLyX for VS Code* (`/api/vscode-extension`) redirects to the latest GitHub release's
`overlyx-vscode.vsix` (the build the extension's self-updater installs); a `.vsix` packaged into
`packages/vscode` of the running checkout is the fallback (`OVERLYX_VSIX_SOURCE=local` forces it).

A systemd unit is installed as `overlyx.service` (see `deploy/`). `deploy/overlyx-backup.timer` runs
`scripts/backup.sh` every night: an online backup of the SQLite database and a tarball of the
projects directory (without build products) into `<data dir>/backups/<timestamp>/`, keeping the
newest 14 (`OVERLYX_BACKUP_KEEP`). The server logs unhandled promise rejections instead of dying;
on an uncaught exception it saves the open documents and exits so that systemd restarts it.

## Secrets

Everything secret (the Google OAuth client secret, the GitHub tokens for feedback issues and for
the off-site mirror) stays out of the repository —
which is public — in `deploy/secrets.env` (git-ignored, mode 600), read by the systemd unit through
`EnvironmentFile=`; `deploy/secrets.env.example` lists the variables. The file exists on the server
and in the nightly backup, nowhere else — deliberately no secret store: both values can be re-created
in minutes (the OAuth client in the Google Cloud console under *APIs & Services ▸ Credentials*, a
fine-grained personal access token with *Issues: read & write* on the repository in GitHub's
*Developer settings*), and a second machine gets the file by `scp`. Without it the app runs with
password login only and the feedback dialog falls back to GitHub's issue form. The per-instance JWT
secret (`<data dir>/secret.key`) is generated on first start and is part of every backup too.

Do not put a broad-scope token (your `gh` login) in there: the server runs user-supplied LaTeX, and a
token with *Issues* on one repository is all the feedback channel needs. `GITHUB_PUBLISH_TOKEN`
(optional) lets administrators publish built PDFs into repositories (Share dialog ▸ *Public PDF
link* ▸ *commit the PDF to a GitHub repository*): a fine-grained token with *Contents: read & write*
on exactly the repositories that receive PDFs, nothing else.

`OPENROUTER_API_KEY` (from [openrouter.ai/keys](https://openrouter.ai/keys)) enables "Escalate to AI…"
document repair (see "Document health" below); `OPENROUTER_REPAIR_MODEL` overrides the model
(default `anthropic/claude-opus-5`). Without a key the feature is hidden. The same key powers the
editor's AI assistance (⌘J rewrite, autocomplete; `OVERLYX_AI_MODEL` /
`OVERLYX_AI_COMPLETION_MODEL`, defaults `google/gemini-3.7-flash` for rewrites and
`google/gemini-2.5-flash-lite` for autocomplete — the 3.7 model spends ~100 hidden reasoning tokens on
every reply (2.6 s) and, like 3.5 Flash Lite, answered sentence ends of a real paper with a word or
nothing; 2.5 Flash Lite writes sentences in 0.5–1 s, see `scratch/ai-bench.mjs`; `OVERLYX_AI_REWRITES_PER_MIN`,
`OVERLYX_AI_COMPLETIONS_PER_MIN` rate limits per user). `GET /api/ai/status` tells the client
whether it is configured; the features stay off in every browser until a user switches them on.

## Backups and restoring

**Off-site mirror (GitHub organisation).** With `GITHUB_MIRROR_ORG` and `GITHUB_MIRROR_TOKEN` in
`deploy/secrets.env` (a fine-grained token whose resource owner is the organisation, *All
repositories*, permissions *Contents* and *Administration: read & write*), every project's git
repository is pushed to a private repository `<org>/<project>` of that organisation
(`packages/server/src/mirror.ts`): the repository is created on the first push, a sweeper runs every
`OVERLYX_MIRROR_INTERVAL_MS` (5 min) and pushes each project whose HEAD moved (pending edits are
committed first — OverLyX commits about `OVERLYX_GIT_COMMIT_MS` = 30 s after the last change), the
server is the only writer (`--force --all`, nothing ever merges), the token reaches git through a
credential helper reading the environment (never `.git/config` or the command line), a deleted
project's repository is archived. The Git dialog shows the state per project (last push, behind,
last error; owners can pause or *Mirror now*). Restore on a fresh machine:

```bash
GITHUB_MIRROR_ORG=… GITHUB_MIRROR_TOKEN=… scripts/restore-from-mirror.sh /root/projects   # clones every project
```

The mirror holds the documents and their history — not the database (users, sharing, named versions,
tokens) nor `secrets.env`; those come from the nightly backup below. `OVERLYX_MIRROR_URL=file:///…/{repo}.git`
mirrors into bare repositories on disk instead (tests, or a second disk).

**Nightly backup.** `deploy/overlyx-backup.timer` runs `scripts/backup.sh` every night (SQLite online backup, `secret.key`,
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

The e2e suites copy real papers (`OVERLYX_E2E_FIXTURES`, default `/root/projects/jan`) into scratch
projects in the admin's namespace (`admin/e2e-…`); to keep them away from the production server and
its data, run them against an isolated instance:

```bash
S=/tmp/overlyx-e2e; mkdir -p $S/projects $S/data
mkdir -p $S/projects/admin && rsync -a --exclude _build --exclude .git /root/projects/jan/recurrent_feature /root/projects/jan/bayesian_chaos $S/projects/admin/   # features.spec compiles bayesian_chaos; landing.spec opens recurrent_feature
OVERLYX_DATA_DIR=$S/data npx tsx packages/server/src/seed.ts admin Admin bob Bob carol Carol u1 U1 u2 U2 u3 U3 u4 U4 u5 U5 u6 U6
OVERLYX_DATA_DIR=$S/data OVERLYX_PROJECTS_DIR=$S/projects OVERLYX_CLIENT_DIST=$S/dist PORT=3001 npx tsx packages/server/src/index.ts &
(cd packages/client && OVERLYX_API_PORT=3001 npx vite --port 5174 &)
export OVERLYX_PROJECTS_DIR=$S/projects OVERLYX_E2E_CREDENTIALS=$S/data/credentials.txt
OVERLYX_E2E_BASE=http://localhost:5174 npx playwright test e2e/smoke.spec.ts e2e/editing.spec.ts e2e/features.spec.ts e2e/dialogs.spec.ts e2e/fonts.spec.ts
OVERLYX_E2E_BASE=http://localhost:5174 npx playwright test e2e/sharing.spec.ts e2e/textfiles.spec.ts e2e/toolbar.spec.ts e2e/collab.spec.ts   # bob, carol, u1…u6
OVERLYX_E2E_BASE=http://localhost:5174 npx playwright test e2e/tour.spec.ts e2e/feedback.spec.ts e2e/misc.spec.ts e2e/clipboard.spec.ts e2e/tablerows.spec.ts e2e/cite.spec.ts
OVERLYX_E2E_BASE=http://localhost:5174 npx playwright test e2e/layoutkeys.spec.ts e2e/ink.spec.ts e2e/board.spec.ts   # Ctrl+digit headings, "- " lists, tracked formulas; margin ink + whiteboards
OVERLYX_E2E_BASE=http://localhost:5174 npx playwright test e2e/dollar.spec.ts   # $…$ / $$ typing, delimiter size buttons, figure reload + smart invert, comment cards
OVERLYX_E2E_BASE=http://localhost:5174 npx playwright test e2e/selection-inserts.spec.ts   # comments / floats / captions keep the selection, pasted blocks, Enter in a caption, Insert ▸ Graphics on a layout page, live authors, TeX pane after settings, tracked tables, formula notice, tablet reflow
OVERLYX_E2E_BASE=http://localhost:5174 npx playwright test e2e/slidesorter.spec.ts   # the slide sorter: selection, dragging several, duplicate / delete / undo, keys, transitions, size, the saved order
OVERLYX_E2E_BASE=http://localhost:5174 npx playwright test e2e/sliderail.spec.ts   # the slide rail: thumbnails, new slides in the deck's style, drag to reorder, its menu, undo, the saved file
OVERLYX_E2E_BASE=http://localhost:5174 npx playwright test e2e/layout.spec.ts   # layout documents: new deck, text box + formula, move / resize / undo, toolbar, presentation steps, zoom, text overlays, a linear beamer deck presented; the font size box
npx vitest run tests/parity.test.ts   # the web client and the VS Code extension share one editor assembly and one toolbar definition
npx vitest run tests/docworker.test.ts   # the document workers write the bytes the main thread writes; saves in order; a dead worker loses nothing
OVERLYX_DATA_DIR=/root/lyx/overlyx/data npx tsx scripts/usage-report.ts --days 30   # on the production server: what people did and what went wrong (anonymous usage statistics)
journalctl -u overlyx-autodeploy -n 50   # on the production server: what the last push to origin/master went through (checks, deploy, verification)
# a real project in the extension (VS Code under xvfb, driven over CDP): notifications, broken node views, formula
# errors, raw LaTeX left in the text, formula image glyphs and their placement, screenshots — for "this document
# does not work in the extension" reports; copy the project somewhere first, never point it at /root/projects
(cd packages/vscode && xvfb-run -a -s "-screen 0 1600x1000x24" node test/probeProject.mjs /tmp/copy-of-project main.tex /tmp/probe-out)
# editing in the real extension: mouse drags across a formula at zoom 1 and 1.3 (the selection head must
# follow the pointer) and bursts of deletions under auto save with ~1 s pauses (the document must never
# grow back — report.json edits.regrew); the workspace copy is edited
(cd packages/vscode && xvfb-run -a -s "-screen 0 1600x1000x24" node test/probeEditing.mjs /tmp/copy-of-project main.tex /tmp/probe-editing)
# offline mode needs the built client (service worker): build into $S/dist, then
(cd packages/client && npx vite build --outDir $S/dist)
OVERLYX_E2E_BASE=http://127.0.0.1:3001 npx playwright test e2e/offline.spec.ts e2e/git.spec.ts   # git: a real clone / push / pull with a token
# AI assistance (e2e/ai.spec.ts): the menus / preferences part runs anywhere; the ⌘J and autocomplete
# flows need the server to talk to the stub model: `node scripts/ai-stub.mjs` (port 3999) and the server
# started with OPENROUTER_API_URL=http://127.0.0.1:3999 OPENROUTER_API_KEY=test-key, then
OVERLYX_E2E_AI_STUB=1 OVERLYX_E2E_BASE=http://localhost:5174 npx playwright test e2e/ai.spec.ts
# the Agent panel (e2e/agent.spec.ts): start the server with OVERLYX_CODEX_BIN=scripts/codex-stub.mjs
# (a stand-in for `codex app-server`: sign-in, streamed replies, one approval round-trip), then
OVERLYX_E2E_AGENT_STUB=1 OVERLYX_E2E_BASE=http://localhost:5174 npx playwright test e2e/agent.spec.ts
# the Google Docs sync: a server started with OVERLYX_E2E_GOOGLE_STUB=1 (simulated Google APIs, gdocs/fake.ts)
OVERLYX_E2E_BASE=http://localhost:5174 npx playwright test e2e/gdocs.spec.ts e2e/markdown.spec.ts
# agents connected over MCP (e2e/mcp-presence.spec.ts): get_presence on a selection made in the browser, the
# agent's caret / highlight, a panel message through wait_for_instructions and back, a pushed Claude Code session;
# MCP is not proxied by vite, so name the server
OVERLYX_E2E_SERVER=http://127.0.0.1:3001 OVERLYX_E2E_BASE=http://localhost:5174 npx playwright test e2e/mcp-presence.spec.ts
# Claude Code on the user's computer, started from the Agent panel (e2e/agent-runner.spec.ts): runs the real CLI
# (`overlyx agent run`) with a fake `claude` that prints stream-json; rotates the admin token like the specs above
OVERLYX_E2E_SERVER=http://127.0.0.1:3001 OVERLYX_E2E_BASE=http://localhost:5174 npx playwright test e2e/agent-runner.spec.ts
# "a user writes a paper": real arXiv papers typed from blank documents through the editor UI —
# paperwriting.spec.ts / paperwriting-more.spec.ts (first pages of Attention, a coding-theory paper, BERT) and
# the whole GAN and Adam papers from abstract to bibliography with a latexmk build (~15 min each; needs pdftotext):
OVERLYX_E2E_BASE=http://localhost:5174 npx playwright test e2e/paperwriting-gan.spec.ts e2e/paperwriting-adam.spec.ts
# the papers' real appendices are typed by follow-up sessions in the same specs (Adam's convergence
# proof, BERT's appendices A-C, Attention's visualizations; GAN and the combination-networks paper
# have no appendix in the originals). paperwriting-vae.spec.ts types "Auto-Encoding Variational
# Bayes" in two sessions plus its six appendices (unnumbered align rows, \eqref, a formula in a
# section title and in a footnote, \paragraph headings, \left. … \right|, lettered subsections):
OVERLYX_E2E_BASE=http://localhost:5174 npx playwright test e2e/paperwriting-vae.spec.ts
# OVERLYX_E2E_KEEP=1 leaves the typed projects on disk (admin/e2e-paperwriting, admin/e2e-paperwriting-more,
# admin/e2e-paper-gan, admin/e2e-paper-adam, admin/e2e-paper-vae); publish them into the owner's production account
# (OVERLYX_OWNER_EMAIL, japhba@gmail.com) so the latest typed-via-GUI papers can be inspected there:
scripts/publish-typed-papers.sh $S/projects
# mouse selection (LyX rules: insets taken whole at their closest edge, no drag-and-drop of a
# selection, word/paragraph drags, autoscroll) in the text and in formulas (LyX's coordinate model:
# click precision, corner markers around the fraction, double/triple click, drag out and back in):
OVERLYX_E2E_BASE=http://localhost:5174 npx playwright test e2e/textselect.spec.ts e2e/mathselect.spec.ts
OVERLYX_E2E_BASE=http://localhost:5174 npx playwright test e2e/pdfview.spec.ts e2e/rawsplit.spec.ts   # pdf.js viewer, SyncTeX, PDF tabs; the [raw] split tab, scroll sync, live apply
OVERLYX_E2E_BASE=http://localhost:5174 npx playwright test e2e/panes.spec.ts   # WYSIWYG · TeX · PDF panes, PDF age / auto-build / flicker-free rebuild, section folding, dash keys
```

**Safari and Firefox.** Real users come with Safari (Mac, iPhone, iPad), Firefox and Edge besides
Chrome, so the suite also runs in Playwright's WebKit (Safari's engine, as the "Desktop Safari" device)
and Firefox; Chromium stays the default:

```bash
OVERLYX_E2E_BROWSERS=webkit OVERLYX_E2E_BASE=http://localhost:5174 npx playwright test e2e/editing.spec.ts    # Safari's engine
OVERLYX_E2E_BROWSERS=firefox OVERLYX_E2E_BASE=http://localhost:5174 npx playwright test e2e/editing.spec.ts   # Firefox
OVERLYX_E2E_BROWSERS=all …   # Chromium, Firefox and WebKit, a project each (a failure names its browser)
```

What differs, and how the specs deal with it:

- **The Mod key.** Playwright's WebKit and Firefox on Linux report `navigator.platform` as
  "Linux x86_64" whatever the device's user agent says (Desktop Safari's is a Mac's), so the app takes
  Control as its Mod key in all three browsers here and a spec's `Control+…` means the same in each.
  (On a Mac host every browser reports "MacIntel": the app's Mod key is then ⌘, and such presses would
  have to become `ControlOrMeta+…`.)
- **The clipboard.** `grantClipboard(context)` (e2e/helpers.ts) grants what each engine knows — both
  permissions in Chromium, clipboard-read in WebKit (it writes without one), none in Firefox (granting
  an unknown permission throws); `readClipboard(page)` reads the text — WebKit refuses
  `navigator.clipboard.readText()` without a gesture (Safari shows a Paste button), so there it is
  pasted into a scratch page of the same context. Playwright's WebKit keeps only text/plain on its
  pasteboard (a copy's HTML, which carries table cells and insets, is gone at the paste), runs no copy
  for Ctrl+C on a selection outside editable text, and its `clipboard.read()` (the menus' Paste) waits
  for Safari's Paste button: clipboard.spec accepts typographic quotes there, agent.spec fires the copy
  event itself, tablerows.spec skips its HTML pastes.
- **Touch.** `newTouchContext(browser, …)` makes a tablet: under `hasTouch` WebKit and Firefox leave
  `navigator.maxTouchPoints` at 0 (a real iPad says 5), which the app's tablet test needs.
- **PDF fixtures.** `page.pdf()` exists only in Chromium: darkpdf.spec prints its figure there whatever
  the browser under test.
- **Computed styles** read differently: WebKit leaves out the quotes around a font family that needs
  none (`CMU Serif, serif`), so fonts.spec compares families without quotes.
- **Pointer positions** are whole pixels in WebKit and Firefox, fractions in Chromium: sizes drawn
  with the mouse come out a hair different (layout.spec allows 69.98 mm for 70).
- **Synthetic events.** Firefox's ClipboardEvent constructor ignores `clipboardData`: specs that paste
  by dispatching one set the property on the event; Chromium has no `insertFromComposition` input
  type (misc.spec's Safari composition order runs in WebKit and Firefox only).
- **Devices.** devices.spec opens the app as a phone and as a tablet; scratch/browsers/ipad.mts
  (`landscape`, `portrait`, `phone`; `ENGINE=chromium`) taps through a document and takes screenshots.
- **Settling.** A click Playwright lands on a formula not yet hovered reaches the formula's field
  directly in Chromium but its row in WebKit, which focuses the field a frame later: specs that type
  right after such a click wait for `nextFrames(page)`.
- **Offline.** Playwright's WebKit fails every navigation while its network is emulated offline
  ("WebKit encountered an internal error") before the service worker is asked, and it keeps opening
  WebSockets (the editor's reconnects sync the "offline" edits at once): offline.spec reloads offline
  only in Chromium and Firefox and skips its long offline sessions in WebKit
  (scratch/browsers/swoffline.mts, wsoffline.mts).
- **Memory.** A WebKit page holding the dev build and a long paper takes ~0.8 GB, three times
  Chromium's: collab.spec's six users need more than 3 GB in WebKit and more than 2.5 GB in Firefox,
  so run it with `OVERLYX_E2E_COLLAB_USERS=3` there on a small machine, and give a Playwright run in
  WebKit 2.3 GB (specs with a second user open several pages).

## Offline mode

How it works, in order of what happens when you open a document:

1. **Local copy first.** The editor loads the document's Yjs state from IndexedDB
   (`overlyx:<project>/<file>`, written by `y-indexeddb`) and renders it right away, then connects
   to the server. The initial sync only exchanges what the two sides are missing, so re-opening a
   document is fast even on a slow connection.
2. **Editing.** Every keystroke is a Yjs update: applied locally, appended to IndexedDB and — while
   connected — sent to the server immediately. The server writes the `.tex` file 1.5 s after the
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
   (two people editing the same sentence simply both get their words in, one word after the other).
   That needs every typed character anchored to the one typed before it: y-prosemirror's
   prefix-first diff hung the rest of a word typed in front of an equal letter ("q…" before
   "queries") off the old text, and two people typing at the same place, one of them offline, got
   their words spliced into each other mid-word — `editor/plugins/typinganchor.ts` places such an
   insertion at the cursor first (`tests/typing-anchor.test.ts`, the token-accounting test in
   `e2e/offline.spec.ts`). Yjs cannot move text, so Enter in the middle of a paragraph keeps one half
   in the paragraph's Yjs element and *copies* the other into a new one: typinganchor.ts keeps the
   larger half (the first on a tie) with the split text run trimmed, never deleted, and copies the
   smaller one (y-prosemirror aligned the runs from the left and, with formulas in the paragraph,
   rewrote the first run and deleted the split one — what somebody offline had typed there was lost,
   and two people typing at a paragraph's start and pressing Enter duplicated it).

   A copy is still a copy: whatever a co-author who had not seen the split yet typed, deleted,
   formatted or changed in a formula of the copied half went to the deleted original. So copies are
   recorded and the server moves such late edits after them (`core/src/moves.ts`,
   `server/src/moves.ts`):
   - **The editor records what it copied.** In the same Yjs transaction as a split, a join (Backspace
     at a paragraph's start) or any edit that moves text between paragraphs, `recordCopies` (called
     from typinganchor.ts) aligns the text before and after and writes the pairs *original unit →
     copy* (characters, formulas, insets) into the shared map `moves`, keyed by the client and its
     clock. A text run that loses or receives copied characters is re-created whole, so that no run
     ever mixes moved and unmoved text; the deleted originals are listed to be kept.
   - **The server keeps the originals and repairs late edits.** `MoveRepair` (one per open document,
     `docs.ts`) sees every update a client sends (`ws.ts`) and every diff of the server's own: a
     record is restated as the server's (`s…` keys; the client's key goes), and the originals it
     names are excluded from Yjs' garbage collection (`protectMoves`, also in the document workers'
     mirrors, whose state is what gets persisted). An insertion into a moved original — anchored, as
     Yjs anchors everything, to the characters it was typed between — is moved beside the copies of
     those characters, a deletion of moved characters deletes their copies, formatting and a formula's
     new value go to the copy. The repair is an update of its own, made after the client's update has
     been applied and broadcast, so every client gets the same result; it is idempotent (a reconnect
     resending the same updates changes nothing) and costs nothing for updates that touch no moved
     text (a lookup per new item). Two people splitting or joining the same paragraph before they
     sync both copy some text: one copy wins (fixed rules: a copy that moved over one that stayed,
     then the one in the smaller paragraph), the other is deleted, and what was typed into either
     ends up once in the winner. A paragraph a late editor added among
     moved ones is put back between the paragraphs it was typed between.
   - **Reconnecting.** A client that comes back with edits the server has not seen gets the server's
     sync step 2 only after its own step 2 has been applied and repaired (at most 3 s later), so it
     never starts editing on the unrepaired state.
   - Records older than `OVERLYX_MOVE_RECORD_DAYS` (default 30) are dropped when the document is
     opened; their originals are collected the next time it is loaded. An editor that was offline
     longer than that gets its late edits in the deleted original, as before.
   - Not covered: undoing a split after a late edit was moved (the undo restores the original, the
     moved edit stays in the copy); an editor of an older version, which records nothing (its splits
     copy as before); and some interleavings of several splits and joins of the same paragraphs,
     which can leave words in the wrong order or bring a deleted word back (in the randomized test
     below no word is ever lost or doubled by splits; with joins, 2–7 of 100 long scripts lose one).
   - Tests: `tests/split-repair.test.ts` (each case, both orders, both sides offline, a server restart
     in between, the server's own diffs), `tests/split-fuzz.test.ts` (random scripts of typing,
     deleting, Enter and Backspace on two or three editors going offline and online; every word typed
     must be there once, in the order its author saw; `OVERLYX_FUZZ_SEEDS`, `OVERLYX_FUZZ_STEPS`,
     `OVERLYX_FUZZ_JOINS=1`, `OVERLYX_FUZZ_STRICT=1` to fail the known limits too,
     `OVERLYX_FUZZ_DEBUG=<seed>` to replay and shrink one),
     `tests/yjs-net.ts` (the network they run on: real y-prosemirror editors and a server with
     controlled deliveries), `tests/agent-edit-moves.test.ts` (Agent-panel and MCP edits through
     docs.ts with an editor connected, which sends an agent's edit back — the deletions in it are the
     edit's own moves, not late deletions) and `e2e/offline-splits.spec.ts` (both press Enter in one paragraph, one
     of them offline, and type behind formulas in both halves).

   External changes of the file are applied on the server as a *diff* (`packages/server/src/ydiff.ts`),
   so paragraphs they did not touch keep their identity and offline edits inside them survive; a diff
   that splits or joins paragraphs records its copies like an editor, and goes through the repair as
   the server's own (what it saw counts as known: `applyMirrorUpdate`).
   A formula is one value, not text: when two people change the same formula from the same version,
   the one who loses keeps their version in a comment beside it (*"Concurrent formula edit by … —
   retained for review"*, `client/src/editor/mathconflict.ts`; each formula carries an edit clock,
   `editClock`). A version that is only spelled differently is not a competing one — a restarted
   server reopens the document from its .tex and brings back the file's spelling of an edited formula
   (an inline matrix on one line, rows on lines of their own in the editor) with an empty clock, which
   once left a copy of an edited matrix beside itself after every deploy (`sameFormula`, compared as
   written).
5. **Unmergeable case.** If the server's copy of the document has a *different history* (its Yjs
   state was reset with *POST /api/docs/…/reset*, or its database was wiped) the local copy cannot
   be merged: the editor stores the unsynced edits as a version named *"offline changes by …"*
   (Versions panel: compare / restore), discards the local copy and reloads the server's document.
   Logging out deletes the local copies and cached API responses on that browser.

## Compatibility notes

* **Browsers**: Chrome and Edge, Safari (Mac, iPhone, iPad) and Firefox; the e2e suite runs in all
  three engines (*Tests*). What Safari and Firefox needed:
  - pdf.js's *legacy* build (`app/PdfViewer.tsx`, the VS Code PDF panel too): the default build needs
    `Map.getOrInsertComputed`, `Math.sumPrecise` and the `Iterator` global (Safari 26.2, Firefox 144,
    Chrome 147) — before Safari 18.4 the app did not even start, later it showed no PDF. In Safari's
    engine pdf.js also decodes images without an OffscreenCanvas (it drew one image in another's place).
  - Safari has no `requestIdleCallback`: formulas rendered "in idle time" use a timer whose deadline
    runs out (a constant one rendered a long paper's formulas in one task and froze the page).
  - an Overleaf zip chosen before signing in is parked in IndexedDB as bytes — Safari stores no Blob
    there in a private window; files dropped into the file tree fall back to the dropped `File` where
    WebKit's directory entry cannot be read.
  - Firefox: after a caret key the caret is put beside an uneditable widget at a line's start
    (`caretOutOfWidget`, assembly.ts) — Home on a heading left it in the fold toggle, where
    ProseMirror ignores it, and Shift+End, Delete joined the heading with the next paragraph; the
    menus' Paste sets clipboardData on the paste event itself (`pasteEventWith`, clipmenu.ts:
    Firefox's ClipboardEvent constructor drops it, and LaTeX text went in unparsed).
  - phones (Safari on an iPhone, Chrome on Android): the documents panel starts in its rail and the
    drawing toolbar stays off (`isTabletClient` excludes screens narrow in either orientation) — the
    panel and the toolbar left a 393 px iPhone a text column one letter wide.
  - the editor taking the focus back keeps the page where it is (`keepScrollOnFocus`, assembly.ts):
    WebKit reveals the editor's previous DOM selection on focus whatever `preventScroll` says, so a
    click on a child document's link (which takes the focus) scrolled to the old caret.
  - child documents open on the browser's own `dblclick` (ProseMirror's 500 ms double-click window
    was missed on a busy WebKit page); a drag's autoscroll runs per time, not per frame (120 Hz
    screens scrolled twice as fast); the hidden input of a formula has 16px text (an iPhone zooms
    into smaller focused text); a whiteboard that connects before its first render says it is live.
* Byte-exact round trips are guaranteed for LyX ≥ 2.4 files; older files are re-wrapped exactly
  like LyX does on save.
* The document header (class, preamble, options) is edited through *Document ▸ Settings*; raw
  header editing is available for anything else.
* Change tracking: insertions/deletions are marked per author (matched by the LyX author name);
  the status bar shows who you are tracking as and the change under the cursor; *Edit ▸ Track
  Changes* / the context menu accept or reject single changes or all of them. What the editor draws
  from the document's metadata follows it live (`editorContext.meta` tells `onMetaChange` listeners
  when it is replaced): an author who starts tracking is named and coloured at once, and a citation an
  agent or a collaborator inserted shows author and year as soon as the refreshed metadata (project
  events) knows the key — no reload. A table inserted or deleted as a whole has its rules and cell
  boundaries in the author's colour, an outline and a tinted ground (a deleted one is crossed out), so it
  never reads as an accepted table.
* **Mode switch: Editing · Suggesting · Viewing** (`app/EditModeSwitch.tsx`, both shells — the web
  client at the right end of the first toolbar row, as in Google Docs; the VS Code webview in its
  top bar): Suggesting is change tracking — a setting of the document (`\tracking_changes`), so it
  is on for everyone editing it, and Editing turns it off; Viewing makes only this browser's
  editors read-only (the same path as a view-only share, which shows Viewing with the other two
  disabled). Under *Show changes*: all changes, only additions, only deletions, unchanged text
  only — the review toolbar's insertion / deletion filter, applied to every editor of the combined
  view. The change mark is not inclusive (`core/src/schema.ts`): text typed at the end of a
  suggestion is plain while tracking is off, and the typist's own insertion while it is on (typing
  on at the end of one's own insertion extends it: one `\lyxadded` group); `tests/changes-typing.test.ts`.
  Edits inside a formula that was there before are applied directly, not as a suggestion — LyX does not
  track inside math either (a formula is one value); the first such edit of a session says so in the
  status bar (to suggest a different formula, insert the new one beside it and delete the old one). A
  formula inserted as a suggestion stays one, edits included.
* Macro rendering follows LyX's positional semantics (a `FormulaMacro` applies from its position on;
  later definitions — including ones nested in notes — override earlier ones). Macros with
  arguments are expanded from their definitions with the argument cells kept editable (`core/src/math/mathjax.ts`).
  calls when the formula is written to the file (`packages/core/src/mathedit.ts`).
* Large documents: the editor opens the local copy and starts syncing while the document's
  metadata loads; formulas near the top are rendered synchronously (a ~40 ms budget), the rest
  show their source and are rendered in idle time or when scrolled near, and become editable
  fields when they scroll into view or are hovered/entered. (Safari has no `requestIdleCallback`:
  a timer with an 8 ms deadline stands in — `idleCallback` in nodeviews/math.ts; its deadline
  once never ran out, and Safari rendered every formula of a long paper in one frozen task.) Macro tables are shared and cached
  per document, so a 300-formula paper paints in well under a second.
* Every document's Yjs history carries an *epoch*; a browser tab whose editor belongs to an older
  epoch (server restarted with a changed file) reloads instead of merging stale content. Cross-tab
  BroadcastChannel syncing of y-websocket is disabled for the same reason.

## Markdown documents

A `.md` (`.markdown`) file opens in the same editor as a `.tex` document — collaborative, with
comments, change tracking, versions, the outline, agents and a PDF — restricted to what markdown
can hold (`core/src/md/`, `client/src/editor/markdown.ts`):

* **The model.** `md/parse.ts` (markdown-it: CommonMark, GFM tables / strikethrough / autolinks,
  plus `$…$` / `$$…$$` math and `[^label]` footnotes) maps markdown onto the LyX model: `#`…`#####`
  are Section…Subparagraph (unnumbered: `\secnumdepth -1`), lists Itemize / Enumerate with depth
  (an item's further paragraphs one level deeper), `>` Quote, fenced code a listings inset (its
  language in `lstparams`), formulas Formula insets, tables a tabular (booktabs rules), images a
  Graphics inset (alt text as `special alt={…}`, a linked badge's link as a `link` parameter),
  footnotes Foot insets (with their label). Inline HTML for underline, `<sub>` / `<sup>`, `<br>`
  is understood; any other HTML is kept verbatim in a raw (ERT) inset. YAML front matter is kept
  verbatim (the document's preamble lines).
* **Comments and changes in the file.** A comment thread is an HTML comment right after the
  commented text, invisible in every markdown viewer:
  `text<!-- @comment⏎    Jan Bauer (2026-10-04 12:00):⏎    the comment⏎    -->` (lines indented by
  four spaces so they can never start a markdown block; in a heading or table cell it is one line,
  `\n` between its lines). A plain `<!-- … -->` is a note. Tracked changes are
  `<ins author="Jan Bauer" datetime="2026-10-04T12:00:00Z">…</ins>` / `<del …>` (GitHub shows them
  underlined / struck out); a document's authors are rebuilt from them.
* **Writing** (`md/write.ts`). Edited blocks are written canonically (`*em*`, `**bold**`, `-`
  bullets, fenced code, padded tables; text escaped so it reads back as text; emphasis the
  delimiter rules cannot express — `a**"b"**c` — as `<strong>`); `writeMarkdownPreserving` keeps
  every unchanged block's bytes (its `*` bullets, setext headings, wrapping, reference links)
  and the space between blocks, so a save changes the edited blocks only and writing a file that
  was just parsed gives it back exactly (verified on 400 real READMEs). LaTeX-only constructs that
  reach a markdown document degrade with warnings (a citation to `\[@key]`, small caps to plain).
* **The editor** offers markdown's toolbar (bold, italic, strikethrough, code, H1–H3, quote, code
  block, rule) and menus, and markdown's typing: `**bold**`, `*em*` / `_em_`, `` `code` ``,
  `~~strike~~` format as you type; `> ` starts a quote (Enter on an empty quote line ends it),
  "```lang" + Enter a code block, `---` + Enter a rule, `$$` + Enter a display formula, `- [ ]` a
  task with a box to tick; markdown pasted as text arrives as structure. Layouts and font
  attributes markdown lacks (pasted from LaTeX, a LaTeX shortcut) become the nearest markdown
  (Chapter → `#`, Description → bullets) or go; labels, citations and margin notes say they are
  not available. The source pane is labelled *Markdown*.
* **PDF**: the model is written as LaTeX (`markdownForLatex`: images on the web become links, raw
  HTML is left out, code languages listings does not know are dropped) and built with LuaLaTeX.
* **VS Code**: the extension opens `.md` with *Open With… ▸ OverLyX Editor* (VS Code's own
  markdown editor stays the default), with the same parser and writer.

## Google Docs sync

*File ▸ Google Docs (sync, comments)…* links a document — markdown or `.tex` — to a Google Doc
and keeps the two in step both ways (`server/src/gdocs/`): you write in OverLyX, collaborators
read, comment and edit in Google Docs.

* **Connecting.** Each account connects its Google Drive once (OAuth, scope `drive.file`: OverLyX
  only ever sees the Google Docs it created). The sign-in's OAuth client and redirect address
  (`/api/auth/google/callback`) are reused — `auth.ts` hands a Drive connection's callback to
  `gdocs/google.ts`; the refresh token is stored encrypted (AES-GCM, key derived from the server
  secret) in `google_drive`. **Setup:** in the Google Cloud project of `GOOGLE_CLIENT_ID`, enable the
  *Google Docs API* and the *Google Drive API* (APIs & Services ▸ Library); `drive.file` is a
  non-sensitive scope, so no app verification is needed. Without the APIs enabled the dialog says so.
* **The model** (`gdocs/model.ts`). A document projects to blocks Google Docs can hold: headings
  (the document's top heading level is Heading 1), paragraphs, bulleted / numbered lists with
  nesting, quotes (indented), code blocks (monospace lines on a grey ground), tables, text with
  bold / italic / underline / strikethrough / monospace / links / super- and subscript, real
  footnotes. What Docs cannot hold is text that reads back: `$…$` formulas (`$$…$$` centred),
  `[@key]` citations, `[ref: label]`, `[image: file]`. Tracked changes are shown as accepted (the
  API cannot write suggestions); notes are left out; comment threads become Google comments.
* **Writing** (`gdocs/edits.ts`): the Google Doc is diffed against the blocks and edited in place
  with `documents.batchUpdate`, back to front — a changed paragraph word by word (narrowed to the
  characters that changed), formatting as style updates, new and removed blocks as insertions and
  deletions — so comments anchored in Google Docs keep their text. It goes in rounds that re-read
  the document: a new table is inserted empty and filled in the next round, a new footnote likewise,
  lists get their bullets last (createParagraphBullets reads nesting levels from leading tabs).
  Paragraphs with suggestions pending in Google Docs are not touched. A seeded fuzz test
  (tests/gdocs.test.ts) checks that random edits always converge.
* **Reading back** (`gdocs/sync.ts`). Each sync compares the Google Doc with the blocks it held after
  the previous sync; what changed there is mapped onto the document as it was then and applied
  through the agents' edit path (`docedit.ts` applyTrackedSource): tracked insertions / deletions
  by “Name (Google Docs)” (Drive's last modifier), merged with edits made here meanwhile. Accepting
  them changes nothing in Google Docs; rejecting them takes the Google Doc back.
* **Comments** both ways: a Google comment becomes a thread right after the text it quotes, its
  replies messages; a thread written here becomes a Google comment (anchored to the text before it
  with the Docs API's `insertComment` where the project has it — it is in preview — else a Drive
  comment quoting that text, which Docs lists unanchored), its messages replies; resolving and
  reopening go both ways. `gdocs_links.comments` maps threads to comments, so nothing is sent twice.
* **When**: every minute (`startAutoSync`) a linked document is synced if it was saved since its
  last sync or Drive reports a new version of the Google Doc; *Sync now* in the dialog any time;
  *Sync automatically* off leaves it to the button. The sync uses the Drive of whoever linked the
  document. Unlinking keeps the Google Doc; a link whose document is gone is dropped.
* **Tests**: `tests/gdocs.test.ts` runs against `gdocs/fake.ts`, a simulation of the Docs / Drive
  APIs (indices, paragraph joins, bullets from tabs, tables, footnotes, anchored comments).
  `e2e/gdocs.spec.ts` needs a server started with `OVERLYX_E2E_GOOGLE_STUB=1`: the simulation
  instead of Google, a Drive connection without the consent screen, and `/api/gdocs/e2e/*` for the
  test to play the collaborator.

## The .tex format

A document is a normal LaTeX file. OverLyX only relies on a few conventions, all of them
invisible to LaTeX itself:

* **A managed block** right before `\begin{document}` (between `%% OverLyX ---` and
  `%% end OverLyX ---`) holds the packages and macro definitions the *content* needs
  (`ulem`/`xcolor` and the change-tracking macros, `graphicx`, `booktabs`, `textcomp`, the
  `\lyxgreyedout` environment, …) — everything the user's own preamble (and the project's own
  `.sty` files it loads) does not already load — and one `%% overlyx-settings: {...}` line with
  what LaTeX cannot express (LyX layout modules, citation engine, whether tracked changes are
  shown in the PDF, …). It is rewritten when what it should hold changes (a file brought from
  elsewhere gets one only when its content needs something); put your own preamble above it.
  natbib is loaded through `\@ifpackageloaded`: a journal class or conference style may load it
  itself, and loading it again with options is an option clash.
* **Change tracking**: inserted / deleted text is wrapped in LyX's `\lyxadded{Author}{Tue Aug 26
  14:03:00 2026}{…}` and `\lyxdeleted{…}{…}{…}` macros (a deleted paragraph break is
  `\lyxadded{…}{…}{¶}`). With *show changes in output* on, the managed block defines them to
  print coloured / struck-out text (as LyX does); off, they print the final text.
* **Notes and comments** are comment blocks: `%% @note`, `%% @comment` or `%% @greyedout` on a
  line of its own, the note's LaTeX on `%% ` lines, and `%% @end` on a line of its own (a blank
  `%%` line is a paragraph break, nested notes carry another `%% `; a block without the closer —
  older files — ends at the first line that is not `%% …`). A folded note is `%% @note collapsed` (LyX's *status collapsed*);
  without the word it is shown open. A comment thread's messages are paragraphs headed
  `Name (2026-08-26 14:03):`, the first one marked `[resolved]` when resolved. A note inside a
  paragraph is preceded by `%` at the end of the line, so the surrounding text joins as in TeX.
* **No hard line breaks** in what OverLyX writes: a paragraph it writes is one line of the file
  (paragraphs it only read keep theirs until they are edited; LyX re-wrapped at 65 columns; a
  line break in the file would only move around in diffs). The text editors wrap to their width.
* **Child documents** (`\input{appendix.tex}` from the body) are fragments without a preamble;
  their first line is their settings line. They are edited on their own and built through their
  master. `\input`s in the preamble (`macros.tex`, `preamble.tex`) are plain text files.
* **Everything else is LaTeX**: sections, lists, theorems (from the class's LyX layout), floats,
  captions, graphics, tables (`tabular`/`longtable`, `\multicolumn`/`\multirow`, booktabs),
  citations, references, footnotes, macros (`\newcommand` / `\global\long\def` in the body keep
  their position, as in LyX; a macro's on-screen *display* form, LyX's second definition line, is
  the trailer `%% @display {…}` on the definition line), fonts, quotes, accents. What is not understood is kept verbatim as
  raw LaTeX (shown like LyX's ERT) with its arguments still editable as text; LyX-specific
  spellings (`\SpecialChar`, protected spaces, …) are written as their LaTeX equivalents. Inside
  such raw LaTeX (an environment OverLyX does not know, like `titlepage`; an unknown command's
  argument) an alignment declaration (`\centering`), an alignment environment and a heading stay
  raw too, and what is declared inside ends with it; the writer keeps raw `\begin`/`\end` and
  braces out of its font groups and puts one alignment environment around paragraphs that raw
  LaTeX links, so it never splits an environment.

`scripts/import-lyx.ts` converts a project's `.lyx` files (children as fragments, SVG/EPS
graphics as PDF); the LyX settings become a real preamble, exactly as LyX's own export writes it.

### Document health

Because the file is plain LaTeX, anything can edit it outside OverLyX — git, another editor, a
merge — and can break one of the conventions above (a managed-block marker, the settings JSON, a
`\begin{document}`/`\end{document}` pair, brace balance). `packages/core/src/tex/health.ts`
(`checkTexHealth`) checks for this on every load and external change; a banner appears above the
editor listing what it found. Two ways to fix it:

* **Repair** (`Document ▸ Document health ▸ Repair`, or the banner's button) mends only the
  mechanical cases — a managed-block marker missing next to its counterpart — by text surgery, and
  never touches document content. It's a no-op when nothing mechanical is wrong.
* **Escalate to AI…** sends the broken file and the detected issues to an OpenRouter model (see
  "Secrets" above) along with the format spec, and shows the proposed fix in a merge/diff editor
  (`app/diff.ts` + `Dialogs.tsx`'s `AiRepairDialog`) for you to review line by line before applying
  — nothing is written until you click *Apply*. A version of the file from just before either kind
  of repair is kept (Versions panel), and applying an AI proposal is refused if the file changed
  since the proposal was generated.

## MCP connector

Any [MCP](https://modelcontextprotocol.io)-compatible client (ChatGPT, Claude, Claude Code, …) can
connect as a collaborator — to **all of an account's projects at `<origin>/mcp`** (each tool takes a
`project` argument; `list_projects` names the reachable ones and the account's role is checked on
every call), or fixed to one project at `<origin>/mcp/<owner>/<project>` (the classic form in File ▸ Git
repository…, `Git.tsx`). Projects are named by their key `<owner>/<name>` (document ids
`<owner>/<name>/<path>`); a name a project had before (see *Project addresses*) is still accepted.
Two ways to authenticate:

* **Account token** (`Authorization: Bearer olx_…`; created in File ▸ Git repository…, revocable)
  — the same one manually configured for Git and the CLI. MCP changes are attributed to the account.
* **OAuth 2.1** (`packages/server/src/mcpOauth.ts`) — for ChatGPT and other clients that speak the
  MCP authorization flow: RFC 8414/9728 discovery under `/.well-known/…`, dynamic client
  registration (RFC 7591) plus ChatGPT's URL-client-id form, authorization code + PKCE (S256),
  RFC 9207 `iss`, refresh-token rotation. The consent page rides the normal session cookie; an
  approved grant mints a separate expiring credential named after the client, so it is listed under
  OAuth connections and revoking it cuts only that connection. In ChatGPT: Settings ▸ Apps ▸
  Developer mode ▸ Create, server URL `https://overlyx.app/mcp`, OAuth — the `search`/`fetch` tool
  pair serves deep research (citations link into the app), the full tool set works in developer
  mode (read-only tools are annotated, so only writes ask for confirmation).

A token or grant stands for the *account* behind it — in every project it gets that account's role
(viewers read; edit access is needed for `propose_edit`, the comment tools and the write tools).
`packages/server/src/mcp.ts` implements the connector on top of `@modelcontextprotocol/sdk`'s
Streamable HTTP transport — stateless (one request/response per JSON-RPC call, no session) for
every client except those in `SESSION_CLIENTS` (`mcpAgents.ts`: Claude Code, clientInfo
`claude-code`), which get a session at initialize (`Mcp-Session-Id`, a GET event stream for pushed
messages, DELETE ends it). Sessions are rows in `mcp_sessions`: a request with a session id the
process does not know (after a restart) brings its session back for the same token instead of a
404 (Claude Code itself re-initializes when its event stream drops). A GET or DELETE without a
session answers 405. `OVERLYX_MCP_LOG=1` logs one line per request (method, tool, session,
clientInfo, User-Agent). It exposes these tools:

* `list_documents`, `read_document(path)` — the project's `.tex` documents and one document's LaTeX
  source (`text`) plus its paragraphs (index, layout, depth, plain text) for the paragraph tools.
* `edit_document(path, old_text, new_text, replace_all?)` — the main edit tool: replaces a passage of
  the document's source, the way coding agents edit files. `old_text` must be unique; it may be
  quoted without the `\lyxadded`/`\lyxdeleted` markup the source contains, and with different
  whitespace (`docedit.ts` `replaceInSource`; a miss reports where the quote diverges). The result
  carries `now_reads`, the edited lines as they now read, for follow-up edits.
* **Every document edit is tracked, and only what changed is marked.** Whatever the tool, the
  edited source or paragraphs are diffed against the live document (`core/src/lyx/trackdiff.ts`):
  paragraphs are aligned, similar ones diffed word by word (a single changed word down to its
  characters: 202~~5~~6), formulas and links as units, footnotes, boxes, floats and same-shaped
  tables entered and diffed inside; the result is `\lyxadded`/`\lyxdeleted` runs and tracked
  paragraph breaks attributed to the agent (author `"<agent> (MCP)"`) — the representation a human's
  Track Changes produces, reviewable and rejectable from the Review toolbar. Accept all gives exactly
  the agent's version, Reject all exactly the previous one. Text already marked deleted is invisible
  to the comparison (it stays deleted when the agent's version leaves it out); another author's
  pending insertion that the agent keeps stays theirs; the agent's *own* pending changes in an edited
  region are taken back and re-derived, so refining a proposal never stacks changes on changes.
  Other people's concurrent edits elsewhere survive (three-way merge, `mergeLyx`). The preamble is
  never tracked: a change to it is applied directly and the result says so (`applied_directly`). A
  command the document defined itself and an edit renamed or removed (`\newcommand{\R}` →
  `\newcommand{\Real}`) is remembered on the open document (`retiredMacros`): the agent's own
  struck-out formulas that use it are removed instead of struck out (a `\lyxdeleted` formula is still
  typeset, so a tracked macro rename never compiled), and the result names the formulas that still
  use it. Whether anything changed is judged by the text, not by the marks — a preamble edit or
  one's own pending insertion taken back is no longer reported as "nothing changed".
* Agent edits of one document run one after the other (`withDocLock`), and a direct edit reads the
  document after its restore-point commit: two calls in flight used to both report success while the
  later one replaced the earlier one's change. Requests over 2 MB, or not JSON, get a JSON-RPC error
  (413 / parse error), not Express's HTML page. `create_document` puts the account's name in
  `\author`, as the editor does.
* `propose_edit(path, paragraph_index, new_text)` — replaces one plain, uniformly formatted text
  paragraph's text (formulas / insets / mixed formatting are refused).
* `list_comments(path)`, `add_comment(path, text, paragraph_index?)`, `resolve_comment(path, index)`
  — comment threads anywhere in the body, inside tables, floats and other insets included (same
  `Note Comment` inset shape and header convention — `Name (date time):` — as the client's comment
  cards); new threads attach at the end of a top-level paragraph.
* `build_pdf(path, wait_seconds?)`, `build_status(path)` — compile with latexmk (viewers may,
  like in the app) and read the result: status, LaTeX warnings, and the compile-log tail. A build
  started before the latest edit never counts. A failed build_pdf also returns the first errors
  (`file:line: message — at «context»`), `previous_build` (for the Agent panel: the last build before
  its changes in this turn) and a note when it built before — "a recent edit broke it".
* `undo_turn(turns_back?)` — only for the Agent panel's agent: take back one of its turns exactly
  (see the Agent panel above).
* **Local agents edit here, directly.** Claude Code, Codex or any MCP client on the user's own
  machine connects to `/mcp` with the account token and edits the project files on this server — no
  local copy, no sync, no shell. The way to register it is the CLI: `overlyx mcp install` (offered by
  the installer and by `auth login`) registers `overlyx mcp serve` with Claude Code (user scope) and
  Codex (`~/.codex/config.toml`) — a stdio bridge that reads the current login and the server's
  `/cli/mcp.json` (endpoint, header template) at every session and relays MCP messages (Streamable
  HTTP: session id, SSE answers, the GET event stream for Claude Code's session, DELETE at the end),
  so a changed connector, endpoint or token needs no re-registration; an installed CLI updates itself
  (checksummed, at most hourly from the bridge). Started in a git clone of an OverLyX project, the
  bridge prepends to the initialize `instructions` which project the directory is (edit it with the
  tools, the clone only changes with `git pull`). The OverLyX repository registers the bridge for
  agents working in a clone of it: `.mcp.json` and `.codex/config.toml` run the checkout's own CLI
  (`packages/cli/bin/overlyx.js`). The Git dialog shows these steps, and the direct `claude mcp add
  --transport http …` / Codex `url` + `bearer_token_env_var` forms for use without the CLI.
* **Signing the CLI in** (`server/src/cliLogin.ts`): `overlyx auth login` opens `/cli/login` with
  a PKCE challenge and the port of a listener on 127.0.0.1; the consent page rides the browser's
  OverLyX session; *Authorize* redirects to the listener with a one-time code (CSP `form-action`
  allows that origin — Chromium checks it on the redirect after the POST; a plain navigation, so no
  local-network permission prompt). Without a local browser (SSH, `--no-browser`) the page shows the
  code to paste instead. `/cli/token` exchanges code + verifier (once, 5 minutes) for a credential
  of the CLI's own (`mcp_tokens`, "OverLyX CLI on <hostname>", revocable in the Git dialog) — good for
  the git API, git push and the MCP bridge — and for plain git: the browser sign-in registers the CLI
  as git's credential helper for that server (`credential.<server>.helper`: an empty entry first,
  which drops helpers configured before it for that URL, then `!overlyx auth git-credential`; `get`
  answers with the stored username and credential), so clones, pulls and pushes in any folder need
  nothing pasted (`--no-git` opts out, `auth setup-git` later, `auth logout` removes it). The
  installer offers the sign-in right away; scripts still pass the account token (`--with-token`,
  `OVERLYX_TOKEN`).
* **Fine-grained access** (opt-in per account: Settings ▸ Account, `users.settings.fineGrainedAccess`,
  `POST /api/settings`; off by default, so a sign-in reaches every project of the account): the
  authorization pages of `overlyx auth login` and of OAuth connections (`server/src/credentialScope.ts`,
  plain form fields) then offer "All your projects" or "Only these projects" (the CLI passes the
  project of the clone it runs in as `project`, which is ticked first) and "Read only". The choice is
  stored on the credential (`mcp_tokens.scope`, JSON `{projects: string[] | null, readonly}`; OAuth
  carries it through `oauth_codes.access_scope` / `oauth_grants.access_scope` to every rotated token)
  and comes back from `verifyAccessToken` as `SessionUser.scope`. `access.ts` applies it in `roleFor`
  and `accessibleProjects` (`withinScope`: other projects → no role, matched by their current key so a
  moved project stays in; read only → `view`), so git, the CLI API and every MCP tool follow it;
  creating projects (`POST /git/api/projects`, MCP `create_project`, which is not even listed) needs
  an unnarrowed credential; refusals say why (`scopeRefusal`). The account token and passwords are
  never narrowed. Switching the setting off leaves narrowed credentials as they are; the Git dialog
  lists each credential's reach, `overlyx auth status` prints it. Document edits are
  tracked by default; `edit_document` and `write_document` take `tracked: false` for the same edit
  applied directly (`applyPlainSource` in `server/docedit.ts`: merged three-way like the tracked form,
  so concurrent edits elsewhere and other people's tracked changes survive; pending changes are
  committed right before, so the state before the direct edit is a commit to restore). The server's
  MCP `instructions` (`MCP_INSTRUCTIONS` in `server/mcp.ts`, sent in the initialize result) tell the
  agent to switch to `tracked: false` on **any** problem with tracked editing — an edit that fails or
  does not match (never retry a failing tracked edit more than once), markup in the way, a garbled
  `now_reads`, a build that breaks after a tracked edit or whose errors point at `\lyxadded` /
  `\lyxdeleted`, math / tables / preamble the tracked form mangles, or the user asking — and to
  build after every change and step back with `project_history` / `restore_project` rather than
  leave a document not compiling. A failed `build_pdf` repeats the hint. The Git dialog's section
  also explains presence (get_presence, the agent as a collaborator) and writing to the agent from
  the Agent panel, with Claude Code's channels flag.
* `edit_file(path, old_text, new_text, replace_all?)` — a passage of a text file (refs.bib, macros,
  `.sty`) replaced directly, like `write_file`; documents are refused (use `edit_document`).
* `project_history(limit?)`, `restore_project(commit)` — the way back for any agent: the project's
  git commits, and the whole project put back to one of them as a new commit on top (`restoreProject`
  in `server/git.ts`, the same operation as *Restore* in the Git dialog and `overlyx restore`;
  editors). A failed `build_pdf` points non-panel agents here.
* `insert_paragraphs(path, index, latex)`, `replace_paragraph(path, index, latex)`,
  `delete_paragraph(path, index)` — **raw LaTeX** (formulas, citations, sections, environments;
  parsed by the same `.tex` parser as the editor) addressed by paragraph index, tracked as above.
  `write_document(path, tex)` creates a document, or writes a whole existing one — tracked as above
  (only the differences to the current document are marked).
* `list_files`, `read_file(path)`, `write_file(path, text)` — the project's other text files
  (`refs.bib`, `macros.tex`, `.sty`, …); binary files and documents are refused.
* On the account-wide `/mcp` endpoint, `create_project(name, title?)` creates an empty project owned
  by the token's account, `<username>/<name>`. An agent can populate it with `create_document`, `write_document` and
  `write_file`; local files, including binaries and an existing Git history, are imported with the
  CLI instead. This tool is intentionally absent from a fixed `/mcp/<owner>/<project>` connection.
* **Where people are: `get_presence(project?, path?)`** (`agentPresence.ts presenceIn`,
  `ycursor.ts describeCursor`). For each open document of the project (or one): the people in it —
  one entry per browser tab or editor, the account taken from the WebSocket connection, not from
  what the client claims — and the agents, each with `cursor` (`paragraph`: the index in
  read_document's `paragraphs`; `offset` into that paragraph's text; `excerpt` with `‸` at the
  cursor; `layout`) and `selection` (`from`/`to` places and the selected text verbatim — across
  paragraphs joined by a blank line, long ones cut in the middle). `you: true` marks the token's own
  account, `self` the asking agent, `moved_seconds_ago` when a cursor last changed. The awareness
  `cursor` (two Yjs relative positions, y-prosemirror's) is resolved server-side: the paragraph is
  serialized with marker characters at the cursor's places through the same conversion
  read_document uses (editor nodes → document model → `itemText`), so formulas, footnotes and
  special characters count exactly as read_document shows them; inside a table (whose cells
  read_document's paragraph text leaves out) the excerpt includes the cells and `offset` is null.
  Without a project (on `/mcp`): only where the user is, across their projects. Only documents the
  token's account can view are listed. MCP_INSTRUCTIONS tell the agent that "this", "here", "the
  selected paragraph" mean the user's own cursor / selection and to call get_presence first.
* **People see the agent.** An agent connected from elsewhere (not the Agent panel's own) gets an
  awareness client of its own in each document it reads or edits (`agentPresence.ts showAgent`): a
  state `{ user: { name: "Claude Code (Jan)", color, agent: true }, cursor }` applied to the
  document's Awareness and relayed by ws.ts like a browser's, so the web client and the VS Code
  extension draw it with their collaborator rendering (presence avatars — agents as rounded
  squares — and a named caret / selection). After an edit the caret covers the range it changed
  (the CRDT events of its transaction, `ycursor.ts changedRange`); `highlight(path, quote |
  paragraph_index, clear?)` points at a passage (`findPassage`: the paragraph's text with formulas
  as their LaTeX, whitespace / quotes / case matched loosely, a long quote by its first and last
  words). The state is renewed every 10 s while the agent works (the Awareness drops states after
  30 s) and removed after 5 minutes without a tool call there (`AGENT_IDLE_MS`); browsers cannot
  overwrite an agent's client id (`isAgentClient` in ws.ts's sanitizer).
* **Messages from OverLyX** (`mcpAgents.ts`). An agent is one MCP client behind one credential —
  (token, `clientInfo.name`) → a row in `mcp_agents`; two sessions of the same client with the same
  token are one agent; a client connecting with a new token after the old one was rotated or
  revoked takes the old row over (its conversation carries on), and agents whose credential is gone
  are not listed. Its owner writes to it in the Agent panel (`POST /api/mcp-agents/:id/messages`,
  stored in `mcp_agent_messages` with the editor context — document, selection as LaTeX marked in
  an excerpt, read only from documents the sender can view). The agent gets it either way:
  `wait_for_instructions(timeout_seconds?)` — a long poll (default 40 s, at most 50 s: Codex gives a
  tool 60 s; progress notifications every 15 s when the client asked for them) that returns as soon
  as a message arrives, works with any client — or pushed to a Claude Code session as
  `notifications/claude/channel` (`{ content, meta: { message_id, from, document } }`, the server
  declares `capabilities.experimental['claude/channel']` on session connections). Claude Code drops
  channel events silently unless it was started with the flag, so a push counts as delivered only
  after that session answered a pushed message (`mcp_sessions.channel_ok`); until then the message
  also stays available to wait_for_instructions. `reply(text, message_id?, done?)` answers (default:
  the last message it got; `done: false` for an interim update). A message handed out by a poll
  that the agent then did nothing about (no other tool call since) is handed out again — that
  answer was most likely lost on the way. MCP_INSTRUCTIONS describe the loop ("listen to OverLyX":
  wait, act, reply, wait again) and the channel tag. **Security:** only the account the token
  belongs to may send — never collaborators or link guests of a shared project (the panel's routes
  check the owner, guests are refused, cross-site requests too); messages are tied to the token's
  identity; at most 8000 characters per message (20000 per reply), 20 messages a minute per
  account, 25 waiting per agent, 40 replies a minute per agent; view-only accounts' agents can
  listen and reply but still not edit. The panel's live view is one SSE stream per account (`GET
  /api/mcp-agents/events`: the agent list, every message added or changed).
* **Claude Code on the user's computer, started from the Agent panel** (`server/src/agentRunner.ts`,
  CLI `overlyx agent …`). An agent in a terminal keeps the model and effort of that terminal; for
  the panel to choose them, the OverLyX CLI on the user's computer runs Claude Code itself:
  `overlyx agent run` keeps one outgoing event stream open (`GET /cli/agent/connect?host=<computer>
  &info={backends, busy, version}`, Bearer = the CLI's sign-in; the server cannot reach into the
  computer) and reports turns back (`POST /cli/agent/turns/:id` `{progress}` | `{final}` |
  `{error}`). `overlyx agent install` makes it a login service (systemd `--user` unit
  `overlyx-agent.service`, launchd `app.overlyx.agent`, with the PATH under which `claude` was
  found; `mcp install` offers it), so nothing is kept running by hand; an installed CLI updates
  itself and the service restarts it. In `mcpAgents.ts` it is an agent like the others — client
  `overlyx-runner@<computer>`, "Claude Code on <computer>" — whose messages go to the runner one at a
  time (`via: 'run'`) with `options` `{model, effort, fresh}` from the panel's pickers (the models
  and efforts come from the runner: it reads `claude --help`). Each turn is `claude -p --output-format
  stream-json --verbose --mcp-config <the CLI's bridge> --strict-mcp-config --allowedTools
  mcp__overlyx --tools "" --permission-mode dontAsk [--model] [--effort] [--resume <session>]` in a
  work directory beside the login (older Claude Code without `--tools`: `--disallowedTools` with
  the built-in tools) — OverLyX's tools only, no shell, no local files, no other MCP servers; the
  computer's owner may allow more built-in tools in `agent.json` (`{"allowTools": ["WebSearch"]}`),
  never the web page. The bridge renames the client in `initialize` to the runner's
  (`OVERLYX_RUNNER_CLIENT`), so Claude Code's edits and its presence are that agent's. Tool calls
  and interim text are sent in batches as progress messages, the last message as the answer; the
  conversation continues (`--resume`, kept in `agent-state.json`) until "New conversation", and one
  that Claude Code cannot resume any more starts afresh. Stop (`POST
  /api/mcp-agents/:id/messages/:mid/stop`) kills the process group; a turn the runner lost by
  restarting is answered as interrupted when it reconnects. Variables of a Claude Code session the
  runner itself was started from (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, …) are not passed on.
  Tests: tests/cli.test.ts (a fake `claude` printing stream-json, a fake `systemctl`).
* **What to run.** The long poll needs nothing: tell the agent (Claude Code, Codex, …) "listen to
  OverLyX". Pushed messages in Claude Code (its research-preview *channels*; Claude Code signed in
  with a claude.ai account or a Console API key, not Bedrock / Vertex / Foundry): add the server as usual (`claude mcp add
  --transport http overlyx <origin>/mcp --header "Authorization: Bearer …"`) and start the session
  with `claude --dangerously-load-development-channels server:overlyx` (the name given in `claude
  mcp add`; a custom channel is not on Anthropic's allowlist, so `--channels` alone does not
  register it — the flag shows a confirmation dialog first). On claude.ai Team and Enterprise plans
  an Owner must first enable channels (claude.ai ▸ Admin settings ▸ Claude Code ▸ Channels, or
  `channelsEnabled: true` in managed settings); otherwise Claude Code connects, the tools work, and
  a startup notice says channels are not enabled — the long poll still works. Claude Code with the
  v2 MCP runtime probes `server/discover` (protocol revision 2026-07-28) first; this server answers
  with the earlier handshake, which is what channels need. Checked with Claude Code 2.1.289 against
  an isolated instance (4 Oct 2026): session, event stream, the long-poll loop end to end, and a push
  sent; the injection itself was not seen because that account's Team org has channels off.

## Authentication and identity

Each user has one manually-managed **account access token** (`olx_…`, `/api/git/tokens`). Creating
it again atomically rotates it, so the previous value immediately stops working in Git, the CLI and
MCP. The account's role is still checked per project on every request. MCP passes the token as
Bearer, while Git and the CLI use the protocol-required username plus token over HTTP Basic.

OAuth clients are the deliberate exception: each grant has a separate, expiring `olxmcp_…`
credential and refresh token so one client can be disconnected without rotating the user's account
token. The embedded agent likewise uses a hidden internal credential. Existing manual agent tokens
remain valid for compatibility and are shown only for revocation; the UI no longer creates them.

## License

GPL-3.0-or-later. OverLyX's engine contains TypeScript ports of LyX source code and ships LyX's
layout files, data tables and icons (LyX is GPL-2.0-or-later), and the PDF viewer uses pdf.js
(Apache-2.0) — the combination is distributed under the GPL v3. See LICENSE and
packages/vscode/THIRD-PARTY-NOTICES.md. LyX is a trademark of the LyX team; this project is not
affiliated with or endorsed by the LyX team, Overleaf, or Microsoft.

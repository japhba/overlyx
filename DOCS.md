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
  with KaTeX; document macros (`FormulaMacro` insets, preamble `\newcommand`/`\def`,
  `\input{macros}` files, child documents) render immediately.
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
  *View ▸ Notes & comments in the margin* moves them into a right-hand column (Google-Docs style).
* **PDF** via `latexmk` on the document's own `.tex` file (plus the child documents it inputs);
  embedded graphics (SVG/PDF/EPS/…) are rendered to PNG for the editor and downloadable as PNG,
  and formats pdflatex cannot include are converted to PDF for the build. PDF builds only start on
  request (Ctrl+R, the toolbar or the PDF panel) and run as **background jobs**: `latexmk` runs
  `nice`d with at most `OVERLYX_MAX_BUILDS` (2) in parallel (XeTeX or LuaTeX when the document uses
  non-TeX fonts or asks for them via its default output format), the PDF panel shows the phase /
  elapsed time / last log line and has a *Cancel* button, and a build keeps running if you switch
  documents or tabs (the panel picks it up again). A request while a build is running re-builds
  once more afterwards with the latest content.
* **Copy & paste** keeps every inset: a paragraph copied and pasted elsewhere (or into another
  OverLyX tab) still has its citations, cross-references, labels, formulas, tables and figures; the
  plain-text form of the clipboard is LaTeX-ish (`$…$`, `\ref{…}`, `\citep{…}`), so pasting into a
  `.tex` file or a chat gives something useful; HTML from a web page or another editor pastes as
  LyX content (headings, bold/italic/typewriter, lists, tables).
* **Safe with the file on disk.** The `.tex` file is written atomically (temporary file + rename,
  fsync'ed). If somebody else wrote the file meanwhile (git, another editor, Overleaf), that
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
  `is_admin` in the database) do **not** see other people's projects: the start screen lists them
  under *Administration*, and *Open as administrator…* grants owner rights for one hour — logged in
  that project's **activity log**, which its owner sees in the Share dialog together with who
  opened, built, pulled, pushed or changed the sharing (`GET /api/projects/:p/activity`). Directories
  that exist without an owner are adopted by the instance owner. *File ▸ Share project…*, the 👥
  button in the file browser, or the start screen. Anyone with a Google account may sign in (they only see their own and shared projects);
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
* **Documents panel, one project at a time** (`app/DocPanel.tsx`, Google-Docs style, left; `Ctrl+Alt+O`):
  the project switcher at the top lists your projects and the ones shared with you — choosing another
  one opens *its* main document (there is no tab bar across projects any more; the hash names the one
  file shown). Below it the project's `.tex` documents are **document tabs** (main, appendix, macros …):
  a tab opens its document in place, and its ▸ reveals the outline — the live one (headings numbered,
  with the ▲ ▼ ◀ ▶ section tools) for the open document, the file's headings (`GET /api/docs/<id>/outline`,
  `core/tex/headings.ts`, no parse) for the others, where a heading opens that document at the heading
  (`#/<doc>?heading=<n>`). *Files* underneath is the file browser for everything else (figures, `.bib`,
  `.sty`, uploads, `+ Doc` / `+ File` / `+ Folder`); files — or whole folders — dragged in from the
  computer are uploaded to where they are dropped (the project, or the folder row under the pointer);
  LaTeX build products (`.aux`, `.log`, `.bbl`, …) and LyX
  backups are hidden unless *All files* is on. The *Navigate* menu lists the sections as well
  (so the command palette finds them).
* **Text editor** for the other files of a project (`.tex`, `.bib`, `.sty`, `.cls`, `.bst`, `.md`,
  `.txt`, `latexmkrc`, …): they open in a tab like documents, with line numbers, autosave 1.5 s
  after the last change (or `Ctrl+S`), and a conflict check — if the file changed on the server
  meanwhile (someone else, git) the save is refused and you choose between the server's
  version and yours. Viewers get it read-only. `+ File` in the file browser creates one.
* **Dark mode**: follows the system preference by default; the sun/moon button in the menu bar
  flips it (remembered in this browser), *View ▸ Theme ▸ Follow the system* goes back to the OS
  setting. Text and formulas are white on a near-black page; everything in
  `packages/client/src/styles.css` goes through the theme tokens at the top of the file (light values
  on `:root`, dark ones on `html[data-theme="dark"]`, set by `app/theme.ts`).
* **Ruler**: a Google-Docs-style ruler above the page (*View ▸ Ruler*) with draggable margin
  handles sets the text width (also *View ▸ Text width*, `Ctrl+Alt+±`); double-click resets it.
* **LyX math editor**: formulas are edited with our own port of LyX's mathed (`packages/core/src/math`:
  the LyX cell/inset model, a port of `MathParser.cpp` and of LyX 2.5's writer so that edited formulas
  are written exactly as LyX writes them, and a port of `Cursor.cpp`/`InsetMathNest` for the cursor)
  rendered with KaTeX (`packages/client/src/editor/lyxmath`). Everything behaves as in LyX: cursor
  movement into and out of insets, `^`/`_`, `\` command mode with name completion by Space, Space
  leaves the inset, Backspace/Delete at cell edges dissolve the inset (`pullArg`), big insets are
  selected before deletion, empty scripts vanish, an empty formula left with ←/→ (or Backspace/Delete)
  is removed again, Enter adds rows (an inline formula becomes align),
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
  and the three toggle buttons at the end of the Standard row). The Standard row also has a **text colour**
  palette: LyX's named colours plus a native colour picker (custom colours are written as
  `\textcolor[HTML]{RRGGBB}{…}` and read back from the `HTML`, `rgb`, `RGB` and `gray` models). The math row has LyX's buttons plus a
  **delimiter palette** (pairs × sizes: `\left…\right`, plain, `\big`, `\Big`, `\bigg`, `\Bigg`, incl.
  `| |`, `‖ ‖`, `⟨ ⟩`, `⟪ ⟫`, `⌊ ⌋`, `⌈ ⌉`, `⟦ ⟧`, arrows) and all of LyX's symbol panels (Greek, arrows,
  relations, operators, dots, decorations, big operators, AMS sets, functions, spacings, styles,
  fractions, fonts) rendered with KaTeX. `⟪ ⟫` (`\llangle … \rrangle`) are no LaTeX/LyX delimiters:
  the first use adds a small macro to the document preamble (`packages/core/src/math/llangle.ts`) that
  makes the plain, `\left…\right` and `\bigl…\bigr` forms compile with symmetric scaled brackets. The
  table row implements LyX's `tabular-feature` commands (`packages/client/src/editor/tablecommands.ts`).
* **Landing page / sign-in** (`app/Login.tsx`, wordmark and sign-in card only): *Continue with Google* is the way in; the username +
  password form (accounts created by an administrator, e2e) is folded away behind a small link while
  Google sign-in is configured, and is the only form otherwise; links go to the GitHub repository and
  the issue tracker.
* **PDF viewer and SyncTeX** (`app/PdfViewer.tsx`, pdf.js): the built PDF is shown in the side
  panel by our own viewer (fit-to-width / zoom, page navigation, a rebuilt PDF keeps the scroll
  position), and a project's `.pdf` files open in a tab of their own from the file browser (ids
  `pdf:<project>/<file>`), like an editor tab in VS Code. latexmk runs with `-synctex=1`; *Navigate ▸
  Sync to PDF* (`Ctrl+Alt+J`, the panel's ⇄ Sync button) finds the cursor's line in the LaTeX as
  built (`app/sourcelocate.ts`) and asks `synctex view` (server, `export.ts`) where it is — the
  viewer scrolls there and flashes the box; a double-click on the PDF asks `synctex edit` for the
  source line and puts the cursor into the paragraph or formula with those words (inverse search).
  *Document ▸ Start Appendix Here* marks the cursor's paragraph as the start of the appendix
  (LyX's `\start_of_appendix`, written as `\appendix`).
* **The raw view** — *View ▸ LaTeX source beside the document* opens `raw:<document>`: the same
  editor instance with its LaTeX source in a resizable pane on the right (`app/SourcePane.tsx`
  layout="right"). The two scroll together (the top paragraph ↔ its source line, via
  `app/sourcelocate.ts`) and the **cursor is mirrored both ways**, character by character: the
  document cursor is a thin bar in the coloured source (the textarea's own caret is put there too
  while nobody types in it), and a click or arrow key in the source puts the document cursor at that
  word (`locateSourceCaret`: the line's block, then the words before the column) and scrolls it into
  view — drawn as a blinking *mirror caret* (`editor/plugins/mirrorcaret.ts`) while the editor has no
  focus. Edits in the source are applied to the document as one types — parsed on the server and
  merged as a diff — a moment after the last keystroke, held back while the LaTeX is unbalanced
  (`checkTexHealth`), `Ctrl+Enter` applies at once; the source is regenerated from the document when
  the pane loses the focus (`Ctrl+Alt+S` toggles the pane).
  The menubar's right side names the project.
* **Command palette** (`app/MenuBar.tsx`): `Ctrl+Shift+P` (`⇧⌘P` on a Mac; `F1` as well) or the
  *Help* menu opens a search over every menu item and the shortcut table — results show the menu
  path and the shortcut, ↑/↓ + Enter runs one, Escape returns the keyboard to the text. The ✎ next
  to a result records a new shortcut for that command (Backspace: none, ↺: default); a key another
  command uses asks first and then moves over. User shortcuts live in `localStorage.ol.keys`
  (`app/keybindings.ts`): a global listener runs them and swallows the default keys of rebound
  commands, so the editor's built-in bindings never fire for them. Shortcuts are written once in LyX
  style (`Ctrl+Alt+O`) and rendered per platform (`⌥⌘O` on a Mac; `app/shortcuts.ts`). LyX's
  `Ctrl+Shift+P` (typewriter) gave way to the palette; give it a key there if you want one.
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
* **Right-click menu** (`editor/editormenu.ts`): what the click landed on comes first (a
  cross-reference, citation, link, child document, graphics, inset, tracked change — with the
  actions that make sense for it), then Cut / Copy / Paste, *Rewrite with AI* (when switched on),
  *Comment on this* and *Turn into a formula* for a selection, the text style, paragraph layout,
  paragraph, insert and track-changes submenus, and the spell-checking switch. Formulas have their
  own menu (numbering, environment, label, insert, fonts, AI); a misspelt word puts its
  corrections first. Shift+right-click gives the browser's own menu.
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
  across that user's projects. Users sign in with their *own* ChatGPT account (device code); a
  thread runs with the project directory as cwd in codex's **read-only** sandbox — the agent reads
  every project file freely, and all *edits* go through OverLyX's own MCP connector (a managed
  `[mcp_servers.overlyx]` entry pointing at `/mcp` with an internal per-account token): document
  edits arrive as tracked changes (`\lyxadded`), reviewable like a collaborator's, `write_file`
  covers `.bib` and friends, `build_pdf` compiles through the app's queue. A direct filesystem
  write is a sandbox exception the panel asks the user to grant. The developer instructions steer the agent to explore
  and explain by default — document edits only on an explicit ask — and codex's web_search tool is
  enabled (internet access; sandboxed shell commands still ask). The panel streams
  message/reasoning deltas, tool calls (folded) and diffs over SSE. Every message carries editor
  context automatically: the open documents and the current selection — as LaTeX (the ⌘K
  conversion) and marked ⟦SELECTION⟧…⟦/SELECTION⟧ in an excerpt of the file. Formulas in the
  transcript (assistant, user and reasoning text) render through the math editor's KaTeX path
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
  `OVERLYX_AGENT_MODEL` overrides the model.
* **AI assistance** (`editor/ai/`, server `ai.ts`; off by default, Tools ▸ AI assistance or
  Preferences — the switches are menu items, so the command palette finds them): needs
  `OPENROUTER_API_KEY` on the server (the same key as "Escalate to AI"); Gemini 3.7 Flash rewrites,
  Gemini 2.5 Flash Lite completes (`OVERLYX_AI_MODEL`, `OVERLYX_AI_COMPLETION_MODEL`). The ⌘K
  panel has its own model picker (kept as the ⌘K preference), accepts follow-up instructions that
  refine the shown proposal (Enter with an empty box accepts), and also works in the source view
  (⌘K over selected raw LaTeX proposes raw source; accepting splices it and the live apply carries
  it into the document). Autocorrect (Tools ▸ Autocorrect typos, on by default): a minor typo is
  fixed when the word is finished — dictionary-based (adjacent-swap candidates checked directly:
  Hunspell never suggests 'the' for 'teh'), never in formulas or code, Backspace right after
  reverts and pins the word for the session.
  * *Rewrite with AI* — `⌘K` / `Ctrl+K` (LyX's delete-to-end-of-paragraph on that key steps aside
    while this is on): select a passage — or nothing, to write at the cursor — and describe the
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
    ghost is rendered by KaTeX at the end of the cell (`\htmlClass{lm-ghost}`), typing its first
    characters keeps it, Tab inserts it as LaTeX. Replies are cached and rate-limited per user.
  * *The ✦ toolbar button* — off the toolbar until *Preferences ▸ Show the ✦ AI button* (or Tools ▸
    AI assistance) enables it; it is a plain on/off switch for autocomplete (text and formulas
    together), nothing else — rewriting stays on ⌘K / the Tools menu.
  * *Models* — Preferences ▸ Models chooses the model for ⌘K and for autocomplete separately (a
    list with measured notes, or any OpenRouter id typed in); the choice is per browser and sent with
    each request (`model`, validated on the server); the server defaults apply otherwise.
* **Cursor memory**: a document reopens with the cursor where it was the last time it was open in
  this browser (`localStorage.ol.cursor:<doc>`, `packages/client/src/editor/cursormemory.ts`; the text
  before the cursor is used to find the place again when the document changed meanwhile).
* **LyX-style dialogs**: Paragraph settings (`Ctrl+Alt+P`: alignment, line spacing, indentation,
  label width), Table settings (cell / column / row / table tabs incl. longtable), Document settings
  (class & options, page & margins, text layout, numbering & floats, fonts, branches, PDF properties,
  preamble, raw header), Graphics (scale, width/height, rotation, clipping, LaTeX options), math
  Delimiters and Matrix insertion — all writing exactly the LyX parameters. Right-click menus on formulas, cross-references (go
  to label, reference format), citations, hyperlinks, child documents, insets and tracked changes;
  `Ctrl/⌘+click` follows a reference or opens a child document (in place — the documents panel on
  the left is where one switches between the files of the project); *View ▸ Master + child documents in one
  view* shows a paper and its `\include`d children as one scrolling page; an editable **Source pane**
  beside the text (`Ctrl+Alt+S`, the *Source* switch in the right tab strip): the document's LaTeX with
  syntax colours (`app/texhighlight.ts`), following the cursor (`app/sourcelocate.ts`: the words before
  the cursor are searched in the source, or the current row of the formula being edited) — edit and
  *Apply* —, drag its top edge to resize; wide display
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
packages/client   Vite + Preact UI, ProseMirror editor, LyX math editor (editor/lyxmath, KaTeX), LyX keymap,
                  numbering/margin/change-tracking/find plugins
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

Environment: `PORT` (default 3000), `OVERLYX_PROJECTS_DIR` (default `/root/projects`; every
sub-directory is a project holding `.tex` files, figures and `.bib`s), `OVERLYX_DATA_DIR`
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
disables the automatic ones), `OVERLYX_LITERATURE` (`off` disables the literature search of the
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
token with *Issues* on one repository is all the feedback channel needs.

`OPENROUTER_API_KEY` (from [openrouter.ai/keys](https://openrouter.ai/keys)) enables "Escalate to AI…"
document repair (see "Document health" below); `OPENROUTER_REPAIR_MODEL` overrides the model
(default `anthropic/claude-opus-5`). Without a key the feature is hidden. The same key powers the
editor's AI assistance (⌘K rewrite, autocomplete; `OVERLYX_AI_MODEL` /
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
OVERLYX_E2E_BASE=http://localhost:5174 npx playwright test e2e/tour.spec.ts e2e/feedback.spec.ts e2e/misc.spec.ts e2e/clipboard.spec.ts e2e/cite.spec.ts
# offline mode needs the built client (service worker): build into $S/dist, then
(cd packages/client && npx vite build --outDir $S/dist)
OVERLYX_E2E_BASE=http://127.0.0.1:3001 npx playwright test e2e/offline.spec.ts e2e/git.spec.ts   # git: a real clone / push / pull with a token
# AI assistance (e2e/ai.spec.ts): the menus / preferences part runs anywhere; the ⌘K and autocomplete
# flows need the server to talk to the stub model: `node scripts/ai-stub.mjs` (port 3999) and the server
# started with OPENROUTER_API_URL=http://127.0.0.1:3999 OPENROUTER_API_KEY=test-key, then
OVERLYX_E2E_AI_STUB=1 OVERLYX_E2E_BASE=http://localhost:5174 npx playwright test e2e/ai.spec.ts
# the Agent panel (e2e/agent.spec.ts): start the server with OVERLYX_CODEX_BIN=scripts/codex-stub.mjs
# (a stand-in for `codex app-server`: sign-in, streamed replies, one approval round-trip), then
OVERLYX_E2E_AGENT_STUB=1 OVERLYX_E2E_BASE=http://localhost:5174 npx playwright test e2e/agent.spec.ts
# "a user writes a paper": real arXiv papers typed from blank documents through the editor UI —
# paperwriting.spec.ts / paperwriting-more.spec.ts (first pages of Attention, a coding-theory paper, BERT) and
# the whole GAN and Adam papers from abstract to bibliography with a latexmk build (~15 min each; needs pdftotext):
OVERLYX_E2E_BASE=http://localhost:5174 npx playwright test e2e/paperwriting-gan.spec.ts e2e/paperwriting-adam.spec.ts
# the papers' real appendices are typed by follow-up sessions in the same specs (Adam's convergence
# proof, BERT's appendices A-C, Attention's visualizations; GAN and the combination-networks paper
# have no appendix in the originals). OVERLYX_E2E_KEEP=1 leaves the typed projects on disk
# (e2e-paperwriting, e2e-paperwriting-more, e2e-paper-gan, e2e-paper-adam); publish them into the
# production admin account so the latest typed-via-GUI papers can always be inspected there:
scripts/publish-typed-papers.sh $S/projects
OVERLYX_E2E_BASE=http://localhost:5174 npx playwright test e2e/pdfview.spec.ts e2e/rawsplit.spec.ts   # pdf.js viewer, SyncTeX, PDF tabs; the [raw] split tab, scroll sync, live apply
```

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
   (two people editing the same sentence simply both get their words in). External changes of
   the file are applied on the server as a *diff* (`packages/server/src/ydiff.ts`), so paragraphs
   they did not touch keep their identity and offline edits inside them survive.
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

## The .tex format

A document is a normal LaTeX file. OverLyX only relies on a few conventions, all of them
invisible to LaTeX itself:

* **A managed block** right before `\begin{document}` (between `%% OverLyX ---` and
  `%% end OverLyX ---`) holds the packages and macro definitions the *content* needs
  (`ulem`/`xcolor` and the change-tracking macros, `graphicx`, `booktabs`, `textcomp`, the
  `\lyxgreyedout` environment, …) — everything the user's own preamble does not already load —
  and one `%% overlyx-settings: {...}` line with what LaTeX cannot express (LyX layout modules,
  citation engine, whether tracked changes are shown in the PDF, …). It is regenerated on every
  save; put your own preamble above it.
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
* **No hard line breaks**: a paragraph is one line of the file (LyX re-wrapped at 65 columns; a
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
  spellings (`\SpecialChar`, protected spaces, …) are written as their LaTeX equivalents.

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
every call), or fixed to one project at `<origin>/mcp/<project>` (the classic form in File ▸ Git
repository…, `Git.tsx`). Two ways to authenticate:

* **Agent tokens** (`Authorization: Bearer olxmcp_…`, `packages/server/src/mcpTokens.ts`; created
  in File ▸ Git repository…, revocable, one per agent) — for clients that take a header.
* **OAuth 2.1** (`packages/server/src/mcpOauth.ts`) — for ChatGPT and other clients that speak the
  MCP authorization flow: RFC 8414/9728 discovery under `/.well-known/…`, dynamic client
  registration (RFC 7591) plus ChatGPT's URL-client-id form, authorization code + PKCE (S256),
  RFC 9207 `iss`, refresh-token rotation. The consent page rides the normal session cookie; an
  approved grant mints an expiring agent token named after the client, so it is listed with the
  account's other tokens and revoking it there cuts the connection. In ChatGPT: Settings ▸ Apps ▸
  Developer mode ▸ Create, server URL `https://overlyx.app/mcp`, OAuth — the `search`/`fetch` tool
  pair serves deep research (citations link into the app), the full tool set works in developer
  mode (read-only tools are annotated, so only writes ask for confirmation).

A token or grant stands for the *account* behind it — in every project it gets that account's role
(viewers read; edit access is needed for `propose_edit`, the comment tools and the write tools).
`packages/server/src/mcp.ts` implements the connector on top of `@modelcontextprotocol/sdk`'s
stateless Streamable HTTP transport (one request/response per JSON-RPC call, no session) and
exposes these tools:

* `list_documents`, `read_document(path)` — the project's `.tex` documents and one document's text
  plus its paragraphs (index, layout, depth, plain text) for addressing the tools below.
* `propose_edit(path, paragraph_index, new_text)` — replaces one paragraph's text. **Always** a
  tracked change: a word-level diff (`core/src/lyx/tokendiff.ts`) turns the edit into
  `\lyxadded`/`\lyxdeleted` runs attributed to the agent (author name `"<agent> (MCP)"`), the same
  representation a human's Track Changes produces — never a silent overwrite, always reviewable
  from the Review toolbar or rejectable like anyone else's edit. Only plain, uniformly-formatted
  text paragraphs are supported (no formulas/citations/other insets, no mixed bold/italic runs);
  anything else is refused with an explanatory error.
* `list_comments(path)`, `add_comment(path, text, paragraph_index?)`, `resolve_comment(path, index)`
  — comment threads anywhere in the body, inside tables, floats and other insets included (same
  `Note Comment` inset shape and header convention — `Name (date time):` — as the client's comment
  cards); new threads attach at the end of a top-level paragraph.
* `build_pdf(path, wait_seconds?)`, `build_status(path)` — compile with latexmk (viewers may,
  like in the app) and read the result: status, LaTeX warnings, and the compile-log tail.
* `insert_paragraphs(path, index, latex)`, `replace_paragraph(path, index, latex)`,
  `delete_paragraph(path, index)` — **raw LaTeX** (formulas, citations, sections, environments;
  parsed by the same `.tex` parser as the editor), applied as tracked changes (plain-text→plain-text
  replaces via a word-level diff; anything else marks the old paragraph deleted and inserts the new
  content). `write_document(path, tex)` replaces — or creates — a whole document's source,
  untracked like the raw-source view (Versions and git keep the prior state).
* `list_files`, `read_file(path)`, `write_file(path, text)` — the project's other text files
  (`refs.bib`, `macros.tex`, `.sty`, …); binary files and documents are refused.

## Authentication and identity

Two separate token systems exist and are not interchangeable, but both are account-scoped:
**git tokens** (`/api/git/tokens`) stand for a signed-in *account* in git; **MCP tokens**
(`/api/mcp-tokens`) stand for one *agent* acting with an account's access (its role checked
per project on every request).

## License

GPL-3.0-or-later. OverLyX's engine contains TypeScript ports of LyX source code and ships LyX's
layout files, data tables and icons (LyX is GPL-2.0-or-later), and the PDF viewer uses pdf.js
(Apache-2.0) — the combination is distributed under the GPL v3. See LICENSE and
packages/vscode/THIRD-PARTY-NOTICES.md. LyX is a trademark of the LyX team; this project is not
affiliated with or endorsed by the LyX team, Overleaf, or Microsoft.


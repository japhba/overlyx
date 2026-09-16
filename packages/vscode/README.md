# OverLyX for VS Code

The [OverLyX](https://overlyx.app) editor as a VS Code custom editor for `.tex` files: LyX-style
WYSIWYG editing of plain LaTeX documents — rendered text, formulas edited in place (KaTeX,
LyX cursor model), LyX toolbars and keybindings, change tracking, notes and comment threads,
tables, floats, citations and cross-references — while **file browsing, git, search and coding
agents stay VS Code's own**. No server and no account: the extension embeds the OverLyX engine
(`@overlyx/core`) and works directly on the files in your workspace. Files written by OverLyX are
reproduced byte for byte until you change them.

## What you get

- **OverLyX editor** for `.tex` files (right-click a file ▸ *Reopen Editor With…* ▸ *OverLyX
  Editor*, or the editor-title button). The document stays an ordinary VS Code `TextDocument`:
  dirty state, Ctrl+S, autosave, git and extensions all see the same file.
- **The web client's editor, not a copy of it.** The plugins, toolbars and dialogs are the same
  code the website runs (`packages/client`), so what lands there lands here with the next release:
  autocorrect, `- ` / `# ` lists and headings, images pasted or dropped into the text, the
  delimiter size buttons, ⟪ ⟫, nomenclature entries.
- **Light / dark** button in the top bar: VS Code's theme, or a light or dark editor of your own choosing.
- **Figures reload** when their file changes on disk (a plot script ran); in the dark theme line art is shown
  light-on-dark, photos are left alone. `$…$` and `$$` type formulas the LaTeX way; `- ` / `# ` at a
  paragraph start make lists and headings.
- **WYSIWYG / TeX / Split** buttons in the top bar switch views within the editor. Ctrl+S in
  TeX view applies the source and saves the file. The ruler above the page resizes the writing
  width; drag its handles or focus a handle and use the arrow keys.
- **Imported math macros** from project files update when those files change, including
  unsaved definitions in another open VS Code editor.
- **Shared figures** using `../` and `../../` paths render from parent directories. Common
  image and PDF extensions can be omitted in `\includegraphics` references.
- **Remote workspaces** route image and PDF previews through VS Code's connection to the
  extension host. Install or update OverLyX in the remote window, then reload that window.
- **Structure view** (OverLyX icon in the activity bar): the live outline — sections, floats —
  click to jump.
- **PDF panel** (Ctrl+R): builds with your local `latexmk` next to the file, shows the PDF with
  build progress and log. SyncTeX both ways: Ctrl+Alt+J shows the cursor's place in the PDF,
  double-click in the PDF jumps to that place in the document.
- **Comments & notes** live in the file as `%%` comment blocks (any other LaTeX tool ignores
  them); show them in the margin or the comments panel. Change tracking uses LyX's
  `\lyxadded`/`\lyxdeleted` macros.
- **Master and child documents in one view** (right-click an `\include` ▸ *Show master and
  child documents in one view*, or the *OverLyX: Show Master and Child Documents in One View*
  command): the `\include`d / `\input` files are edited below the master as one scrolling page,
  each still saved through its own file; Ctrl+S saves them all.
- **Editing a file that changes underneath** (git checkout, a coding agent, you in a split text
  editor) merges into the WYSIWYG view without losing your place.

## Requirements

- A TeX distribution with `latexmk` (and `synctex`) on the PATH for PDF preview — the editor
  itself works without one.
- Optional converters for graphics previews: `rsvg-convert`/`inkscape` (SVG), `pdftoppm` (PDF),
  `gs` (EPS), ImageMagick `convert` (everything else).

## Settings

- `overlyx.layoutDir` — LyX layout files to use (default: the copy bundled with the extension).
- `overlyx.latexmk` — the latexmk executable.

## Where is the outline?

VS Code's built-in Outline panel cannot be fed by webview editors, so with the OverLyX editor
active it says "no outline information" — that is a VS Code limitation, not a missing feature.
The live outline is the **OverLyX Structure** view: in the OverLyX activity-bar icon, and as a
section in the Explorer sidebar while an OverLyX editor is open. A `.tex` file opened as plain
text gets native Outline and breadcrumbs from the extension's symbol provider.

## Updates

Installed from a `.vsix`, the extension is not updated by VS Code. It checks the release
repository (`overlyx.updateRepo`, default `japhba/overlyx`) every five minutes and offers
newer versions (`overlyx.updates`: `prompt` / `auto` / `off`); *OverLyX: Check for Updates* runs
a check on demand. Updates install with the built-in VSIX installer and take effect after a
reload.

Extension-affecting pushes to `master` automatically build, test, and publish a
GitHub release. Website deployment is independent. See [RELEASING.md](RELEASING.md)
for versioning, source provenance, and manual workflow runs.

## Error diagnostics and privacy

When VS Code telemetry is enabled, OverLyX sends errors from the extension host and its webviews
to `https://overlyx.app/api/vscode-telemetry`. Reports contain the sanitized error and stack trace,
the OverLyX and VS Code versions, operating-system/CPU family, and whether the extension host is
local or remote. They never contain document content, filenames, workspace paths, account details,
email addresses, or stable machine/session identifiers. Distinct errors are deduplicated in the
project's issue tracker. Set `overlyx.errorReports` to false, or turn off VS Code telemetry globally,
to disable sending. The exact event schema is in `telemetry.json`; local details remain available in
the **OverLyX** output channel.

## License

GPL-3.0-or-later — the extension bundles data, icons and ported code from
[LyX](https://www.lyx.org) (GPL-2.0-or-later) and the pdf.js viewer (Apache-2.0); see LICENSE
and THIRD-PARTY-NOTICES.md, which also carries the corresponding-source offer.

## Building from source

```
npm install               # repository root
npm run build -w packages/vscode
npm run package -w packages/vscode   # → overlyx-vscode-<version>.vsix
```

## Live development

Clone this repository on the computer where VS Code runs, open the repository root, run
`npm ci`, and press **F5**. The checked-in launch configuration builds the extension and opens
a second VS Code window (the Extension Development Host) with the development copy loaded.
Set breakpoints in the first window and exercise the extension in the second.

For rapid UI work, run **Tasks: Run Task → OverLyX: watch extension**. It continuously rebuilds
the extension host and webview bundles. After a rebuild, run **Developer: Reload Window** in the
Extension Development Host to load it. Changes to command/menu declarations in `package.json`
also require this reload. Stop the watch task when finished.

The website and extension live in the same repository and share `packages/core` and much of
`packages/client`: the webview imports the client's editor assembly (`editor/assembly.ts`), its
toolbars (`app/toolbars.tsx`) and dialogs directly, and `tests/parity.test.ts` fails if the webview
starts assembling an editor or toolbars of its own — put shared behaviour into the client, and only
what is specific to VS Code into `packages/vscode`. Use a branch for each piece of work, push it to GitHub, and merge through
`master`; the server and any other workstation then fetch the same commits. Before starting new
work on either machine, fetch and update from `origin/master`. Avoid editing the same branch on
two machines at once; use separate branches and merge or rebase them through Git.

Pushing extension-affecting changes to `master` automatically runs the extension checks and
publishes a new VSIX release. A local F5 session always uses your current working tree, so you do
not need to publish while iterating.

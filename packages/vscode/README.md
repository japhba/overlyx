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
- **Structure view** (OverLyX icon in the activity bar): the live outline — sections, floats —
  click to jump.
- **PDF panel** (Ctrl+R): builds with your local `latexmk` next to the file, shows the PDF with
  build progress and log. SyncTeX both ways: Ctrl+Alt+J shows the cursor's place in the PDF,
  double-click in the PDF jumps to that place in the document.
- **Comments & notes** live in the file as `%%` comment blocks (any other LaTeX tool ignores
  them); show them in the margin or the comments panel. Change tracking uses LyX's
  `\lyxadded`/`\lyxdeleted` macros.
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

For ordinary windows on a shared SSH host, install the live VSIX and run one persistent
development service. No changes to VS Code or its installed program files are required.

From the repository root:

```
npm run build -w packages/vscode
npm run package:live -w packages/vscode -- /tmp/overlyx-live.vsix
npm run dev:service -w packages/vscode
```

The service installer uses `FAST_CACHE_DIR` for Vite's cache. It creates a user systemd service
restricted to the current hostname, enables it at boot, and restarts it after failures. User
lingering must be enabled for it to run while logged out. Inspect it with
`systemctl --user status overlyx-live`; logs go to `$FAST_CACHE_DIR/overlyx-live/service.log`.

In a Remote-SSH window, use **Extensions: Install from VSIX** to install the resulting file,
then reload that window once. The live package replaces the ordinary OverLyX extension (same
extension ID); its display name is **OverLyX (Live)**. It embeds the source checkout as the
default `overlyx.developmentPath`. Set that machine-scoped setting if you move the checkout.
Every window where this extension is enabled can use the same service. Reconnecting or opening
a new window loads the latest host bundle from the checkout. Self-update checks are disabled
in development mode.

Styles and Preact components update through Vite HMR. Editor views can be recreated while their
Yjs document, undo/redo manager, selection, header and scroll position survive. Pending document
updates are flushed before view disposal. This preserves document history during UI refreshes;
it does not promise to preserve transient dialogs or an active math-field cursor when its
component is replaced. Source changes without a safe HMR boundary request a manual window
reload instead of silently discarding the editor session. Host code and extension-manifest
changes require a window reload; manifest changes also require repackaging the VSIX.

The server listens only on `127.0.0.1:18765`. The extension uses `vscode.env.asExternalUri` for
the dev server and document bridge, resolving their addresses for each new webview. Remote-SSH
handles the connections; no fixed laptop SSH forwards or auto-forwarding setting changes are
needed. `overlyx.developmentServer` changes the address, and `OVERLYX_DEV_PORT` changes the
service's listening port. A server restart may cause Vite to reload a connected page; save
documents before deliberately restarting the service. The service stays running through SSH
disconnects.

To stop live development, stop/disable `overlyx-live.service` and install a normal release VSIX.
Clear any explicit `overlyx.developmentPath` override, then reload the affected windows.

Verification: `npm run test:live -w packages/vscode` exercises two editor clients against the
running service, checks HMR with unsaved edits, cursor position, undo/redo and reconnection.
It briefly changes and restores the editor component source. Pass a TeX file path to test that
document's formulas in the same run. `test/installedLiveTest.mjs` separately tests a normally
installed VSIX in an isolated VS Code profile under Xvfb.

### Debugger development host

Clone this repository on the computer where VS Code runs, open the repository root, run
`npm ci`, and press **F5**. The checked-in launch configuration builds the extension and opens
a second VS Code window (the Extension Development Host) with the development copy loaded.
Set breakpoints in the first window and exercise the extension in the second.

For rapid UI work, run **Tasks: Run Task → OverLyX: watch extension**. It continuously rebuilds
the extension host and webview bundles. After a rebuild, run **Developer: Reload Window** in the
Extension Development Host to load it. Changes to command/menu declarations in `package.json`
also require this reload. Stop the watch task when finished.

The website and extension live in the same repository and share `packages/core` and much of
`packages/client`. Use a branch for each piece of work, push it to GitHub, and merge through
`master`; the server and any other workstation then fetch the same commits. Before starting new
work on either machine, fetch and update from `origin/master`. Avoid editing the same branch on
two machines at once; use separate branches and merge or rebase them through Git.

Pushing extension-affecting changes to `master` automatically runs the extension checks and
publishes a new VSIX release. A local F5 session always uses your current working tree, so you do
not need to publish while iterating.

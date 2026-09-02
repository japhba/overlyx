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

## Building from source

```
npm install               # repository root
npm run build -w packages/vscode
npm run package -w packages/vscode   # → overlyx-vscode-<version>.vsix
```

Development: `node esbuild.mjs --watch` for the host, `npx vite build --watch --config
webview.vite.config.ts` for the webview, then F5 (Extension Development Host) in VS Code.

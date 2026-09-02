# OverLyX

**OverLyX = Overleaf + LyX** — a collaborative, LyX-style WYSIWYG editor for LaTeX documents.

1. **WYSIWYG editing** — text, formulas, tables and floats render as you type, no compile loop;
   LyX's keybindings, toolbars and math editor.
2. **Native .tex** — plain LaTeX files are the source of truth, reproduced byte for byte:
   git, `latexmk`, Overleaf and your other editors keep working on the same files.
3. **Multi-author collaboration** — Google-Docs-style live editing with per-user undo,
   change tracking, comment threads and sharing; every project is a git repository.
4. **Offline support** — documents are mirrored in the browser, edits keep going without a
   connection and merge when you're back.

## Try it

**Web:** [overlyx.app](https://overlyx.app)

**VS Code:** the same editor as an extension — file browsing, git and agents stay VS Code's
([more](packages/vscode/README.md)):

```
curl -sL https://github.com/japhba/overlyx/releases/latest/download/overlyx-vscode.vsix -o /tmp/overlyx.vsix \
  && code --install-extension /tmp/overlyx.vsix
```

or download the `.vsix` from the [latest release](https://github.com/japhba/overlyx/releases/latest)
and run “Extensions: Install from VSIX…”. It self-updates from this repository's releases.
PDF preview needs `latexmk` on the PATH. Linux and macOS; Windows is untested.

## More

[DOCS.md](DOCS.md) — the full tour: every feature in detail, the `.tex` format, offline mode,
sharing and git, self-hosting, development and tests.

## License

GPL-3.0-or-later — the engine contains LyX-derived code and data (GPL-2.0-or-later) and pdf.js
(Apache-2.0); see [LICENSE](LICENSE) and
[THIRD-PARTY-NOTICES](packages/vscode/THIRD-PARTY-NOTICES.md). Not affiliated with the LyX team,
Overleaf, or Microsoft.

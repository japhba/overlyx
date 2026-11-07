The TeX engines OverLyX runs in the browser to build the PDFs of end-to-end encrypted projects. They
are pdfTeX, LuaHBTeX and XeTeX with xdvipdfmx, each with bibtex8 and makeindex, compiled to
WebAssembly from TeX Live's sources with BusyTeX's build. There is one module per engine. Each
module fetches TeX Live's files from the server as it needs them.

How they are built, and how the files are fetched: [tex-wasm/README.md](https://github.com/japhba/overlyx/blob/master/tex-wasm/README.md).

- `sources.txt` says exactly what went in.
- `source-*.tar.gz` is that source: TeX Live, BusyTeX at its commit, expat and fontconfig.
- `SHA256SUMS` lists the hashes of the engines.

**Licences:**
- pdfTeX, LuaTeX and XeTeX: GPL.
- kpathsea: LGPL.
- The libraries: their own free licences.
- BusyTeX's build: MIT.
- OverLyX's parts: GPL-3.0-or-later.

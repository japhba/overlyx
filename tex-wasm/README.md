# TeX engines for the browser

OverLyX builds the PDFs of end-to-end encrypted projects in the browser, where the documents are
readable. This directory builds the TeX engines for that, compiled to WebAssembly:

- **pdfTeX**, **LuaHBTeX** and **XeTeX** (with xdvipdfmx), each with **bibtex8** and **makeindex**;
- one module per engine, so a document only loads the engine it needs (`dist/<engine>.js` + `.wasm`:
  pdfTeX 1.3 MB, LuaHBTeX 4.5 MB, XeTeX 24 MB — most of it ICU's data —, a third of that compressed);
- built from the sources of **TeX Live 2023.0**, the release the server's Ubuntu 24.04 ships, with
  [BusyTeX](https://github.com/busytex/busytex)'s build, unchanged, at a pinned commit;
- SyncTeX included.

They carry no TeX Live files. `kpse_fetch.c` wraps kpathsea's lookup at link time
(`-Wl,--wrap=kpse_find_file,--wrap=kpathsea_find_file`). kpathsea looks where it always looks
first: the working directory with the project's files, and files fetched before. Anything it does
not find there goes to `Module.texliveFile(name, format)` (`kpse_fetch.js`). BusyTeX compiles
TeX Live for one module of all programs; `pdftex_link.c` adds the two symbols a module of pdfTeX
alone then lacks.

In the browser, `packages/client/public/texwasm/worker.js` answers by fetching the file from the
server, one file per request. The server answers from its own TeX Live with
`kpsewhich -progname=<pdflatex|lualatex|xelatex>` (`packages/server/src/e2e/texlive.ts`). So the
server learns which packages and fonts a document loads, never what it says. Engines and files
come from the same TeX Live release, so a document comes out as it does in the server's own builds.

Each run of a program gets a fresh instance of its module, because TeX does not reset its globals;
the compiled module is kept between runs. The LaTeX formats (`pdflatex.fmt`, `lualatex.fmt`,
`xelatex.fmt`) are built by the engines themselves, once per browser, and kept there.

## Building

```sh
make            # sources (checked by SHA-256), BusyTeX's native and wasm builds, then the engines
make engines    # the links into dist/ again, after changing kpse_fetch.* or the link options
make check      # format + test document (amsmath, hyperref, TikZ, BibTeX, SyncTeX; LuaLaTeX a font
                # by name) per engine, with this machine's TeX Live (kpsewhich), in Node
```

**Needs:**
- Emscripten, the version in the Makefile;
- gcc/g++, make, python3, perl, curl, git;
- autoconf, automake, libtool, gettext/autopoint, gperf, flex, bison, cmake and pkg-config;
- for `make check`, a TeX Live (pdfTeX, LuaTeX, XeTeX, latex-extra, pictures).

The full build takes about an hour on four cores. Most of it is BusyTeX's native build, which
generates C and the helper programs, and its wasm build of TeX Live's libraries; the links take
minutes.

## Releases

A tag `tex-wasm-<TeX Live version>-<n>` makes `.github/workflows/tex-wasm.yml` build, check and
publish the engines as that tag's GitHub release. The release carries:

- `SHA256SUMS`;
- `sources.txt`, which says what the engines were built from;
- that source itself, as `source-*.tar.gz`.

`release.json` names the release the client uses and the SHA-256 of each file.
`scripts/fetch-tex-wasm.mjs` runs before the client build. It fetches those files into
`packages/client/public/texwasm/`, keeps them in `~/.cache/overlyx/texwasm`, and refuses any file
whose hash differs.

A new TeX Live on the server means a new release built from that TeX Live's sources:
1. Set `TEXLIVE_VERSION`/`TEXLIVE_SHA256` (and a BusyTeX commit that builds it).
2. Tag the commit.
3. Put the new release's hashes into `release.json`.

The browser builds its formats again by itself, because their key holds the release and the
server's TeX Live version.

## Licences

The engines are TeX Live programs:
- pdfTeX, LuaTeX and XeTeX under the GPL;
- kpathsea under the LGPL;
- the libraries (zlib, libpng, FreeType, HarfBuzz, Graphite2, ICU, Lua, xpdf, pplib, zziplib,
  fontconfig, expat, …) under their own free licences.

BusyTeX's build is MIT-licensed. `kpse_fetch.*`, `check.mjs` and this Makefile are part of OverLyX
(GPL-3.0-or-later). Each release attaches the complete corresponding source.

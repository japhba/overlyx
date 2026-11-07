# The TeX engines that build end-to-end encrypted projects in the browser: pdfTeX, LuaHBTeX and
# XeTeX from TeX Live's own sources, compiled to WebAssembly with BusyTeX's build
# (github.com/busytex/busytex, MIT), one module per engine. Each module fetches TeX Live's files as
# it needs them (kpse_fetch.c / kpse_fetch.js) from the OverLyX server, which reads them from its own
# TeX Live installation — so the engines carry no TeX Live data, and match the server's TeX Live
# release (the sources below are the release Ubuntu 24.04 ships).
#
#   make            everything: sources, native tools, wasm objects, then the engines in dist/
#   make engines    just the links into dist/ (after a full build)
#   make check      the engines compile a test document with the TeX Live of this machine (Node)
#
# Needs: Emscripten $(EMSCRIPTEN_VERSION), gcc/g++, make, python3, perl, autoconf, automake, libtool,
# gettext, gperf, flex, bison, cmake, pkg-config, curl. README.md says more.

EMSCRIPTEN_VERSION = 6.0.6
BUSYTEX_COMMIT     = 2beec8babad2f00b0429b548f51afcbcd8a53eb4
TEXLIVE_VERSION    = 2023.0
TEXLIVE_SHA256     = b14ec8c6873ae04d77cd1de239b660e30f3d6f0e97449aee67e3300ea4a259fd
EXPAT_SHA256       = 6b902ab103843592be5e99504f846ec109c1abb692e85347587f237a4ffa1033
FONTCONFIG_SHA256  = 6be4ebb585ed72a9780433dd8b14916863af6e8cf8c3288eee73e5623a6db75d

URL_texlive    = https://github.com/TeX-Live/texlive-source/archive/refs/heads/tags/texlive-$(TEXLIVE_VERSION).tar.gz
URL_expat      = https://github.com/libexpat/libexpat/releases/download/R_2_5_0/expat-2.5.0.tar.gz
URL_fontconfig = https://github.com/fontconfig/fontconfig/archive/refs/tags/2.13.96.tar.gz

JOBS ?= 3
# cmake 4 refuses expat 2.5.0's cmake_minimum_required otherwise
export CMAKE_POLICY_VERSION_MINIMUM = 3.5
B     = build/busytex
W     = $(B)/build/wasm
WEB2C = $(W)/texlive/texk/web2c
LIBS  = $(W)/texlive/libs

.PHONY: all sources native objects engines check clean
all:
	$(MAKE) objects
	$(MAKE) engines

# ------------------------------------------------------------------------------------- sources
# BusyTeX at its commit (the hash checks it), the sources by their SHA-256
$(B)/Makefile:
	rm -rf $(B) && git clone -q https://github.com/busytex/busytex.git $(B)
	git -C $(B) checkout -q $(BUSYTEX_COMMIT)

build/texlive.tar.gz:    URL = $(URL_texlive)
build/texlive.tar.gz:    SHA = $(TEXLIVE_SHA256)
build/expat.tar.gz:      URL = $(URL_expat)
build/expat.tar.gz:      SHA = $(EXPAT_SHA256)
build/fontconfig.tar.gz: URL = $(URL_fontconfig)
build/fontconfig.tar.gz: SHA = $(FONTCONFIG_SHA256)
build/%.tar.gz:
	mkdir -p build
	curl -fsSL -o $@.part $(URL)
	echo "$(SHA)  $@.part" | sha256sum -c -
	mv $@.part $@

# BusyTeX's Makefile downloads its sources unless source/<name>.txt is there: give it the checked ones
$(B)/source/%.txt: build/%.tar.gz | $(B)/Makefile
	rm -rf $(B)/source/$* && mkdir -p $(B)/source/$*
	tar -xzf $< -C $(B)/source/$* --strip-components=1
	find $(B)/source/$* > $@

sources: $(B)/source/texlive.txt $(B)/source/expat.txt $(B)/source/fontconfig.txt
	@emcc --version | head -1 | grep -q ' $(EMSCRIPTEN_VERSION) ' || { echo "Emscripten $(EMSCRIPTEN_VERSION) is needed"; exit 1; }

# ------------------------------------------------------------------- BusyTeX's build, unchanged
# the native build first: its generated C (tangle, web2c) and tools (icupkg, ...) the wasm build uses
# (BusyTeX's `native` target without its last step, the static link of a native busytex, not needed here)
# (BusyTeX passes ICU's pkgdata $(PKGDATAFLAGS_ICU) and, for wasm, $(PKGDATAFLAGS_IC) without defining
# them: pkgdata then takes its settings from a system ICU's pkg-config, where there is one; given here)
# (pkg-config sees no libraries of the machine, in both builds: fontconfig's configure would build its
# test program against one it finds — json-c — which has no wasm build; BusyTeX gives every library itself)
NOPC = PKG_CONFIG_LIBDIR=$(abspath build)/no-pc PKG_CONFIG_PATH=
ICU_native = PKGDATAFLAGS_ICU="--without-assembly -O $(abspath $(B))/build/native/texlive/libs/icu/icu-build/data/icupkg.inc"
ICU_wasm   = PKGDATAFLAGS_IC="--without-assembly -O $(abspath $(B))/build/wasm/texlive/libs/icu/icu-build/data/icupkg.inc"

native: sources
	mkdir -p build/no-pc
	$(NOPC) $(MAKE) -C $(B) build/native/texlive.configured MAKEFLAGS=-j$(JOBS)
	$(NOPC) $(MAKE) -C $(B) build/native/texlivedependencies MAKEFLAGS=-j$(JOBS) $(ICU_native)
	$(NOPC) $(MAKE) -C $(B) build/native/busytexapplets MAKEFLAGS=-j$(JOBS)

# TeX Live configured and compiled for wasm: the libraries and each program's objects (BusyTeX's
# `wasm` target without its last step, the link of all programs into one module)
objects: native
	$(NOPC) $(MAKE) -C $(B) build/wasm/texlive.configured MAKEFLAGS=-j$(JOBS)
	$(NOPC) $(MAKE) -C $(B) build/wasm/texlivedependencies MAKEFLAGS=-j$(JOBS) $(ICU_wasm)
	$(NOPC) $(MAKE) -C $(B) build/wasm/busytexapplets MAKEFLAGS=-j$(JOBS)

# ---------------------------------------------------------------------------------- the engines
# Each module runs one program per instance (TeX does not reset its globals): the caller compiles
# the .wasm once and instantiates it for every run. bibtex8 and makeindex come with every engine.
LINK = -O2 -sMODULARIZE=1 -sENVIRONMENT=worker,node -sEXIT_RUNTIME=0 -sINVOKE_RUN=0 \
  -sFORCE_FILESYSTEM=1 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB -sMAXIMUM_MEMORY=2GB \
  -sSTACK_SIZE=5MB -sEXPORTED_FUNCTIONS=_main,_flush_streams -sEXPORTED_RUNTIME_METHODS=callMain,FS,ENV \
  --js-library kpse_fetch.js -Wl,--wrap=kpse_find_file,--wrap=kpathsea_find_file

TOOLS  = $(W)/texlive/texk/bibtex-x/busytex_bibtex8.a $(W)/texlive/texk/makeindexk/busytex_makeindex.a
KPSE   = $(W)/texlive/texk/kpathsea/.libs/libkpathsea.a
PDFTEX = $(addprefix $(WEB2C)/, synctexdir/pdftex-synctex.o pdftex-pdftexini.o pdftex-pdftex0.o \
  pdftex-pdftex-pool.o pdftexdir/pdftex-pdftexextra.o lib/lib.a libmd5.a busytex_libpdftex.a) \
  $(addprefix $(LIBS)/, xpdf/libxpdf.a libpng/libpng.a zlib/libz.a)
LUAHBTEX = $(addprefix $(WEB2C)/, luatexdir/luahbtex-luatex.o mplibdir/luahbtex-lmplib.o \
  libluahbtexspecific.a libluaharfbuzz.a busytex_libluahbtex.a libff.a libluamisc.a libluasocket.a \
  libluaffi.a libmplibcore.a libmputil.a libunilib.a libmd5.a lib/lib.a) \
  $(addprefix $(LIBS)/, harfbuzz/libharfbuzz.a graphite2/libgraphite2.a libpng/libpng.a \
  pplib/libpplib.a zlib/libz.a zziplib/libzzip.a lua53/.libs/libtexlua53.a)
XETEX = $(addprefix $(WEB2C)/, synctexdir/xetex-synctex.o xetex-xetexini.o xetex-xetex0.o \
  xetex-xetex-pool.o xetexdir/xetex-xetexextra.o lib/lib.a libmd5.a busytex_libxetex.a) \
  $(W)/texlive/texk/dvipdfm-x/busytex_xdvipdfmx.a $(W)/fontconfig/src/.libs/libfontconfig.a \
  $(W)/expat/libexpat.a $(addprefix $(LIBS)/, harfbuzz/libharfbuzz.a graphite2/libgraphite2.a \
  teckit/libTECkit.a libpng/libpng.a freetype2/libfreetype.a pplib/libpplib.a zlib/libz.a libpaper/libpaper.a \
  icu/icu-build/lib/libicuuc.a icu/icu-build/lib/libicudata.a)

APPLETS_pdftex   = -DBUSYTEX_PDFTEX -DBUSYTEX_BIBTEX8 -DBUSYTEX_MAKEINDEX
APPLETS_luahbtex = -DBUSYTEX_LUATEX -DBUSYTEX_BIBTEX8 -DBUSYTEX_MAKEINDEX
APPLETS_xetex    = -DBUSYTEX_XETEX -DBUSYTEX_XDVIPDFMX -DBUSYTEX_BIBTEX8 -DBUSYTEX_MAKEINDEX
# what an engine needs of its own besides (pdftex_link.c says what)
EXTRA_pdftex     = pdftex_link.c

dist/%.js: kpse_fetch.c kpse_fetch.js $(wildcard *_link.c)
	mkdir -p dist build/link
	emcc -Oz -o build/link/$*-main.o -c $(B)/busytex.c $(APPLETS_$*)
	emcc -Oz -o build/link/kpse_fetch.o -c kpse_fetch.c
	$(if $(EXTRA_$*),emcc -Oz -o build/link/$*-extra.o -c $(EXTRA_$*))
	em++ -o $@ build/link/$*-main.o build/link/kpse_fetch.o $(if $(EXTRA_$*),build/link/$*-extra.o) \
	  $($(shell echo $* | tr a-z A-Z)) $(TOOLS) $(KPSE) \
	  $(LINK) -sEXPORT_NAME=$*

# the engines, TeX Live's texmf.cnf of the same release (memory sizes and the like; the worker points
# its paths elsewhere), what they were built from, and that source itself (GPL: pdfTeX, LuaTeX, XeTeX)
engines: dist/pdftex.js dist/luahbtex.js dist/xetex.js
	cp $(B)/source/texlive/texk/kpathsea/texmf.cnf dist/texmf.cnf
	{ echo "TeX Live $(TEXLIVE_VERSION): $(URL_texlive) sha256 $(TEXLIVE_SHA256)"; \
	  echo "BusyTeX: https://github.com/busytex/busytex/tree/$(BUSYTEX_COMMIT)"; \
	  echo "expat 2.5.0: $(URL_expat) sha256 $(EXPAT_SHA256)"; \
	  echo "fontconfig 2.13.96: $(URL_fontconfig) sha256 $(FONTCONFIG_SHA256)"; \
	  emcc --version | head -1; } > dist/sources.txt
	git -C $(B) archive --format=tar.gz --prefix=busytex-$(BUSYTEX_COMMIT)/ -o $(abspath dist/source-busytex-$(BUSYTEX_COMMIT).tar.gz) $(BUSYTEX_COMMIT)
	for n in texlive expat fontconfig; do cp build/$$n.tar.gz dist/source-$$n.tar.gz; done
	cp NOTES.md dist/NOTES.md
	cd dist && sha256sum *.js *.wasm texmf.cnf > SHA256SUMS && cat SHA256SUMS

check:
	node check.mjs

clean:
	rm -rf build dist

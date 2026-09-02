// Copies what the packaged extension needs next to dist/: the LyX layout files and lib data
// (languages, unicodesymbols, symbols, latexfonts) the core parser/writer read, and the
// client's static assets used by the webview (LyX toolbar icons).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.join(here, '..');
const lyxLib = process.env.LYX_LIB_DIR ?? ['/root/lyx/lib', path.join(pkg, '../../lyx/lib')].find(p => fs.existsSync(path.join(p, 'layouts')));
if (!lyxLib) { console.error('LyX lib directory not found (set LYX_LIB_DIR)'); process.exit(1); }

const out = path.join(pkg, 'dist/lyxlib');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'layouts'), { recursive: true });
for (const f of fs.readdirSync(path.join(lyxLib, 'layouts'))) {
  if (/\.(layout|module|inc)$/.test(f)) fs.copyFileSync(path.join(lyxLib, 'layouts', f), path.join(out, 'layouts', f));
}
for (const f of ['languages', 'unicodesymbols', 'symbols', 'latexfonts']) {
  fs.copyFileSync(path.join(lyxLib, f), path.join(out, f));
}
// LyX toolbar icons from the client (lyxicons.ts references /lyxicons/<name>.svg)
const icons = path.join(pkg, '../client/public/lyxicons');
const iconsOut = path.join(pkg, 'dist/webview/lyxicons');
fs.mkdirSync(iconsOut, { recursive: true });
for (const f of fs.readdirSync(icons)) fs.copyFileSync(path.join(icons, f), path.join(iconsOut, f));
// spell checker dictionaries (served by the bridge at /dict/<lang>.aff|.dic)
const DICTS = { en: 'dictionary-en', 'en-gb': 'dictionary-en-gb', de: 'dictionary-de', fr: 'dictionary-fr' };
const dictOut = path.join(pkg, 'dist/dict');
fs.mkdirSync(dictOut, { recursive: true });
for (const [lang, mod] of Object.entries(DICTS)) {
  for (const ext of ['aff', 'dic']) {
    const src = path.join(pkg, '../../node_modules', mod, 'index.' + ext);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dictOut, lang + '.' + ext));
  }
}
console.log('assets copied:', out, iconsOut, 'and', dictOut);

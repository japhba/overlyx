/**
 * OverLyX's own spell checker (Tools ▸ Spell checking; engine chosen in the preferences): the
 * document is checked in a worker with a Hunspell dictionary for its language, misspelt words are
 * underlined with an inline decoration, the right-click menu offers suggestions, "add to
 * dictionary" (kept per browser) and "ignore". Only the paragraphs a change touched are
 * re-checked (ProseMirror keeps the untouched nodes' identity); the word the cursor is in is left
 * alone until the cursor moves on.
 */
import { Plugin, PluginKey, type EditorState, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { getPrefs, subscribePrefs } from '../../prefs';
import { editorContext } from '../context';
import { checkableBlocks, wordsOf, type Word } from './tokenize';
import type { SpellRequest, SpellResponse } from './worker';
import workerUrl from './worker.ts?worker&url';
import { API_BASE } from '../../api';

export const spellKey = new PluginKey<DecorationSet>('lyx-spell');

/** LyX language names → dictionary */
export function dictionaryFor(language: string | undefined): string {
  const l = (language ?? 'english').toLowerCase();
  if (l === 'british') return 'en-gb';
  if (/german|ngerman|austrian|swiss/.test(l)) return 'de';
  if (/french/.test(l)) return 'fr';
  return 'en';
}

/* ------------------------------------------------------------ the worker, shared by all editors */

/** where the dictionaries are: the site's /dict/, the VS Code extension's local bridge */
const dictBase = () => new URL(`${API_BASE}/dict/`, location.href).href;

type SpellWorker = { postMessage(m: SpellRequest): void };

/**
 * A VS Code webview refuses a worker from the extension's files or the development server (another
 * origin: "SecurityError: Failed to construct 'Worker'"), and a worker started from a blob may not
 * import from there either. So there the page fetches the worker's code, and the modules it imports
 * (the development server's), and starts it from blobs of its own — as the PDF's worker is
 * (vscode webview/BuiltPdf.tsx); messages wait for it.
 */
function startWorker(onmessage: (ev: MessageEvent<SpellResponse>) => void): SpellWorker {
  try { const w = new Worker(workerUrl, { type: 'module' }); w.onmessage = onmessage; return w; }
  catch (e) {
    if ((e as Error)?.name !== 'SecurityError') throw e;
    const queue: SpellRequest[] = [];
    let w: Worker | null = null;
    void blobModule(new URL(workerUrl, document.baseURI).href, new Map()).then(blob => {
      w = new Worker(blob, { type: 'module' });
      w.onmessage = onmessage;
      for (const m of queue.splice(0)) w.postMessage(m);
    }).catch(err => console.warn('[spell] no worker:', err));
    return { postMessage: m => { if (w) w.postMessage(m); else queue.push(m); } };
  }
}

/** a module at `url` as a blob, the modules it imports (`from "/…"`, `import "/…"`) as blobs too */
function blobModule(url: string, made: Map<string, Promise<string>>): Promise<string> {
  let blob = made.get(url);
  if (!blob) made.set(url, blob = (async () => {
    const code = await fetch(url).then(r => { if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.text(); });
    const IMPORT = /(\bfrom\s*|^\s*import\s*)(["'])(\.{0,2}\/[^"'\n]*)\2/gm;
    const deps = new Map<string, string>();
    for (const m of code.matchAll(IMPORT)) { const dep = new URL(m[3], url).href; deps.set(dep, await blobModule(dep, made)); }
    const src = code.replace(IMPORT, (_m, head: string, q: string, spec: string) => head + q + deps.get(new URL(spec, url).href) + q);
    return URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  })());
  return blob;
}

const PERSONAL_KEY = 'ol.spell.words';
function loadPersonal(): Set<string> { try { return new Set(JSON.parse(localStorage.getItem(PERSONAL_KEY) ?? '[]')); } catch { return new Set(); } }
const personal = loadPersonal();
const ignored = new Set<string>();
let worker: SpellWorker | null = null;
let workerLang = '';
let seq = 0;
const waiting = new Map<number, (r: SpellResponse) => void>();
/** per-language cache of checked words */
const caches = new Map<string, Map<string, boolean>>();
const listeners = new Set<() => void>();

function ensureWorker(lang: string): SpellWorker | null {
  if (!worker) {
    try {
      worker = startWorker(ev => {
        const m = ev.data;
        if (m.type === 'loaded') { if (!m.ok) console.warn('[spell] dictionary failed to load:', m.error); return; }
        const cb = waiting.get(m.id);
        if (cb) { waiting.delete(m.id); cb(m); }
      });
    } catch (e) { console.warn('[spell] no worker:', e); return null; }
    if (personal.size) worker.postMessage({ type: 'add', words: [...personal] } satisfies SpellRequest);
  }
  if (workerLang !== lang) { workerLang = lang; worker.postMessage({ type: 'load', lang, base: dictBase() } satisfies SpellRequest); }
  return worker;
}

function checkWords(lang: string, words: string[]): Promise<Set<string>> {
  const w = ensureWorker(lang);
  if (!w || !words.length) return Promise.resolve(new Set());
  const id = ++seq;
  return new Promise(resolve => {
    waiting.set(id, r => resolve(new Set(r.type === 'result' ? r.wrong : [])));
    w.postMessage({ type: 'check', id, words } satisfies SpellRequest);
  });
}

/** Suggestions for a misspelt word (Hunspell's, capitalised like the word). */
export function spellSuggest(word: string, language?: string): Promise<string[]> {
  const w = ensureWorker(dictionaryFor(language ?? editorContext.meta?.language));
  if (!w) return Promise.resolve([]);
  const id = ++seq;
  return new Promise(resolve => {
    const t = setTimeout(() => { waiting.delete(id); resolve([]); }, 1500);
    waiting.set(id, r => { clearTimeout(t); resolve(r.type === 'suggestions' ? r.list : []); });
    w.postMessage({ type: 'suggest', id, word } satisfies SpellRequest);
  });
}

/** Is the word spelled correctly? (true also when no dictionary is available — never correct blindly) */
export function spellCheckWord(word: string, language?: string): Promise<boolean> {
  const w = ensureWorker(dictionaryFor(language ?? editorContext.meta?.language));
  if (!w) return Promise.resolve(true);
  const id = ++seq;
  return new Promise(resolve => {
    const t = setTimeout(() => { waiting.delete(id); resolve(true); }, 1500);
    waiting.set(id, r => { clearTimeout(t); resolve(!(r.type === 'result' && r.wrong.length)); });
    w.postMessage({ type: 'check', id, words: [word] } satisfies SpellRequest);
  });
}

function notify(): void { for (const l of listeners) l(); }
/** the word (and its case variants) is fine from now on, in every document opened in this browser */
export function addToDictionary(word: string): void {
  personal.add(word);
  try { localStorage.setItem(PERSONAL_KEY, JSON.stringify([...personal])); } catch { /* ignore */ }
  worker?.postMessage({ type: 'add', words: [word] } satisfies SpellRequest);
  for (const c of caches.values()) c.set(word, true);
  notify();
}
/** the word is fine for this session */
export function ignoreWord(word: string): void { ignored.add(word); for (const c of caches.values()) c.set(word, true); notify(); }
export function isPersonal(word: string): boolean { return personal.has(word) || ignored.has(word); }

/* ------------------------------------------------------------ the plugin */

export function spellingOn(): boolean { const p = getPrefs(); return p.spellcheck && p.spellEngine !== 'browser'; }

/** The misspelt word at a document position (from the decorations), if any. */
export function misspelledAt(state: EditorState, pos: number): Word | null {
  const decos = spellKey.getState(state);
  if (!decos) return null;
  const hit = decos.find(pos, pos).find(d => d.from <= pos && d.to >= pos && d.spec.word);
  return hit ? { word: hit.spec.word as string, from: hit.from, to: hit.to } : null;
}

export function spellPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: spellKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr: Transaction, set: DecorationSet): DecorationSet {
        const meta = tr.getMeta(spellKey);
        if (meta instanceof DecorationSet) return meta;
        if (meta === 'clear') return DecorationSet.empty;
        return tr.docChanged ? set.map(tr.mapping, tr.doc) : set;
      },
    },
    props: { decorations(state) { return spellKey.getState(state) ?? DecorationSet.empty; } },
    view(view) {
      /** decorations per text block node (offsets relative to the block's start): untouched blocks keep theirs */
      let perBlock = new Map<PMNode, { word: string; from: number; to: number }[]>();
      let timer: ReturnType<typeof setTimeout> | null = null;
      let running = false, again = false, destroyed = false;
      let lastLang = '';

      const schedule = (delay = 300) => { if (timer) clearTimeout(timer); timer = setTimeout(() => { timer = null; void run(); }, delay); };
      const clear = () => { perBlock = new Map(); if (spellKey.getState(view.state)?.find().length) view.dispatch(view.state.tr.setMeta(spellKey, 'clear').setMeta('addToHistory', false)); };

      const run = async () => {
        if (destroyed) return;
        if (!spellingOn()) { clear(); return; }
        if (running) { again = true; return; }
        running = true;
        try {
          const lang = dictionaryFor(editorContext.meta?.language);
          if (lang !== lastLang) { lastLang = lang; perBlock = new Map(); }
          const cache = caches.get(lang) ?? new Map<string, boolean>();
          caches.set(lang, cache);
          const doc = view.state.doc;
          const blocks = checkableBlocks(doc);
          // words of the blocks that changed, not yet known to the cache
          const unknown = new Set<string>();
          for (const b of blocks) {
            if (perBlock.has(b.node)) continue;
            for (const w of wordsOf(b.node, b.pos)) if (!cache.has(w.word) && !isPersonal(w.word)) unknown.add(w.word);
          }
          if (unknown.size) {
            const wrong = await checkWords(lang, [...unknown]);
            if (destroyed) return;
            for (const w of unknown) cache.set(w, !wrong.has(w));
          }
          // the document may have moved on while the worker was busy: decorate the current one
          const cur = view.state.doc;
          const curBlocks = cur === doc ? blocks : checkableBlocks(cur);
          const next = new Map<PMNode, { word: string; from: number; to: number }[]>();
          const decos: Decoration[] = [];
          const sel = view.state.selection;
          for (const b of curBlocks) {
            let list = perBlock.get(b.node);
            if (!list) {
              list = [];
              for (const w of wordsOf(b.node, b.pos)) {
                if (isPersonal(w.word)) continue;
                const ok = cache.get(w.word);
                if (ok === false) list.push({ word: w.word, from: w.from - b.pos, to: w.to - b.pos });
                else if (ok === undefined) { again = true; }   // appeared meanwhile: next round
              }
            }
            next.set(b.node, list);
            for (const w of list) {
              if (isPersonal(w.word)) continue;   // added to the dictionary since the block was checked
              const from = b.pos + w.from, to = b.pos + w.to;
              if (sel.empty && sel.from >= from && sel.from <= to) continue;   // the word being typed
              decos.push(Decoration.inline(from, to, { class: 'spell-error' }, { word: w.word }));
            }
          }
          perBlock = next;
          if (view.state.doc === cur) view.dispatch(view.state.tr.setMeta(spellKey, DecorationSet.create(cur, decos)).setMeta('addToHistory', false));
          else again = true;
        } finally {
          running = false;
          if (again && !destroyed) { again = false; schedule(150); }
        }
      };

      const unsubPrefs = subscribePrefs(() => { perBlock = new Map(); schedule(0); });
      const onDictionary = () => { perBlock = new Map(); schedule(0); };   // a word was added / ignored: every block's list is stale
      listeners.add(onDictionary);
      schedule(50);
      return {
        update(v, prev) {
          if (v.state.doc !== prev.doc) schedule();
          else if (!v.state.selection.eq(prev.selection) && !v.state.selection.empty === false) {
            // the cursor left a word that was skipped while being typed: show it now (cheap: the block is cached)
            const $p = prev.selection.$from, $n = v.state.selection.$from;
            if (prev.selection.empty && ($p.parent !== $n.parent || Math.abs($p.pos - $n.pos) > 1 || /\s/.test(v.state.doc.textBetween(Math.min($p.pos, $n.pos), Math.max($p.pos, $n.pos), ' ')))) schedule(200);
          }
        },
        destroy() { destroyed = true; if (timer) clearTimeout(timer); unsubPrefs(); listeners.delete(onDictionary); },
      };
    },
  });
}

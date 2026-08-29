/**
 * Spell-checking worker: a Hunspell dictionary (nspell) for the document's language, loaded on
 * demand. The main thread sends batches of words and gets back the misspelt ones; suggestions
 * are computed one word at a time (they are the slow part of Hunspell) when a menu asks for them.
 */
import nspell from 'nspell';

export type SpellRequest =
  | { type: 'load'; lang: string }
  | { type: 'check'; id: number; words: string[] }
  | { type: 'suggest'; id: number; word: string }
  | { type: 'add'; words: string[] };
export type SpellResponse =
  | { type: 'loaded'; lang: string; ok: boolean; error?: string }
  | { type: 'result'; id: number; wrong: string[] }
  | { type: 'suggestions'; id: number; list: string[] };

/** served from /dict/<lang>.aff|.dic (vite.config.ts `dictionaries` plugin: the dictionary-* packages at build, a middleware in dev) */
const KNOWN = new Set(['en', 'en-gb', 'de', 'fr']);
const DICTS = (lang: string): [string, string] => { const l = KNOWN.has(lang) ? lang : 'en'; return [`/dict/${l}.aff`, `/dict/${l}.dic`]; };

let spell: ReturnType<typeof nspell> | null = null;
let loaded = '';
let personal: string[] = [];
const pending: SpellRequest[] = [];

async function load(lang: string): Promise<void> {
  const urls = DICTS(lang);
  try {
    const [aff, dic] = await Promise.all(urls.map(u => fetch(u).then(r => { if (!r.ok) throw new Error(`${u}: ${r.status}`); return r.text(); })));
    spell = nspell(aff, dic);
    for (const w of personal) spell.add(w);
    loaded = lang;
    postMessage({ type: 'loaded', lang, ok: true } satisfies SpellResponse);
  } catch (e) {
    spell = null; loaded = '';
    postMessage({ type: 'loaded', lang, ok: false, error: String(e) } satisfies SpellResponse);
  }
  for (const m of pending.splice(0)) handle(m);
}

function handle(m: SpellRequest): void {
  switch (m.type) {
    case 'load': if (m.lang !== loaded) void load(m.lang); return;
    case 'add': personal.push(...m.words); if (spell) for (const w of m.words) spell.add(w); return;
    case 'check': {
      if (!spell) { pending.push(m); return; }
      const wrong = m.words.filter(w => !spell!.correct(w));
      postMessage({ type: 'result', id: m.id, wrong } satisfies SpellResponse);
      return;
    }
    case 'suggest': {
      if (!spell) { pending.push(m); return; }
      let list: string[] = [];
      try { list = spell.suggest(m.word).slice(0, 6); } catch { /* ignore */ }
      postMessage({ type: 'suggestions', id: m.id, list } satisfies SpellResponse);
      return;
    }
  }
}

self.onmessage = (ev: MessageEvent<SpellRequest>) => handle(ev.data);

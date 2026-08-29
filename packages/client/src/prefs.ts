/**
 * Per-browser editor preferences (Tools ▸ Preferences…; the toggles also sit in the Tools menu
 * and are therefore searchable from the command palette). Stored in localStorage `ol.prefs`.
 *
 * The AI features are off by default: they send the document to a model through the server,
 * which is something a user should switch on knowingly (the server also has to be configured
 * with a key — Tools ▸ AI says so when it is not).
 */
export interface Prefs {
  /** the browser's spell checker on the text (red underlines) */
  spellcheck: boolean;
  /** ⌘K / Ctrl+K: rewrite the selection with an instruction */
  aiRewrite: boolean;
  /** ghost-text continuation after a pause while typing text */
  aiCompleteText: boolean;
  /** the same inside formulas */
  aiCompleteMath: boolean;
  /** pause before a completion is requested (ms) */
  aiCompleteDelay: number;
  /** OpenRouter model ids for ⌘K and for autocomplete ('' = the server's default) */
  aiModel: string;
  aiCompletionModel: string;
}

export const DEFAULT_PREFS: Prefs = { spellcheck: true, aiRewrite: false, aiCompleteText: false, aiCompleteMath: false, aiCompleteDelay: 200, aiModel: '', aiCompletionModel: '' };
/** delays that were the default in earlier builds: a stored one of these follows the current default */
const OLD_DEFAULT_DELAYS = new Set([600, 450]);
const STORAGE = 'ol.prefs';

function load(): Prefs {
  try {
    const v = JSON.parse(localStorage.getItem(STORAGE) ?? '{}');
    if (v && typeof v === 'object' && OLD_DEFAULT_DELAYS.has(v.aiCompleteDelay)) delete v.aiCompleteDelay;
    return v && typeof v === 'object' ? { ...DEFAULT_PREFS, ...v } : { ...DEFAULT_PREFS };
  } catch { return { ...DEFAULT_PREFS }; }
}

let prefs: Prefs = load();
const listeners = new Set<(p: Prefs) => void>();

export function getPrefs(): Prefs { return prefs; }
export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
  if (prefs[key] === value) return;
  prefs = { ...prefs, [key]: value };
  try { localStorage.setItem(STORAGE, JSON.stringify(prefs)); } catch { /* ignore */ }
  for (const l of listeners) { try { l(prefs); } catch { /* ignore */ } }
}
export function subscribePrefs(l: (p: Prefs) => void): () => void { listeners.add(l); return () => { listeners.delete(l); }; }

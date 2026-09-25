/**
 * Per-browser editor preferences (Tools ▸ Preferences…; the toggles also sit in the Tools menu
 * and are therefore searchable from the command palette). Stored in localStorage `ol.prefs`.
 *
 * The AI features are off by default: they send the document to a model through the server,
 * which is something a user should switch on knowingly (the server also has to be configured
 * with a key — Tools ▸ AI says so when it is not).
 */
export interface Prefs {
  /** spell checking on the text (red underlines) */
  spellcheck: boolean;
  /** OverLyX's own checker (Hunspell in a worker, LaTeX-aware, suggestions in the menu) or the browser's */
  spellEngine: 'overlyx' | 'browser';
  /** minor typos are corrected as you finish a word (dictionary-based, never in math; Backspace reverts) */
  autoCorrect: boolean;
  /** the ✦ button on the toolbar (switches autocomplete on and off); hidden until it is enabled here */
  aiButton: boolean;
  /** ⌘K / Ctrl+K: rewrite the selection with an instruction */
  aiRewrite: boolean;
  /** ghost-text continuation after a pause while typing text */
  aiCompleteText: boolean;
  /** the same inside formulas */
  aiCompleteMath: boolean;
  /** pause before a completion is requested (ms) */
  aiCompleteDelay: number;
  /** Smart inversion adapts plots on a white base to the dark theme; photographs keep their colours. */
  invertFigures: boolean;
  /** OpenRouter model ids for ⌘K and for autocomplete ('' = the server's default) */
  aiModel: string;
  aiCompletionModel: string;
  /** the dark theme's text and formulas: white, or a sepia / grey tone like Apple Books' reading themes (right-click the sun/moon switch) */
  darkTone: 'white' | 'sepia' | 'gray';
  /** anonymous usage statistics (usage.ts): which actions are taken and which go wrong — never content or identity */
  usageStats: boolean;
  /**
   * Build the PDF by itself after the document was saved (Overleaf's auto compile): never, while the
   * PDF pane is shown, or always (keeps a public PDF link current). Web client; a build is a
   * background job on the server either way.
   */
  autoBuild: 'off' | 'shown' | 'always';
  /** seconds to wait after the save before an automatic build starts (the save follows the last keystroke by 1.5 s) */
  autoBuildDelay: number;
  /**
   * the editor's typeface (fonts/catalog.ts EDITOR_FACES), or 'document' for the face closest to the open
   * document's roman font; independent of the PDF's fonts (Document ▸ Settings ▸ Fonts)
   */
  editorFont: string;
}

export const DEFAULT_PREFS: Prefs = { spellcheck: true, spellEngine: 'overlyx', autoCorrect: true, aiButton: false, aiRewrite: false, aiCompleteText: false, aiCompleteMath: false, aiCompleteDelay: 200, invertFigures: true, aiModel: '', aiCompletionModel: '', darkTone: 'white', usageStats: true, autoBuild: 'shown', autoBuildDelay: 1, editorFont: 'cm' };
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

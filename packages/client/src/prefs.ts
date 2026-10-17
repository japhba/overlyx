/**
 * Per-browser editor preferences (Tools ▸ Preferences…; the toggles also sit in the Tools menu
 * and are therefore searchable from the command palette). Stored in localStorage `ol.prefs`.
 *
 * The AI features are off by default: they send the document to a model through the server,
 * which is something a user should switch on knowingly (the server also has to be configured
 * with a key — Tools ▸ AI says so when it is not).
 */
import type { TextStyles } from '@overlyx/core';

export interface Prefs {
  /** spell checking on the text (red underlines) */
  spellcheck: boolean;
  /** OverLyX's own checker (Hunspell in a worker, LaTeX-aware, suggestions in the menu) or the browser's */
  spellEngine: 'overlyx' | 'browser';
  /** minor typos are corrected as you finish a word (dictionary-based, never in math; Backspace reverts) */
  autoCorrect: boolean;
  /** the ✦ button on the toolbar (switches autocomplete on and off); hidden until it is enabled here */
  aiButton: boolean;
  /** ⌘J / Ctrl+J: rewrite the selection with an instruction */
  aiRewrite: boolean;
  /** ghost-text continuation after a pause while typing text */
  aiCompleteText: boolean;
  /** the same inside formulas */
  aiCompleteMath: boolean;
  /** pause before a completion is requested (ms) */
  aiCompleteDelay: number;
  /**
   * Smart invert, the dark theme's pages (app/darkpages.ts): the content of every page — documents,
   * PDFs, slides, posters, layout pages — shown light on dark, colours keeping their hue; off, every
   * page keeps its own colours (white paper in the dark interface). The theme switch's menu.
   */
  darkPages: boolean;
  /** with darkPages, figures too: plots and diagrams on a white base turn light on dark with the page, photographs keep their colours (editor/figureinvert.ts) */
  invertFigures: boolean;
  /** OpenRouter model ids for ⌘J (rewrite) and for autocomplete ('' = the server's default) */
  aiModel: string;
  aiCompletionModel: string;
  /** the dark theme's text and formulas: white, or a sepia / grey tone like Apple Books' reading themes (right-click the sun/moon switch) */
  darkTone: 'white' | 'sepia' | 'gray';
  /** anonymous usage statistics (usage.ts): which actions are taken and which go wrong — never content or identity */
  usageStats: boolean;
  /** opt-in content-free beta reliability diagnostics; also requires usageStats and no GPC */
  betaDiagnostics: boolean;
  /**
   * Build the PDF by itself after the document was saved (Overleaf's auto compile): never, while the
   * PDF pane is shown, or always (keeps a public PDF link current). Web client; a build is a
   * background job on the server either way.
   */
  autoBuild: 'off' | 'shown' | 'always';
  /** seconds to wait after the save before an automatic build starts (the save follows the last keystroke by 1.5 s) */
  autoBuildDelay: number;
  /**
   * the editor's text face (fonts/catalog.ts EDITOR_FACES; `gf:Family|axes|features`: a Google font),
   * or 'document' (the default) for the face closest to the open document's roman font. Anything else
   * is the person's own: Text styles ▸ Normal text in "My editor" (app/TextStyles.tsx), never the PDF's
   */
  editorFont: string;
  /** editorFont was set by the person (not the old default 'cm', see load) */
  editorFontChosen?: boolean;
  /**
   * Text styles for this editor only (core textstyles.ts: the "my editor" layer over the document's
   * and its LaTeX's): every document is drawn with them, the PDF never (app/TextStyles.tsx)
   */
  screenStyles: TextStyles;
  /** the editor's math font (fonts/catalog.ts MATH_FONTS), or 'match' for the one drawn for the text face */
  editorMathFont: string;
  /** a tip with the shortcut after an action was taken with the mouse a few times (shortcuttips.ts) */
  shortcutTips: boolean;
  /** the quick menu over selected words in a document (app/SelectionBar.tsx): font, size, bold / italic / underline, colour, link, comment */
  selectionBar: boolean;
  /**
   * OverLyX's math keyboard (editor/mathkbd) instead of the system keyboard while a formula has the
   * cursor: on touch screens until a hardware keyboard is used ('auto'), always, or never
   */
  mathKeyboard: 'auto' | 'on' | 'off';
  /** the math keyboard's pen: handwriting is read by an AI model (a picture of it goes through the server) */
  aiInk: boolean;
  /** autoCorrect was set by the person (not the old default, see load) */
  autoCorrectChosen?: boolean;
}

export const DEFAULT_PREFS: Prefs = { spellcheck: true, spellEngine: 'overlyx', autoCorrect: false, aiButton: false, aiRewrite: false, aiCompleteText: false, aiCompleteMath: false, aiCompleteDelay: 200, darkPages: true, invertFigures: true, aiModel: '', aiCompletionModel: '', darkTone: 'white', usageStats: true, betaDiagnostics: false, autoBuild: 'shown', autoBuildDelay: 1, editorFont: 'document', editorMathFont: 'match', screenStyles: {}, shortcutTips: true, selectionBar: true, mathKeyboard: 'auto', aiInk: false };
/** delays that were the default in earlier builds: a stored one of these follows the current default */
const OLD_DEFAULT_DELAYS = new Set([600, 450]);
const STORAGE = 'ol.prefs';

function load(): Prefs {
  try {
    const v = JSON.parse(localStorage.getItem(STORAGE) ?? '{}');
    if (v && typeof v === 'object' && OLD_DEFAULT_DELAYS.has(v.aiCompleteDelay)) delete v.aiCompleteDelay;
    // 11 Oct 2026: autocorrect became opt-in — against the US dictionary it "fixed" British spellings
    // and scientific words as they were typed (normalised → normalized, invariance → invariable). A
    // stored `true` from the old default is dropped once; switching it on now marks the choice.
    if (v && typeof v === 'object' && !v.autoCorrectChosen) delete v.autoCorrect;
    // 11 Oct 2026: one smart-invert switch for every page — the PDF's dark pages (`darkPdf`, on by
    // default) and the slides' (`invertSlides`, off by default) became `darkPages`; a PDF switched
    // to its own colours keeps the pages in their own colours everywhere
    if (v && typeof v === 'object' && ('darkPdf' in v || 'invertSlides' in v)) {
      if (!('darkPages' in v)) v.darkPages = v.darkPdf !== false;
      delete v.darkPdf; delete v.invertSlides;
    }
    // 17 Oct 2026: the editor draws the document's own font unless the person chose another (Text
    // styles' "My editor" layer): Computer Modern, the old default, stored but never chosen, goes
    if (v && typeof v === 'object' && v.editorFont === 'cm' && !v.editorFontChosen) delete v.editorFont;
    if (v && typeof v === 'object' && (!v.screenStyles || typeof v.screenStyles !== 'object' || Array.isArray(v.screenStyles))) delete v.screenStyles;
    return v && typeof v === 'object' ? { ...DEFAULT_PREFS, ...v } : { ...DEFAULT_PREFS };
  } catch { return { ...DEFAULT_PREFS }; }
}

let prefs: Prefs = load();
const listeners = new Set<(p: Prefs) => void>();

export function getPrefs(): Prefs { return prefs; }
export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
  if (prefs[key] === value) return;
  prefs = { ...prefs, [key]: value, ...(key === 'autoCorrect' ? { autoCorrectChosen: true } : {}), ...(key === 'editorFont' ? { editorFontChosen: true } : {}) };
  try { localStorage.setItem(STORAGE, JSON.stringify(prefs)); } catch { /* ignore */ }
  for (const l of listeners) { try { l(prefs); } catch { /* ignore */ } }
}
export function subscribePrefs(l: (p: Prefs) => void): () => void { listeners.add(l); return () => { listeners.delete(l); }; }

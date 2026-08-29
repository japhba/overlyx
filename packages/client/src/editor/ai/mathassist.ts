/**
 * Autocomplete inside formulas (Tools ▸ AI ▸ Autocomplete math): after a pause in typing at the
 * end of a cell the server proposes a continuation of the formula; the field shows it as faint
 * rendered math right after the caret (`LyxMathField.setGhost`), Tab inserts it.
 */
import { api } from '../../api';
import { getPrefs } from '../../prefs';
import { editorContext } from '../context';
import { mathCursorListeners, mathFocusListeners, type LyxMathField } from '../lyxmath/field';

const CURSOR = '⟦CURSOR⟧';
let installed = false;

/** The formula's LaTeX with the cursor marked (the current cell's content is located in the whole). */
export function formulaWithCursor(full: string, before: string, after: string): string {
  const cell = before + after;
  const i = cell ? full.indexOf(cell) : -1;
  if (i >= 0) return full.slice(0, i) + before + CURSOR + after + full.slice(i + cell.length);
  return `${full}\n(the cursor is inside this formula, right after: ${before}${CURSOR}${after})`;
}

export function installMathAssist(): void {
  if (installed) return;
  installed = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let ctrl: AbortController | null = null;
  const cache = new Map<string, string>();
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } if (ctrl) { ctrl.abort(); ctrl = null; } };

  const request = async (f: LyxMathField) => {
    timer = null;
    if (!f.hasFocus() || !getPrefs().aiCompleteMath || !editorContext.ai?.available) return;
    if (f.cursor.selection || f.cursor.inMacroMode() || !f.atCellEnd()) return;
    const { before, after } = f.cellLatexAround();
    if (!before.trim()) return;
    const full = f.latex;
    const formula = formulaWithCursor(full, before, after);
    const path = f.cursorPath();
    const docId = (f.dom.closest('.lyx-editor') as HTMLElement | null)?.dataset.docId ?? editorContext.docId ?? '';
    const paragraph = (f.dom.closest('.lyx-par')?.textContent ?? '').slice(0, 2000);
    const key = docId + '|' + formula;
    const hit = cache.get(key);
    if (hit !== undefined) { if (hit) f.setGhost(hit); return; }
    ctrl?.abort();
    const ac = ctrl = new AbortController();
    editorContext.aiBusy?.(true);
    try {
      const r = await api.aiComplete(docId, { kind: 'math', before, after, formula, paragraph }, ac.signal);
      if (ac.signal.aborted) return;
      if (cache.size > 60) cache.clear();
      cache.set(key, r.text);
      if (r.text && f.hasFocus() && f.latex === full && f.cursorPath() === path) f.setGhost(r.text);
    } catch (e) {
      if ((e as Error).name === 'AbortError' || ac.signal.aborted) return;
      const status = (e as { status?: number }).status;
      if (status === 429 || status === 503) editorContext.notify?.((e as Error).message, 'error');
    } finally { if (ctrl === ac) ctrl = null; editorContext.aiBusy?.(false); }
  };

  mathCursorListeners.add((f) => {
    cancel();
    if (f.ghostText) return;   // the suggestion is still on show (its beginning is being typed)
    if (!getPrefs().aiCompleteMath || !editorContext.ai?.available) return;
    if (!f.hasFocus() || f.cursor.selection || f.cursor.inMacroMode() || !f.atCellEnd()) return;
    timer = setTimeout(() => { void request(f); }, Math.max(150, getPrefs().aiCompleteDelay));
  });
  mathFocusListeners.add((f) => { if (!f) cancel(); });
}

/**
 * Presentation mode: the document alone. The menu bar, every toolbar (the docked contextual ones
 * too), the status bar, rulers, side panels and the VS Code top bar are hidden — styles.css
 * `html[data-presenting]` — while the page keeps its layout and stays editable. View ▸ Presentation
 * mode toggles it (Shift+F11, rebindable in the palette), Escape leaves it, and a hint in the corner
 * says so for a moment. One module for both shells: editorViewMenu adds the entry, the shells call
 * usePresentation() once (it installs the keys).
 */
import { useEffect, useState } from 'preact/hooks';
import { canonical, effectiveShortcut, keyFromEvent } from './keybindings';

export const PRESENTATION_ID = 'View ▸ Presentation mode';
export const PRESENTATION_KEY = 'Shift+F11';

let on = false;
const listeners = new Set<() => void>();

export function isPresenting(): boolean { return on; }
export function setPresenting(value: boolean): void {
  if (on === value) return;
  on = value;
  if (value) document.documentElement.dataset.presenting = '1'; else delete document.documentElement.dataset.presenting;
  listeners.forEach(l => l());
}
export function togglePresentation(): void { setPresenting(!on); }

/** things whose own Escape comes first: a formula field, a dialog, a menu, an input */
const OWN_ESCAPE = '.lm-input, [role=dialog], .dialog, .ctx-menu, .menubar, input, textarea, select';

/** The shell's hook: re-renders on changes; the shortcut toggles the mode, Escape leaves it. */
export function usePresentation(): boolean {
  const [, tick] = useState(0);
  useEffect(() => {
    const l = () => tick(n => n + 1);
    listeners.add(l);
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;   // a rebound command was run by the palette's listener
      const k = keyFromEvent(e);
      if (k && k === canonical(effectiveShortcut(PRESENTATION_ID, PRESENTATION_KEY))) { e.preventDefault(); e.stopImmediatePropagation(); togglePresentation(); return; }
      if (on && e.key === 'Escape' && !(e.target as HTMLElement).closest?.(OWN_ESCAPE)) setPresenting(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => { listeners.delete(l); window.removeEventListener('keydown', onKey, true); };
  }, []);
  return on;
}

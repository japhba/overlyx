/**
 * Whether a formula that takes the cursor gets OverLyX's math keyboard (keyboard.ts) instead of
 * the system keyboard: on touch screens until a hardware keyboard is used (prefs `mathKeyboard`
 * 'auto'), always ('on'), or never ('off'). The formula field (lyxmath/field.ts) asks here before
 * it focuses — inputmode="none" keeps the system keyboard (iPadOS's half-screen one) away — tells
 * here when it gains and loses the cursor, and reports keys that came from a hardware keyboard:
 * with 'auto' the panel then folds into a small button for the rest of the session.
 *
 * This module is small and loaded with every formula; the keyboard itself is loaded the first time
 * it is wanted.
 */
import { getPrefs } from '../../prefs';
import type { LyxMathField } from '../lyxmath/field';

/** a key of a hardware keyboard was typed into a formula (this session) */
let hardware = false;
/** the system keyboard was asked for with the panel's ⌨ key: the field takes it until the panel is wanted again */
let system = false;

/** a touch screen is the main input (iPads report a desktop user agent, but touch points) */
export function touchFirst(): boolean {
  try {
    if (matchMedia('(pointer: coarse)').matches) return true;
    return navigator.maxTouchPoints > 1 && /Macintosh|iPad/.test(navigator.userAgent) && !matchMedia('(any-pointer: fine)').matches;
  } catch { return false; }
}

/** the keyboard panel is wanted for formulas now */
export function mathKeyboardWanted(): boolean {
  const mode = getPrefs().mathKeyboard ?? 'auto';
  if (mode === 'off') return false;
  if (mode === 'on') return true;
  return touchFirst() && !hardware;
}

/** what the field's hidden input should ask the browser for: 'none' keeps the system keyboard away */
export function inputModeFor(): 'none' | 'text' {
  return !system && mathKeyboardEnabled() ? 'none' : 'text';
}

/** the panel may show at all (it may be folded into its button: hardware keys seen) */
export function mathKeyboardEnabled(): boolean {
  const mode = getPrefs().mathKeyboard ?? 'auto';
  return mode === 'on' || (mode === 'auto' && touchFirst());
}

export function setSystemKeyboard(on: boolean): void { system = on; }
export function systemKeyboard(): boolean { return system; }
export function hardwareKeyboardSeen(): boolean { return hardware; }

type Ui = { focus(field: LyxMathField | null): void; hardware(): void };
let ui: Ui | null = null;
let loading: Promise<void> | null = null;
let pending: LyxMathField | null = null;

/** a formula took the cursor (or `null`: lost it) */
export function mathKbdFocus(field: LyxMathField | null): void {
  if (ui) { ui.focus(field); return; }
  pending = field;
  if (!field || !mathKeyboardEnabled() || loading) return;
  loading = import('./keyboard').then(m => { ui = m.mathKeyboardUi(); ui.focus(pending); }).catch(e => { loading = null; console.warn('math keyboard', e); });
}

/** a key from a hardware keyboard reached a formula whose input asked for no system keyboard */
export function noteHardwareKey(ev: KeyboardEvent): void {
  if (!ev.isTrusted || ev.key === 'Unidentified' || ev.key === 'Process' || ev.isComposing) return;
  if (system || (getPrefs().mathKeyboard ?? 'auto') !== 'auto' || hardware) return;
  hardware = true;
  ui?.hardware();
}

/** tests: forget the session's observations */
export function resetMathKeyboardSession(): void { hardware = false; system = false; }

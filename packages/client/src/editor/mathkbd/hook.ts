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
import { recordReliability } from '../../usage';
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

/** A slow or failed optional panel must leave the focused formula writable. */
function useFallbackKeyboard(): boolean {
  const field = pending;
  if (!ui && field?.hasFocus() && field.dom.isConnected && !systemKeyboard()) { field.useSystemKeyboard(true); return true; }
  return false;
}

/** Forget only this field's ownership; a newly focused formula keeps its panel. */
export function mathKbdDestroyed(field: LyxMathField): void {
  if (pending !== field) return;
  if (loading) recordReliability('keyboard.owner-disposed', { context: 'math' });
  pending = null;
  ui?.focus(null);
}

/** a formula took the cursor (or `null`: lost it) */
export function mathKbdFocus(field: LyxMathField | null): void {
  pending = field;
  if (ui) { ui.focus(field); return; }
  if (!field || !mathKeyboardEnabled() || loading) return;
  // Leave the import running after the grace period. When it arrives, the panel
  // offers its usual button while the writer can continue with the system keys.
  const startedAt = Date.now();
  let timedOut = false;
  recordReliability('keyboard.load-start', { context: 'math' });
  const timer = setTimeout(() => {
    timedOut = true;
    if (useFallbackKeyboard()) recordReliability('keyboard.fallback-timeout', { context: 'math', durationMs: Date.now() - startedAt });
  }, 3000);
  loading = import('./keyboard').then(m => {
    clearTimeout(timer);
    ui = m.mathKeyboardUi();
    ui.focus(pending?.dom.isConnected ? pending : null);
    recordReliability(timedOut ? 'keyboard.late-ready' : 'keyboard.ready', { context: 'math', durationMs: Date.now() - startedAt });
  }).catch(e => {
    clearTimeout(timer);
    // Keep the in-flight guard while refocusing: useSystemKeyboard calls this
    // hook again synchronously. Do not steal focus from a popup or stale field.
    try {
      useFallbackKeyboard();
      recordReliability('keyboard.fallback-error', { context: 'math', durationMs: Date.now() - startedAt });
    } finally { loading = null; }
    console.warn('math keyboard', e);
  });
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

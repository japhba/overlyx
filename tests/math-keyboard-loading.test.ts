// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LyxMathField } from '../packages/client/src/editor/lyxmath/field';

type KeyboardUi = { focus(field: LyxMathField | null): void; hardware(): void };
type KeyboardModule = { mathKeyboardUi(): KeyboardUi };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

let loading: ReturnType<typeof deferred<KeyboardModule>>;
let started: ReturnType<typeof deferred<void>>;
let importCalls: ReturnType<typeof vi.fn>;
let hook: typeof import('../packages/client/src/editor/mathkbd/hook');
let fields: typeof import('../packages/client/src/editor/lyxmath/field');
let opened: LyxMathField[];
let keyboard: { focus: ReturnType<typeof vi.fn>; hardware: ReturnType<typeof vi.fn> };
let diagnostics: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetModules();
  loading = deferred<KeyboardModule>(); started = deferred<void>();
  importCalls = vi.fn(); opened = [];
  keyboard = { focus: vi.fn(), hardware: vi.fn() };
  diagnostics = vi.fn();
  vi.doMock('../packages/client/src/prefs', () => ({ getPrefs: () => ({ mathKeyboard: 'on' }) }));
  vi.doMock('../packages/client/src/usage', () => ({ recordReliability: diagnostics }));
  // Rendering is unrelated to keyboard ownership; use the real field and its
  // focus, blur, popup hold, inputmode, and text-editing events.
  vi.doMock('../packages/client/src/editor/lyxmath/mathjax', () => ({
    onMathRendererChange: () => () => {},
    renderMath: () => ({ node: document.createElement('span'), error: null, retry: null, undefinedCommands: [] }),
  }));
  vi.doMock('../packages/client/src/editor/mathkbd/keyboard', async () => {
    importCalls(); started.resolve();
    return loading.promise;
  });
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  hook = await import('../packages/client/src/editor/mathkbd/hook');
  fields = await import('../packages/client/src/editor/lyxmath/field');
});

afterEach(async () => {
  vi.useRealTimers();
  loading.resolve({ mathKeyboardUi: () => keyboard });
  await vi.dynamicImportSettled();
  for (const field of opened) field.destroy();
  document.body.replaceChildren();
  getSelection()?.removeAllRanges();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  vi.doUnmock('../packages/client/src/prefs');
  vi.doUnmock('../packages/client/src/usage');
  vi.doUnmock('../packages/client/src/editor/lyxmath/mathjax');
  vi.doUnmock('../packages/client/src/editor/mathkbd/keyboard');
});

function formula() {
  const onFocus = vi.fn(), onBlur = vi.fn();
  const field = new fields.LyxMathField({ latex: '$x$', display: false, macros: {}, onFocus, onBlur });
  opened.push(field); document.body.append(field.dom);
  const input = field.dom.querySelector<HTMLElement>('[role="textbox"]')!;
  const fallback = vi.spyOn(field, 'useSystemKeyboard');
  return { field, input, fallback, onFocus, onBlur };
}

function elsewhere() {
  const input = document.createElement('input'); document.body.append(input); input.focus();
  return input;
}

async function failImport() {
  loading.reject(new Error('old keyboard chunk is unavailable'));
  await vi.dynamicImportSettled();
}

it('a failed import gives the focused formula a working system input and refocuses only once', async () => {
  const { field, input, fallback, onFocus, onBlur } = formula();
  field.focus(); await started.promise;
  expect(input.inputMode).toBe('none');
  await failImport();
  expect(diagnostics).toHaveBeenCalledWith('keyboard.load-start', { context: 'math' });
  expect(diagnostics).toHaveBeenCalledWith('keyboard.fallback-error', { context: 'math', durationMs: expect.any(Number) });
  expect(JSON.stringify(diagnostics.mock.calls)).not.toMatch(/\$x|old keyboard chunk|unavailable/);
  expect(document.activeElement).toBe(input);
  expect(fields.activeMathField()).toBe(field);
  expect(input.inputMode).toBe('text');
  expect(fallback).toHaveBeenCalledExactlyOnceWith(true);
  expect(onFocus).toHaveBeenCalledTimes(2);
  expect(onBlur).not.toHaveBeenCalled();
  expect(importCalls).toHaveBeenCalledTimes(1);
  input.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: '2', bubbles: true, cancelable: true }));
  expect(field.latex).toBe('$x2$');
  // Drain another turn: a reentrant failed import must not refocus in a loop.
  await vi.dynamicImportSettled();
  expect(fallback).toHaveBeenCalledTimes(1);
  expect(onFocus).toHaveBeenCalledTimes(2);
  expect(importCalls).toHaveBeenCalledTimes(1);
});

it('a rejected import does not reclaim a formula after ordinary blur', async () => {
  const { field, fallback, onFocus } = formula();
  field.focus(); await started.promise;
  const other = elsewhere();
  expect(field.hasFocus()).toBe(false);
  await failImport();
  expect(document.activeElement).toBe(other);
  expect(fallback).not.toHaveBeenCalled();
  expect(onFocus).toHaveBeenCalledTimes(1);
  expect(hook.systemKeyboard()).toBe(false);
});

it('a rejected import never refocuses a destroyed formula', async () => {
  const { field, fallback, onFocus } = formula();
  field.focus(); await started.promise;
  field.destroy();
  const active = document.activeElement;
  expect(field.dom.isConnected).toBe(false);
  await failImport();
  expect(document.activeElement).toBe(active);
  expect(fallback).not.toHaveBeenCalled();
  expect(onFocus).toHaveBeenCalledTimes(1);
});

it('a popup that holds the formula cursor keeps keyboard focus after import failure', async () => {
  const { field, fallback, onFocus, onBlur } = formula();
  field.focus(); await started.promise;
  field.hold();
  const popup = elsewhere();
  expect(field.hasFocus()).toBe(false);
  expect(onBlur).not.toHaveBeenCalled();
  await failImport();
  expect(document.activeElement).toBe(popup);
  expect(fallback).not.toHaveBeenCalled();
  expect(onFocus).toHaveBeenCalledTimes(1);
  field.endHold(false);
  expect(onBlur).toHaveBeenCalledTimes(1);
});

it('only the latest focused formula receives fallback while a shared import is pending', async () => {
  const first = formula(), latest = formula();
  first.field.focus(); await started.promise;
  latest.field.focus();
  await failImport();
  expect(first.fallback).not.toHaveBeenCalled();
  expect(first.onFocus).toHaveBeenCalledTimes(1);
  expect(latest.fallback).toHaveBeenCalledExactlyOnceWith(true);
  expect(latest.onFocus).toHaveBeenCalledTimes(2);
  expect(document.activeElement).toBe(latest.input);
  expect(latest.input.inputMode).toBe('text');
  expect(importCalls).toHaveBeenCalledTimes(1);
});

it('a successful import gives the normal keyboard the latest field and later focus changes', async () => {
  const first = formula(), latest = formula();
  first.field.focus(); await started.promise;
  latest.field.focus();
  loading.resolve({ mathKeyboardUi: () => keyboard });
  await vi.dynamicImportSettled();
  expect(keyboard.focus).toHaveBeenCalledExactlyOnceWith(latest.field);
  expect(first.fallback).not.toHaveBeenCalled();
  expect(latest.fallback).not.toHaveBeenCalled();
  expect(latest.input.inputMode).toBe('none');
  expect(hook.systemKeyboard()).toBe(false);
  first.field.focus();
  expect(keyboard.focus).toHaveBeenLastCalledWith(first.field);
  first.field.blur();
  expect(keyboard.focus).toHaveBeenLastCalledWith(null);
  expect(importCalls).toHaveBeenCalledTimes(1);
});

it('a successful late import never gives the keyboard a destroyed formula', async () => {
  const { field, input, fallback } = formula();
  field.focus(); await started.promise;
  field.destroy();
  loading.resolve({ mathKeyboardUi: () => keyboard });
  await vi.dynamicImportSettled();
  expect(keyboard.focus).toHaveBeenCalledExactlyOnceWith(null);
  expect(fields.activeMathField()).toBeNull();
  expect(field.hasFocus()).toBe(false);
  expect(document.activeElement).not.toBe(input);
  expect(fallback).not.toHaveBeenCalled();
});

it('destroying the active formula clears an already loaded keyboard owner', async () => {
  const { field, input } = formula();
  field.focus(); await started.promise;
  loading.resolve({ mathKeyboardUi: () => keyboard });
  await vi.dynamicImportSettled();
  expect(keyboard.focus).toHaveBeenCalledExactlyOnceWith(field);
  keyboard.focus.mockClear();
  field.destroy();
  expect(fields.activeMathField()).toBeNull();
  expect(field.hasFocus()).toBe(false);
  expect(keyboard.focus).toHaveBeenCalledExactlyOnceWith(null);
  expect(document.activeElement).not.toBe(input);
});

for (const alreadyLoaded of [false, true]) {
  it(`destroying an old formula preserves the new keyboard owner (loaded=${alreadyLoaded})`, async () => {
    const old = formula(), current = formula();
    old.field.focus(); await started.promise;
    current.field.focus();
    if (alreadyLoaded) {
      loading.resolve({ mathKeyboardUi: () => keyboard });
      await vi.dynamicImportSettled();
      expect(keyboard.focus).toHaveBeenCalledExactlyOnceWith(current.field);
      keyboard.focus.mockClear();
    }
    old.field.destroy();
    expect(fields.activeMathField()).toBe(current.field);
    expect(document.activeElement).toBe(current.input);
    expect(current.field.hasFocus()).toBe(true);
    expect(keyboard.focus).not.toHaveBeenCalled();
    if (!alreadyLoaded) {
      loading.resolve({ mathKeyboardUi: () => keyboard });
      await vi.dynamicImportSettled();
      expect(keyboard.focus).toHaveBeenCalledExactlyOnceWith(current.field);
    }
    expect(fields.activeMathField()).toBe(current.field);
    expect(document.activeElement).toBe(current.input);
    expect(current.input.inputMode).toBe('none');
    expect(current.fallback).not.toHaveBeenCalled();
  });
}

it('a stalled keyboard import gives the active formula system input after three seconds only once', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const { field, input, fallback, onFocus } = formula();
  field.focus(); await started.promise;
  await vi.advanceTimersByTimeAsync(2999);
  expect(input.inputMode).toBe('none');
  expect(fallback).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(diagnostics).toHaveBeenCalledWith('keyboard.fallback-timeout', { context: 'math', durationMs: expect.any(Number) });
  expect(document.activeElement).toBe(input);
  expect(input.inputMode).toBe('text');
  expect(hook.systemKeyboard()).toBe(true);
  expect(fallback).toHaveBeenCalledExactlyOnceWith(true);
  expect(onFocus).toHaveBeenCalledTimes(2);
  expect(importCalls).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(30000);
  expect(fallback).toHaveBeenCalledTimes(1);
  expect(onFocus).toHaveBeenCalledTimes(2);
  expect(importCalls).toHaveBeenCalledTimes(1);
  input.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: '3', bubbles: true, cancelable: true }));
  expect(field.latex).toBe('$x3$');
});

for (const succeeds of [false, true]) {
  it(`a late keyboard ${succeeds ? 'success' : 'failure'} preserves system input after the stalled-load fallback`, async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { field, input, fallback, onFocus } = formula();
    field.focus(); await started.promise;
    await vi.advanceTimersByTimeAsync(3000);
    expect(input.inputMode).toBe('text');
    expect(fallback).toHaveBeenCalledExactlyOnceWith(true);
    if (succeeds) loading.resolve({ mathKeyboardUi: () => keyboard });
    else loading.reject(new Error('keyboard load eventually failed'));
    vi.useRealTimers();
    await vi.dynamicImportSettled();
    expect(diagnostics).toHaveBeenCalledWith(succeeds ? 'keyboard.late-ready' : 'keyboard.fallback-error', { context: 'math', durationMs: expect.any(Number) });
    expect(document.activeElement).toBe(input);
    expect(fields.activeMathField()).toBe(field);
    expect(input.inputMode).toBe('text');
    expect(hook.systemKeyboard()).toBe(true);
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(onFocus).toHaveBeenCalledTimes(2);
    expect(importCalls).toHaveBeenCalledTimes(1);
    if (succeeds) expect(keyboard.focus).toHaveBeenCalledExactlyOnceWith(field);
    else expect(keyboard.focus).not.toHaveBeenCalled();
  });
}

for (const leave of ['blur', 'destroy', 'popup'] as const) {
  it(`a stalled keyboard import does not reclaim focus after ${leave}`, async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { field, fallback, onFocus } = formula();
    field.focus(); await started.promise;
    if (leave === 'popup') field.hold();
    if (leave === 'destroy') field.destroy();
    const other = elsewhere();
    await vi.advanceTimersByTimeAsync(3000);
    expect(document.activeElement).toBe(other);
    expect(fields.activeMathField()).toBeNull();
    expect(fallback).not.toHaveBeenCalled();
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(hook.systemKeyboard()).toBe(false);
    await vi.advanceTimersByTimeAsync(30000);
    expect(document.activeElement).toBe(other);
    expect(fallback).not.toHaveBeenCalled();
  });
}

it('a stalled import follows the latest owner without reviving the destroyed previous field', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const old = formula(), current = formula();
  old.field.focus(); await started.promise;
  await vi.advanceTimersByTimeAsync(2000);
  current.field.focus(); old.field.destroy();
  await vi.advanceTimersByTimeAsync(1000);
  expect(old.fallback).not.toHaveBeenCalled();
  expect(current.fallback).toHaveBeenCalledExactlyOnceWith(true);
  expect(document.activeElement).toBe(current.input);
  expect(fields.activeMathField()).toBe(current.field);
  expect(current.input.inputMode).toBe('text');
  expect(current.onFocus).toHaveBeenCalledTimes(2);
  expect(importCalls).toHaveBeenCalledTimes(1);
  const other = elsewhere();
  await vi.advanceTimersByTimeAsync(30000);
  expect(document.activeElement).toBe(other);
  expect(current.fallback).toHaveBeenCalledTimes(1);
  expect(old.fallback).not.toHaveBeenCalled();
});

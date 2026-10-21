// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const report = vi.hoisted(() => vi.fn());
vi.mock('../packages/client/src/api', () => ({ API_BASE: '', api: { clientGlitch: report } }));
vi.mock('../packages/client/src/usage', () => ({ viewKind: () => 'editor', interactionTarget: () => 'ui' }));

let viewport: EventTarget & { height: number; scale: number; offsetTop: number };
const removeListeners: (() => void)[] = [];

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
  report.mockReset().mockResolvedValue({ id: null });
  document.body.innerHTML = '<div class="app"><input></div>';
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(1000);
  viewport = Object.assign(new EventTarget(), { height: 960, scale: 0.8, offsetTop: 40 });
  vi.stubGlobal('visualViewport', viewport);
  vi.stubGlobal('navigator', { maxTouchPoints: 1 });
  vi.stubGlobal('scrollY', 40);
  vi.stubGlobal('scrollX', 30);
  vi.stubGlobal('scrollTo', vi.fn());
  const addWindow = window.addEventListener.bind(window), addDocument = document.addEventListener.bind(document);
  vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
    addWindow(type, listener, options);
    removeListeners.push(() => window.removeEventListener(type, listener, options));
  });
  vi.spyOn(document, 'addEventListener').mockImplementation((type, listener, options) => {
    addDocument(type, listener, options);
    removeListeners.push(() => document.removeEventListener(type, listener, options));
  });
  const { initGlitchWatch } = await import('../packages/client/src/glitches');
  initGlitchWatch();
});

afterEach(() => {
  for (const remove of removeListeners.splice(0)) remove();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

async function settle() {
  window.dispatchEvent(new Event('scroll'));
  await vi.advanceTimersByTimeAsync(850);
}

it('restores a settled shift at reduced page scale when no field needs the small viewport gap', async () => {
  window.dispatchEvent(new Event('scroll'));
  await vi.advanceTimersByTimeAsync(799);
  expect(scrollTo).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(51);
  expect(scrollTo).toHaveBeenCalledWith(0, 0);
  expect(report).toHaveBeenCalledWith(expect.objectContaining({
    kind: 'shift', fields: expect.objectContaining({ keyboard: 'bar', focus: 'none', restored: 'yes' }),
  }));
});

it('does not invent a keyboard at reduced scale when both CSS heights match', async () => {
  viewport.height = 1000;
  await settle();
  expect(scrollTo).toHaveBeenCalledWith(0, 0);
  expect(report).toHaveBeenCalledWith(expect.objectContaining({ fields: expect.objectContaining({ keyboard: 'down' }) }));
});

it('leaves a focused field with its shortcut bar, then recovers after focus is gone', async () => {
  const input = document.querySelector('input')!;
  input.focus();
  await settle();
  expect(scrollTo).not.toHaveBeenCalled();
  input.blur();
  await vi.advanceTimersByTimeAsync(850);
  expect(scrollTo).toHaveBeenCalledWith(0, 0);
});

it('leaves a focused frame with its shortcut bar', async () => {
  const frame = document.createElement('iframe');
  document.querySelector('.app')!.append(frame);
  frame.focus();
  await settle();
  expect(scrollTo).not.toHaveBeenCalled();
});

it('leaves the window in place while a full keyboard reduces the viewport', async () => {
  viewport.height = 600;
  await settle();
  expect(scrollTo).not.toHaveBeenCalled();
  expect(report).toHaveBeenCalledWith(expect.objectContaining({ fields: expect.objectContaining({ keyboard: 'up', restored: 'no' }) }));
});

it('preserves panning on a zoomed-in page', async () => {
  viewport.scale = 1.5;
  viewport.height = 650;
  await settle();
  expect(scrollTo).not.toHaveBeenCalled();
});

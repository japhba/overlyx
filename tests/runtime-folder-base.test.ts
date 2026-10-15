// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => { vi.resetModules(); document.head.innerHTML = ''; document.body.innerHTML = ''; delete window.__OL; });
afterEach(() => { document.head.innerHTML = ''; document.body.innerHTML = ''; delete window.__OL; });

it('renews a relative authored base using canonical source and never inserts a competing base', async () => {
  const { state, setFolderBase } = await import('../packages/client/src/deliverable/runtime/env');
  const raw = '<html><head><base href="../figures/"></head><body><p>Keep source</p></body></html>';
  state.src = new DOMParser().parseFromString(raw, 'text/html');
  document.head.innerHTML = '<base href="https://example.invalid/old/figures/"><base data-ol-runtime href="https://example.invalid/old/slides/">';
  setFolderBase('https://example.invalid/new/slides/');
  expect(document.querySelectorAll('base')).toHaveLength(1);
  expect(document.querySelector('base')!.href).toBe('https://example.invalid/new/figures/');
  expect(state.src.querySelector('base')!.getAttribute('href')).toBe('../figures/');
  setFolderBase('https://example.invalid/next/slides/');
  expect(document.querySelector('base')!.href).toBe('https://example.invalid/next/figures/');
});

it('preserves an absolute authored base and creates a runtime fallback only after the source removes it', async () => {
  const { state, setFolderBase } = await import('../packages/client/src/deliverable/runtime/env');
  state.src = new DOMParser().parseFromString('<base href="https://images.invalid/assets/">', 'text/html');
  document.head.innerHTML = '<base href="https://images.invalid/assets/">';
  setFolderBase('https://example.invalid/new/slides/');
  expect(document.querySelector('base')!.href).toBe('https://images.invalid/assets/');
  state.src = new DOMParser().parseFromString('<p>No authored base</p>', 'text/html');
  document.querySelector('base')!.remove();
  setFolderBase('https://example.invalid/new/slides/');
  expect(document.querySelectorAll('base')).toHaveLength(1);
  expect(document.querySelector('base')!.hasAttribute('data-ol-runtime')).toBe(true);
  expect(document.querySelector('base')!.href).toBe('https://example.invalid/new/slides/');
});

// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applySource, guard } from '../packages/client/src/deliverable/runtime/reconcile.ts';
import { state, srcOf, pathOf } from '../packages/client/src/deliverable/runtime/env.ts';
const wrap = (body: string) => `<html><head></head><body><section class="slide">${body}</section></body></html>`;
function open(body: string) {
  state.src = null; state.version = null; guard.editing = null;
  const html = wrap(body);
  document.documentElement.innerHTML = new DOMParser().parseFromString(html, 'text/html').documentElement.innerHTML;
  applySource(html, 1);
  const box = document.querySelector('p')!;
  guard.editing = box; box.innerHTML += ' LOCAL-DRAFT';
  return box;
}
afterEach(() => { delete window.__OL; });
beforeEach(() => { (window as any).happyDOM.settings.disableJavaScriptFileLoading = true; });
describe('active text target identity', () => {
  it('renders a newer cached first version while preserving script-generated unsourced content', () => {
    state.src = null; guard.editing = null;
    const served = wrap('<p>Server baseline.</p><div id="chart"></div>');
    window.__OL = { source: served };
    document.documentElement.innerHTML = new DOMParser().parseFromString(served, 'text/html').documentElement.innerHTML;
    document.getElementById('chart')!.innerHTML = '<svg data-drawn="1"></svg>';
    applySource(served.replace('Server baseline.', 'Server baseline. OFFLINE-DRAFT'), 1);
    expect(document.querySelector('p')!.textContent).toBe('Server baseline. OFFLINE-DRAFT');
    expect(document.querySelector('svg[data-drawn]')).not.toBeNull();
  });
  it('does not turn a removed active box into its edited neighbour', () => {
    const box = open('<p>First box.</p><p>Other box.</p>');
    applySource(wrap('<p>Other box. REMOTE</p>'), 2);
    expect(box.isConnected).toBe(false);
    expect(document.querySelector('p')!.textContent).toBe('Other box. REMOTE');
    expect(pathOf(box)).toBeNull();
  });
  it('keeps the exact active object when another sibling is inserted or moved', () => {
    const box = open('<p>First box.</p><p>Other box.</p>');
    applySource(wrap('<p>Other box.</p><h2>New</h2><p>First box.</p>'), 2);
    expect(box.isConnected).toBe(true);
    expect(box.textContent).toContain('LOCAL-DRAFT');
    expect(pathOf(box)).toEqual([1, 0, 2]);
  });
  it('keeps the active DOM and updates its source for same-object remote words', () => {
    const box = open('<p>First box.</p><p>Other box.</p>');
    applySource(wrap('<p>First box. REMOTE</p><p>Other box.</p>'), 2);
    expect(box.isConnected).toBe(true);
    expect(box.textContent).toBe('First box. LOCAL-DRAFT');
    expect(srcOf.get(box)!.textContent).toBe('First box. REMOTE');
  });
});

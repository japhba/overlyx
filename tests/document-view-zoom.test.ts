// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { useEffect, useRef, useState } from 'preact/hooks';
import { applyEditorZoom, useDocumentViewportZoom } from '../packages/client/src/app/shellutil.tsx';
import { viewportZoom } from '../packages/client/src/app/documentviewport.ts';
import { ZoomControl } from '../packages/client/src/app/StatusBar.tsx';
import { resetUsageForTests } from '../packages/client/src/usage.ts';

afterEach(() => { render(null, document.body); document.body.replaceChildren(); resetUsageForTests(); });

describe('document view zoom', () => {
  it('magnifies the viewport separately from text size, shows its level, and resets without changing text size', async () => {
    function Harness() {
      const [zoom, setZoom] = useState(1.2);
      const ref = useRef<HTMLDivElement>(null);
      useDocumentViewportZoom(ref, 'sample');
      useEffect(() => applyEditorZoom(zoom), [zoom]);
      return h('div', {}, h('div', { class: 'editor-scroll', ref }, h('div', { class: 'editor-page' }, h('div', { class: 'lyx-editor' }, 'Text'))), h(ZoomControl, {zoom, onZoom: setZoom}));
    }
    await act(() => render(h(Harness, {}), document.body));
    const pane = document.querySelector('.editor-scroll')!;
    const ordinary = new WheelEvent('wheel', { deltaY: 10, bubbles: true, cancelable: true });
    pane.dispatchEvent(ordinary);
    expect(ordinary.defaultPrevented).toBe(false);
    for (const target of [pane, document.body]) {
      for (const modifier of ['ctrlKey', 'metaKey']) {
        const wheel = new WheelEvent('wheel', { deltaY: -10, bubbles: true, cancelable: true });
        // happy-dom's WheelEvent omits MouseEvent modifier fields; browsers provide these.
        Object.defineProperty(wheel, modifier, { value: true });
        await act(() => target.dispatchEvent(wheel));
        expect(wheel.defaultPrevented).toBe(true);
      }
      for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
        const gesture = new Event(type, { bubbles: true, cancelable: true });
        target.dispatchEvent(gesture);
        expect(gesture.defaultPrevented).toBe(true);
      }
    }
    await act(async () => { await new Promise(requestAnimationFrame); });
    expect(viewportZoom()).toBeGreaterThan(1);
    expect(document.querySelector('[data-viewport-zoom-reset]')?.textContent).toMatch(/View 1\d\d%/);
    expect((document.querySelector('[data-zoom]') as HTMLSelectElement).value).toBe('120');
    expect(document.documentElement.style.getPropertyValue('--editor-zoom')).toBe('1.2');
    await act(() => (document.querySelector('[data-viewport-zoom-reset]') as HTMLButtonElement).click());
    expect(viewportZoom()).toBe(1);
    expect(document.querySelector<HTMLElement>('.editor-page')!.style.transform).toBe('');
    expect(document.documentElement.style.getPropertyValue('--editor-zoom')).toBe('1.2');
  });
});

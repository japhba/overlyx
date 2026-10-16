// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { useEffect, useState } from 'preact/hooks';
import { applyEditorZoom, useTextPinch } from '../packages/client/src/app/shellutil.tsx';
import { schema } from '../packages/core/src/schema.ts';
import { resetUsageForTests } from '../packages/client/src/usage.ts';

afterEach(() => { render(null, document.body); document.body.replaceChildren(); resetUsageForTests(); });

describe('document view zoom', () => {
  it('blocks browser pinch zoom without changing document zoom or the model, and still allows scrolling', async () => {
    const doc = schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, [schema.text('Text'), schema.nodes.graphics.create({ params: JSON.stringify(['filename plot.png', 'width 6cm']) })]));
    const before = doc.toJSON();
    function Harness() {
      const [zoom, setZoom] = useState(1.2);
      useTextPinch(zoom, setZoom);
      useEffect(() => applyEditorZoom(zoom), [zoom]);
      return h('div', { class: 'editor-scroll' }, h('div', { class: 'editor-page' }, h('div', { class: 'lyx-editor' }, 'Text')));
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
    expect(document.documentElement.style.getPropertyValue('--editor-zoom')).toBe('1.2');
    expect(doc.toJSON()).toEqual(before);
  });
});

import { expect, it, vi } from 'vitest';
import type { CDPSession } from 'playwright-core';
import type { DeliverableLayout } from '../packages/core/src/html/layout';
import { measureFonts } from '../packages/server/src/render-layout';

function fixture(): DeliverableLayout {
  return { units: 'css-px', pages: [{ index: 0, width: 600, height: 400, objects: [
    { selector: '#label', tag: 'p', box: { x: 10, y: 10, w: 100, h: 40 }, formulas: [],
      text: { lineCount: 2, wraps: true, overflow: { x: false, y: false }, fontFamily: 'Missing, Arial', fonts: null } },
  ] }] };
}

it('collects actual fonts per text node, merging fallback faces without counting inline spans twice', async () => {
  const font = { familyName: 'Liberation Sans', postScriptName: 'LiberationSans', isCustomFont: false, glyphCount: 4 };
  const fallback = { familyName: 'Fallback', postScriptName: 'Fallback', isCustomFont: true, glyphCount: 1 };
  const node = (nodeType: number, backendNodeId: number, nodeName = '', children: unknown[] = []) =>
    ({ nodeType, backendNodeId, nodeName, nodeValue: nodeType === 3 ? 'text' : '', children });
  const send = vi.fn(async (method: string, args: any) => {
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
    if (method === 'DOM.querySelector') return { nodeId: 2 };
    if (method === 'DOM.describeNode') return { node: node(1, 2, 'P', [node(3, 3), node(1, 4, 'B', [node(3, 5)]), node(1, 6, 'STYLE', [node(3, 7)])]) };
    if (method === 'DOM.pushNodesByBackendIdsToFrontend') return { nodeIds: args.backendNodeIds };
    if (method === 'CSS.getPlatformFontsForNode') return { fonts: args.nodeId === 3 ? [font] : [font, fallback] };
    return {};
  });
  const r = fixture();
  await measureFonts({ send } as unknown as CDPSession, r);
  expect(r.pages[0].objects[0].text?.fonts).toEqual([{ ...font, glyphCount: 8 }, fallback]);
  expect(send.mock.calls.filter(([m]) => m === 'CSS.getPlatformFontsForNode').map(([, a]) => a.nodeId)).toEqual([3, 5]);
});

it('leaves actual fonts unavailable when an authored script removes the object', async () => {
  const send = vi.fn(async (method: string) => {
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
    if (method === 'DOM.querySelector') throw new Error('Node was removed');
    return {};
  });
  const r = fixture();
  await measureFonts({ send } as unknown as CDPSession, r);
  expect(r.pages[0].objects[0].text?.fonts).toBeNull();
});

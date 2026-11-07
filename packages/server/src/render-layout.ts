/** Actual platform fonts cannot be read through CSSOM. Chromium exposes the faces used for
 * text (including per-glyph fallbacks) through DevTools instead. */
import type { CDPSession } from 'playwright-core';
import type { DeliverableLayout, RenderedFont } from '@overlyx/core/html/layout.ts';

interface FontNode { nodeName: string; nodeType: number; nodeValue: string; backendNodeId: number; children?: FontNode[] }

export async function measureFonts(cdp: CDPSession, layout: DeliverableLayout): Promise<void> {
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
  for (const page of layout.pages) for (const object of page.objects) {
    if (!object.text) continue;
    try {
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: object.selector });
      if (!nodeId) continue;
      const { node } = await cdp.send('DOM.describeNode', { nodeId, depth: -1 });
      const fonts = new Map<string, RenderedFont>();
      const visit = async (n: FontNode): Promise<void> => {
        if (/^(SCRIPT|STYLE|MJX-ASSISTIVE-MML)$/.test(n.nodeName)) return;
        if (n.nodeType === 3 && n.nodeValue.trim()) {
          // describeNode's descendants may have no frontend id until requested.
          const { nodeIds } = await cdp.send('DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: [n.backendNodeId] });
          // Query each text node itself: querying an element includes some descendants
          // and would double-count mixed inline spans when walking their parents too.
          const used = await cdp.send('CSS.getPlatformFontsForNode', { nodeId: nodeIds[0] });
          for (const font of used.fonts) {
            const key = `${font.familyName}\0${font.postScriptName}\0${font.isCustomFont}`;
            const prev = fonts.get(key);
            if (prev) prev.glyphCount += font.glyphCount; else fonts.set(key, { ...font });
          }
        }
        for (const child of n.children ?? []) await visit(child);
      };
      await visit(node);
      object.text.fonts = Array.from(fonts.values());
    } catch { /* an authored script removed the node; null means unavailable */ }
  }
}

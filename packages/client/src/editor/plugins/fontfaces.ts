/**
 * The fonts by name a document uses (the `face` mark, core fontface.ts) are loaded into the page —
 * when it opens, and when an edit (a collaborator's too) brings a family it does not have yet:
 * their @font-face rules come from this server (fonts/googlefont.ts). Looked at a moment after the
 * edits, not on every keystroke.
 */
import { Plugin } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { parseFace } from '@overlyx/core';
import { loadGoogleFont } from '../../fonts/googlefont';

function loadFaces(doc: PMNode): void {
  const seen = new Set<string>();
  doc.descendants(n => {
    for (const m of n.marks) {
      if (m.type.name !== 'face' || seen.has(m.attrs.value)) continue;
      seen.add(m.attrs.value);
      const f = parseFace(m.attrs.value);
      if (f) loadGoogleFont(f.family);
    }
  });
}

export function fontFacesPlugin(): Plugin {
  return new Plugin({
    view(view) {
      loadFaces(view.state.doc);
      let timer: ReturnType<typeof setTimeout> | undefined;
      return {
        update(v, prev) {
          if (v.state.doc === prev.doc) return;
          clearTimeout(timer);
          timer = setTimeout(() => { if (!v.isDestroyed) loadFaces(v.state.doc); }, 400);
        },
        destroy() { clearTimeout(timer); },
      };
    },
  });
}

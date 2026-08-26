import type { EditorView } from 'prosemirror-view';
import { TextSelection } from 'prosemirror-state';
import { sectionLevel } from '../editor/layouts';
import type { Node as PMNode } from 'prosemirror-model';

export interface OutlineItem { pos: number; level: number; text: string; layout: string; num?: string }

export function buildOutline(doc: PMNode, includeFloats = true, secnumdepth = 3): OutlineItem[] {
  const items: OutlineItem[] = [];
  const counters = [0, 0, 0, 0, 0, 0, 0];
  doc.forEach((para, pos) => {
    if (para.type.name !== 'paragraph') return;
    const layout = para.attrs.layout as string;
    const lvl = sectionLevel(layout);
    if (lvl !== null) {
      let num: string | undefined;
      if (!layout.endsWith('*')) {
        counters[lvl + 1]++;
        for (let i = lvl + 2; i < counters.length; i++) counters[i] = 0;
        const parts = counters.slice(0, lvl + 2).map(String);
        while (parts.length > 1 && parts[0] === '0') parts.shift();
        if (lvl <= secnumdepth) num = parts.join('.');
      }
      items.push({ pos, level: Math.max(0, lvl + 1), text: para.textContent.trim() || '(empty)', layout, num });
    } else if (layout === 'Title') {
      items.push({ pos, level: 0, text: para.textContent.trim() || '(title)', layout });
    }
    if (includeFloats) {
      para.descendants((n, off) => {
        if (n.type.name === 'inset' && (n.attrs.name === 'Float')) {
          let cap = '';
          n.descendants((c) => { if (c.type.name === 'inset' && c.attrs.name === 'Caption') { cap = c.textContent.trim(); return false; } return true; });
          items.push({ pos: pos + 1 + off, level: 99, text: `${n.attrs.arg}: ${cap || '(no caption)'}`, layout: 'Float' });
          return false;
        }
        return true;
      });
    }
  });
  return items;
}

export function Outline({ view, items, activePos }: { view: EditorView | null; items: OutlineItem[]; activePos: number }) {
  const go = (it: OutlineItem) => {
    if (!view) return;
    const tr = view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(it.pos + 1))).scrollIntoView();
    view.dispatch(tr);
    view.focus();
  };
  let active = -1;
  for (let i = 0; i < items.length; i++) if (items[i].level < 99 && items[i].pos <= activePos) active = i;
  return (
    <div>
      {items.map((it, i) => (
        <div key={it.pos} class={'outline-item ' + (it.level === 99 ? 'other' : 'l' + Math.min(5, it.level)) + (i === active ? ' active' : '')} onClick={() => go(it)} title={it.text}>
          {it.num && <span class="num">{it.num}</span>}{it.text}
        </div>
      ))}
      {!items.length && <div style="color:#888;padding:6px">No sections yet.</div>}
    </div>
  );
}

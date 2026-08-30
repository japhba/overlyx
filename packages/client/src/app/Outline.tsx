import type { EditorView } from 'prosemirror-view';
import { TextSelection } from 'prosemirror-state';
import { sectionLevel } from '../editor/layouts';
import { navHistory } from './navhistory';
import { editorContext } from '../editor/context';
import { moveSection, shiftSection, canMoveSection, canShiftSection } from '../editor/outline';
import type { Node as PMNode } from 'prosemirror-model';

export interface OutlineItem { pos: number; level: number; text: string; layout: string; num?: string }

/** Visible heading text: own text and inline math only (no note/footnote/inset content). */
function headingText(para: PMNode): string {
  let out = '';
  para.forEach((child) => {
    if (child.isText) out += child.text;
    else if (child.type.name === 'math_inline') out += child.attrs.latex;
    else if (child.type.name === 'quotes' || child.type.name === 'space' || child.type.name === 'special') out += child.type.spec.toDOM ? (child.type.name === 'space' ? ' ' : child.type.name === 'quotes' ? '"' : '…') : '';
  });
  return out.trim();
}

export function buildOutline(doc: PMNode, includeFloats = true, secnumdepth = 3): OutlineItem[] {
  const items: OutlineItem[] = [];
  const counters = [0, 0, 0, 0, 0, 0, 0];
  let appendix = false;
  doc.forEach((para, pos) => {
    if (para.type.name !== 'paragraph') return;
    // \appendix: the top-level counter restarts and is lettered from here on
    if (para.attrs.appendix && !appendix) { appendix = true; counters.fill(0); }
    const layout = para.attrs.layout as string;
    const lvl = sectionLevel(layout);
    if (lvl !== null) {
      let num: string | undefined;
      if (!layout.endsWith('*')) {
        counters[lvl + 1]++;
        for (let i = lvl + 2; i < counters.length; i++) counters[i] = 0;
        const parts = counters.slice(0, lvl + 2).map(String);
        while (parts.length > 1 && parts[0] === '0') parts.shift();
        if (appendix && parts.length) parts[0] = String.fromCharCode(64 + Number(parts[0]));
        if (lvl <= secnumdepth) num = parts.join('.');
      }
      items.push({ pos, level: Math.max(0, lvl + 1), text: headingText(para) || '(empty)', layout, num });
    } else if (layout === 'Title') {
      items.push({ pos, level: 0, text: headingText(para) || '(title)', layout });
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
    navHistory.jump(() => view.dispatch(tr));
    view.focus();
  };
  let active = -1;
  for (let i = 0; i < items.length; i++) if (items[i].level < 99 && items[i].pos <= activePos) active = i;
  // LyX's outline operations on a section: move it up / down among its siblings, promote / demote its headings
  const layouts = editorContext.meta?.layouts;
  const run = (it: OutlineItem, what: 'up' | 'down' | 'out' | 'in') => {
    if (!view) return;
    const pos = it.pos + 1;
    const cmd = what === 'up' ? moveSection(-1, pos) : what === 'down' ? moveSection(1, pos) : shiftSection(what === 'out' ? -1 : 1, pos, layouts);
    if (cmd(view.state, view.dispatch)) view.focus();
  };
  const tools = (it: OutlineItem) => {
    if (!view || it.level === 99) return null;
    const st = view.state, pos = it.pos + 1;
    return (
      <span class="outline-tools" onClick={e => e.stopPropagation()}>
        <button title="Move this section up (before the previous one)" disabled={!canMoveSection(st, pos, -1)} data-outline="up" onClick={() => run(it, 'up')}>▲</button>
        <button title="Move this section down (after the next one)" disabled={!canMoveSection(st, pos, 1)} data-outline="down" onClick={() => run(it, 'down')}>▼</button>
        <button title="Promote: one heading level up (subsection → section)" disabled={!canShiftSection(st, pos, -1, layouts)} data-outline="out" onClick={() => run(it, 'out')}>◀</button>
        <button title="Demote: one heading level down (section → subsection)" disabled={!canShiftSection(st, pos, 1, layouts)} data-outline="in" onClick={() => run(it, 'in')}>▶</button>
      </span>
    );
  };
  return (
    <div>
      {items.map((it, i) => (
        <div key={it.pos} class={'outline-item ' + (it.level === 99 ? 'other' : 'l' + Math.min(5, it.level)) + (i === active ? ' active' : '')} onClick={() => go(it)} title={it.text}>
          <span class="outline-text">{it.num && <span class="num">{it.num}</span>}{it.text}</span>
          {tools(it)}
        </div>
      ))}
      {!items.length && <div style="color:#888;padding:6px">No sections yet.</div>}
    </div>
  );
}

/**
 * The Objects pane beside the canvas: Inkscape's Objects dialog, PowerPoint's Selection Pane. The
 * slide worked on as a tree, front first — each group and each drawing with what is in it (a
 * drawing's <g>s and their parts, the letters of a logo) one level further in, as the runtime
 * reports it (runtime/objects.ts). A click selects that object at whatever depth (Shift / Ctrl: one
 * more), the row under the pointer is outlined on the canvas, a double click renames it
 * (data-ol-name — the canvas's tag and the Animation pane use the name too), the lock locks it, and
 * a row dragged onto a sibling goes in front of it (the upper half) or behind it.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ObjKind, ObjNode, Path, SelItem } from './protocol';
import { ICONS } from '../app/Toolbar';
import './deckicons';

interface Props {
  slide: number;
  items: ObjNode[];
  sel: SelItem[];
  readOnly: boolean;
  select(paths: Path[]): void;
  hover(path: Path | null): void;
  rename(path: Path, name: string | null): void;
  lock(path: Path, locked: boolean): void;
  restack(path: Path, ref: Path, front: boolean): void;
  close(): void;
}

const KIND_ICON: Record<ObjKind, string> = {
  text: 'dk-text', shape: 'dk-rect', line: 'dk-line', image: 'dk-image', svg: 'dk-shapes', svgpart: 'dk-path', group: 'dk-group', formula: 'dk-formula', ink: 'dk-draw', other: 'dk-arrange',
};

const keyOf = (p: Path) => p.join('.');
const parentKey = (p: Path) => keyOf(p.slice(0, -1));
/** a drawing or group with more than this many objects starts folded */
const OPEN_UP_TO = 12;

export function ObjectsPane({ slide, items, sel, readOnly, select, hover, rename, lock, restack, close }: Props) {
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ key: string; front: boolean } | null>(null);
  const dragged = useRef<Path | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const selected = new Set(sel.map(s => keyOf(s.path)));
  const isOpen = (n: ObjNode) => { const k = keyOf(n.path); return opened.has(k) || (!folded.has(k) && n.kids <= OPEN_UP_TO); };
  // what is selected deeper in is shown: the rows around it open
  useEffect(() => {
    const need = items.filter(n => n.kids && [...selected].some(k => k.startsWith(keyOf(n.path) + '.')) && !isOpen(n)).map(n => keyOf(n.path));
    if (need.length) setOpened(o => new Set([...o, ...need]));
    list.current?.querySelector('.dl-obj-row.sel')?.scrollIntoView({ block: 'nearest' });
  }, [sel.map(s => keyOf(s.path)).join(' '), items]);
  const toggle = (n: ObjNode) => {
    const k = keyOf(n.path), open = isOpen(n);
    setFolded(f => { const x = new Set(f); if (open) x.add(k); else x.delete(k); return x; });
    setOpened(o => { const x = new Set(o); if (open) x.delete(k); else x.add(k); return x; });
  };
  const rows: ObjNode[] = [];
  let skipDeeper = Infinity;
  for (const n of items) {
    if (n.depth > skipDeeper) continue;
    skipDeeper = Infinity;
    rows.push(n);
    if (n.kids && !isOpen(n)) skipDeeper = n.depth;
  }
  const pick = (n: ObjNode, add: boolean) => {
    const k = keyOf(n.path);
    if (!add) { select([n.path]); return; }
    const kept = sel.map(s => s.path).filter(p => keyOf(p) !== k);
    select(selected.has(k) ? kept : [...kept, n.path]);
  };
  return (
    <div class="dl-anim dl-objects" data-dl-objects>
      <div class="dl-anim-head">
        <span>Objects{slide >= 0 ? ` · slide ${slide + 1}` : ''}</span>
        <button class="dl-btn" onClick={close} title="Close">×</button>
      </div>
      <div class="dl-anim-hint dl-obj-hint">Front first. Click: select, even inside a group or a drawing (Shift: one more) · double-click: rename · drag: in front of / behind another</div>
      <div class="dl-anim-list" ref={list} onMouseLeave={() => hover(null)}>
        {!rows.length && <div class="dl-anim-empty">Nothing on this slide yet.</div>}
        {rows.map(n => {
          const k = keyOf(n.path);
          const cls = 'dl-obj-row' + (selected.has(k) ? ' sel' : '') + (n.locked ? ' locked' : '') + (drop?.key === k ? (drop.front ? ' drop-front' : ' drop-back') : '');
          return (
            <div class={cls} key={k} data-obj-row={k} style={{ paddingLeft: `${4 + n.depth * 14}px` }} draggable={!readOnly && renaming !== k}
              onMouseEnter={() => hover(n.path)}
              onClick={e => pick(n, e.shiftKey || e.ctrlKey || e.metaKey)}
              onDblClick={() => { if (!readOnly) setRenaming(k); }}
              onDragStart={e => { dragged.current = n.path; e.dataTransfer?.setData('text/plain', k); }}
              onDragEnd={() => { dragged.current = null; setDrop(null); }}
              onDragOver={e => {
                const d = dragged.current;
                if (!d || keyOf(d) === k || parentKey(d) !== parentKey(n.path)) return;
                e.preventDefault();
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                const front = e.clientY < r.top + r.height / 2;
                if (drop?.key !== k || drop.front !== front) setDrop({ key: k, front });
              }}
              onDragLeave={() => { if (drop?.key === k) setDrop(null); }}
              onDrop={e => { e.preventDefault(); const d = dragged.current; if (d && drop) restack(d, n.path, drop.front); dragged.current = null; setDrop(null); }}>
              <button class="dl-obj-twist" tabIndex={-1} onClick={e => { e.stopPropagation(); if (n.kids) toggle(n); }} title={n.kids ? (isOpen(n) ? 'Fold' : `Open: ${n.kids} inside`) : undefined}>
                {n.kids ? (isOpen(n) ? '▾' : '▸') : ''}
              </button>
              <span class="dl-obj-icon" dangerouslySetInnerHTML={{ __html: ICONS[KIND_ICON[n.kind]] ?? '' }} />
              {renaming === k ? (
                <input class="dl-obj-name" defaultValue={n.named ? n.label : ''} placeholder={n.label} data-obj-rename ref={el => { if (el && document.activeElement !== el) { el.focus(); el.select(); } }}
                  onClick={e => e.stopPropagation()}
                  onKeyDown={e => {
                    if (e.key === 'Enter') { e.preventDefault(); const v = (e.target as HTMLInputElement).value.trim(); setRenaming(null); if (v !== (n.named ? n.label : '')) rename(n.path, v || null); }
                    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setRenaming(null); }
                  }}
                  onBlur={() => setRenaming(null)} />
              ) : (
                <span class={'dl-obj-label' + (n.named ? ' named' : '')} title={`${n.word}: ${n.label}`}>{n.label}</span>
              )}
              {(n.named || n.label !== n.word) && renaming !== k && <span class="dl-obj-word">{n.word}{n.kids ? ` · ${n.kids}` : ''}</span>}
              {!readOnly && (
                <button class={'dl-obj-lock' + (n.locked ? ' on' : '')} tabIndex={-1} data-obj-lock title={n.locked ? 'Locked: selected, not moved — click to unlock' : 'Lock (selected, not moved or resized)'}
                  onClick={e => { e.stopPropagation(); lock(n.path, !n.locked); }} dangerouslySetInnerHTML={{ __html: ICONS['dk-lock'] ?? '' }} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

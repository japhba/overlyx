import type { LayoutInfo } from '../api';

export interface ToolButton { id: string; title: string; icon: string; action: () => void; active?: boolean; kind?: 'text' | 'math' }
export interface ToolbarProps {
  layouts: LayoutInfo[];
  layout: string;
  onLayout: (name: string) => void;
  groups: ToolButton[][];
}

export const ICONS: Record<string, string> = {
  new: '<svg viewBox="0 0 16 16"><path d="M3 1h7l3 3v11H3z" fill="none" stroke="currentColor"/><path d="M10 1v3h3" fill="none" stroke="currentColor"/></svg>',
  open: '<svg viewBox="0 0 16 16"><path d="M1 3h5l1 2h8v9H1z" fill="none" stroke="currentColor"/></svg>',
  save: '<svg viewBox="0 0 16 16"><path d="M2 2h10l2 2v10H2z" fill="none" stroke="currentColor"/><rect x="5" y="9" width="6" height="4" fill="currentColor"/></svg>',
  undo: '<svg viewBox="0 0 16 16"><path d="M6 4L2 8l4 4M2 8h7a4 4 0 010 8" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  redo: '<svg viewBox="0 0 16 16"><path d="M10 4l4 4-4 4M14 8H7a4 4 0 000 8" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  find: '<svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.8"/></svg>',
  emph: '<svg viewBox="0 0 16 16"><text x="4" y="13" font-size="13" font-style="italic" font-family="serif">E</text></svg>',
  noun: '<svg viewBox="0 0 16 16"><text x="2" y="13" font-size="11" font-family="serif" font-variant="small-caps">Nn</text></svg>',
  bold: '<svg viewBox="0 0 16 16"><text x="3" y="13" font-size="13" font-weight="bold" font-family="serif">B</text></svg>',
  underline: '<svg viewBox="0 0 16 16"><text x="4" y="12" font-size="12" font-family="serif" text-decoration="underline">U</text></svg>',
  strike: '<svg viewBox="0 0 16 16"><text x="3" y="12" font-size="12" font-family="serif" text-decoration="line-through">S</text></svg>',
  tt: '<svg viewBox="0 0 16 16"><text x="2" y="12" font-size="11" font-family="monospace">tt</text></svg>',
  math: '<svg viewBox="0 0 16 16"><text x="2" y="13" font-size="13" font-style="italic" font-family="serif">∑</text></svg>',
  dmath: '<svg viewBox="0 0 16 16"><text x="1" y="12" font-size="9" font-family="serif">∫dx</text></svg>',
  graphics: '<svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" fill="none" stroke="currentColor"/><path d="M3 12l3-4 3 3 2-2 3 3" fill="none" stroke="currentColor"/><circle cx="11" cy="6" r="1.2" fill="currentColor"/></svg>',
  table: '<svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" fill="none" stroke="currentColor"/><path d="M1.5 6.5h13M1.5 10h13M6 2.5v11M10.5 2.5v11" stroke="currentColor"/></svg>',
  float: '<svg viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="9" fill="none" stroke="currentColor"/><path d="M4 13.5h8" stroke="currentColor"/></svg>',
  footnote: '<svg viewBox="0 0 16 16"><text x="2" y="12" font-size="10" font-family="serif">A</text><text x="9" y="8" font-size="7" font-family="serif">1</text></svg>',
  note: '<svg viewBox="0 0 16 16"><path d="M2 2h12v9l-3 3H2z" fill="#fff3a0" stroke="#b09a20"/><path d="M11 14v-3h3" fill="none" stroke="#b09a20"/></svg>',
  comment: '<svg viewBox="0 0 16 16"><path d="M2 2h12v8H7l-3 3v-3H2z" fill="#dbe9ff" stroke="#4c7bb8"/></svg>',
  label: '<svg viewBox="0 0 16 16"><path d="M2 2h6l6 6-6 6-6-6z" fill="none" stroke="currentColor"/><circle cx="5" cy="5" r="1" fill="currentColor"/></svg>',
  ref: '<svg viewBox="0 0 16 16"><path d="M3 8h9M9 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  cite: '<svg viewBox="0 0 16 16"><text x="2" y="12" font-size="10" font-family="serif">[1]</text></svg>',
  ert: '<svg viewBox="0 0 16 16"><text x="1" y="12" font-size="9" font-family="serif" font-style="italic">TeX</text></svg>',
  href: '<svg viewBox="0 0 16 16"><path d="M6.5 9.5l3-3M5 11a2.5 2.5 0 01-3.5-3.5l2-2M11 5a2.5 2.5 0 013.5 3.5l-2 2" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
  depthin: '<svg viewBox="0 0 16 16"><path d="M2 3h12M6 7h8M6 10h8M2 13h12M2 6l2 2.5L2 11" fill="none" stroke="currentColor"/></svg>',
  depthout: '<svg viewBox="0 0 16 16"><path d="M2 3h12M6 7h8M6 10h8M2 13h12M4 6L2 8.5 4 11" fill="none" stroke="currentColor"/></svg>',
  pdf: '<svg viewBox="0 0 16 16"><path d="M3 1h7l3 3v11H3z" fill="none" stroke="currentColor"/><text x="4" y="12" font-size="5" font-family="sans-serif" font-weight="bold">PDF</text></svg>',
  track: '<svg viewBox="0 0 16 16"><path d="M2 12l8-8 2 2-8 8H2z" fill="none" stroke="currentColor"/></svg>',
  margin: '<svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="8" height="11" fill="none" stroke="currentColor"/><rect x="11" y="4" width="3.5" height="3" fill="currentColor"/></svg>',
  outline: '<svg viewBox="0 0 16 16"><path d="M2 3h12M4 7h10M6 11h8" stroke="currentColor" stroke-width="1.5"/></svg>',
  box: '<svg viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="10" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  toggleinset: '<svg viewBox="0 0 16 16"><rect x="2" y="4" width="12" height="8" rx="2" fill="none" stroke="currentColor"/><path d="M5 8h6" stroke="currentColor"/></svg>',
};

export function Toolbar({ layouts, layout, onLayout, groups }: ToolbarProps) {
  const names = layouts.map(l => l.name);
  if (layout && !names.includes(layout)) names.unshift(layout);
  return (
    <div class="toolbar" onMouseDown={e => { if ((e.target as HTMLElement).tagName !== 'SELECT') e.preventDefault(); }}>
      <select value={layout} onChange={e => onLayout((e.target as HTMLSelectElement).value)} title="Paragraph layout (Alt+P …)">
        {names.map(n => <option key={n} value={n}>{n}</option>)}
      </select>
      {groups.map((g, gi) => (
        <span key={gi} style="display:contents">
          <span class="tb-sep" />
          {g.map(b => (
            <button key={b.id} class={'tb-btn' + (b.active ? ' active' : '') + (b.kind === 'math' ? ' math' : '')} title={b.title} onClick={b.action}
              dangerouslySetInnerHTML={ICONS[b.icon] ? { __html: ICONS[b.icon] } : undefined}>{ICONS[b.icon] ? undefined : b.icon}</button>
          ))}
        </span>
      ))}
    </div>
  );
}

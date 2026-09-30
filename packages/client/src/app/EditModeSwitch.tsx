/**
 * Google Docs' mode switch at the top right of the editor: Editing · Suggesting · Viewing, and
 * under them which tracked changes are drawn (the review toolbar's Show insertions / deletions).
 * Suggesting is change tracking, a setting of the document (\tracking_changes, as in LyX), so it
 * is on for everyone editing the document; Viewing makes only this editor read-only. Shared by
 * the web client (end of the first toolbar row) and the VS Code webview (its top bar).
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { EditorView } from 'prosemirror-view';
import { changesFilterKey, setChangesFilter } from '../editor/plugins/changes';
import { recordUsage } from '../usage';

export type EditMode = 'editing' | 'suggesting' | 'viewing';

export function editModeOf(tracking: boolean, viewing: boolean): EditMode {
  return viewing ? 'viewing' : tracking ? 'suggesting' : 'editing';
}

/** Switch to `mode`: Editing and Suggesting leave Viewing and set change tracking; Viewing leaves tracking as it is. */
export function applyEditMode(mode: EditMode, s: { tracking: boolean; toggleTracking(): void; setViewing(on: boolean): void }): void {
  s.setViewing(mode === 'viewing');
  if (mode !== 'viewing' && (mode === 'suggesting') !== s.tracking) s.toggleTracking();
}

const MODES: { mode: EditMode; label: string; hint: string; title: string }[] = [
  { mode: 'editing', label: 'Editing', hint: 'Edit the document directly', title: 'Change tracking off' },
  { mode: 'suggesting', label: 'Suggesting', hint: 'Edits become tracked changes to accept or reject',
    title: 'Change tracking on (Ctrl+Shift+E) — a setting of the document, so it applies to everyone editing it' },
  { mode: 'viewing', label: 'Viewing', hint: 'Read the document without changing it', title: 'This editor is read-only until you switch back' },
];

/** the four combinations of the insertion / deletion filter (editor/plugins/changes.ts) */
export const CHANGE_VIEWS = [
  { id: 'all', label: 'All changes', title: 'Insertions and deletions, marked in their author’s colour', ins: true, del: true },
  { id: 'insertions', label: 'Only additions', title: 'Deleted text is folded to a small caret: the text as it reads once the changes are accepted', ins: true, del: false },
  { id: 'deletions', label: 'Only deletions', title: 'Inserted text is folded to a small caret: the text as it was before the changes', ins: false, del: true },
  { id: 'none', label: 'Unchanged text only', title: 'Insertions and deletions are both folded away', ins: false, del: false },
] as const;

const ICONS: Record<EditMode, string> = {
  editing: '<svg viewBox="0 0 16 16"><path d="M2.5 13.5l.7-3L10.8 3l2.2 2.2-7.5 7.6z"/><path d="M9.3 4.5l2.2 2.2"/></svg>',
  suggesting: '<svg viewBox="0 0 16 16"><path d="M2 2.5h12v8.5H6.5L2 14z"/><path d="M5.6 8.8l.3-1.4 3.5-3.5 1.1 1.1-3.5 3.5z"/></svg>',
  viewing: '<svg viewBox="0 0 16 16"><path d="M1.2 8S3.8 3.5 8 3.5 14.8 8 14.8 8 12.2 12.5 8 12.5 1.2 8 1.2 8z"/><circle cx="8" cy="8" r="2.1"/></svg>',
};
const Icon = ({ mode }: { mode: EditMode }) => <span class="edit-mode-icon" dangerouslySetInnerHTML={{ __html: ICONS[mode] }} />;

export function EditModeSwitch({ mode, canEdit, view, views, onMode }: {
  mode: EditMode;
  /** false with view access only: Viewing is all there is */
  canEdit: boolean;
  /** the editor whose change filter the menu shows … */
  view: EditorView | null;
  /** … and every editor it applies to (the master and the combined view's children) */
  views: () => EditorView[];
  onMode(mode: EditMode): void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    window.addEventListener('mousedown', down, true);
    window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('mousedown', down, true); window.removeEventListener('keydown', key, true); };
  }, [open]);

  const shown = mode === 'viewing' || !canEdit ? 'viewing' : mode;
  const current = MODES.find(m => m.mode === shown)!;
  const filter = view ? changesFilterKey.getState(view.state) : null;
  const ins = filter?.showInsertions ?? true, del = filter?.showDeletions ?? true;
  const pickMode = (m: EditMode) => {
    setOpen(false);
    recordUsage('toolbar', `mode ▸ ${m}`);
    if (m !== shown) onMode(m);
    view?.focus();
  };
  const pickView = (c: typeof CHANGE_VIEWS[number]) => {
    setOpen(false);
    recordUsage('toolbar', `changes ▸ ${c.id}`);
    for (const v of views()) {
      const f = changesFilterKey.getState(v.state);
      if (f?.showInsertions !== c.ins || f?.showDeletions !== c.del) setChangesFilter(v, { showInsertions: c.ins, showDeletions: c.del });
    }
    view?.focus();
  };

  return (
    // mousedown must not take the focus (and the selection) away from the editor, as in the toolbars
    <div class="edit-mode" ref={wrap} onMouseDown={e => e.preventDefault()}>
      <button type="button" class={'edit-mode-btn mode-' + shown} data-edit-mode={shown} aria-haspopup="menu" aria-expanded={open}
        title={`${current.label}: ${current.hint.toLowerCase()} — click to switch between editing, suggesting and viewing`} onClick={() => setOpen(o => !o)}>
        <Icon mode={shown} /><span class="edit-mode-label">{current.label}</span><span class="edit-mode-caret">▾</span>
      </button>
      {open && (
        <div class="edit-mode-menu" role="menu">
          {MODES.map(m => (
            <button type="button" key={m.mode} role="menuitemradio" aria-checked={shown === m.mode} data-mode={m.mode}
              disabled={!canEdit && m.mode !== 'viewing'} title={!canEdit && m.mode !== 'viewing' ? 'The project was shared with you for viewing' : m.title} onClick={() => pickMode(m.mode)}>
              <Icon mode={m.mode} />
              <span class="edit-mode-text"><b>{m.label}</b><small>{m.hint}</small></span>
              <span class="edit-mode-check">{shown === m.mode ? '✓' : ''}</span>
            </button>
          ))}
          <div class="edit-mode-sep" />
          <div class="edit-mode-head">Show changes</div>
          {CHANGE_VIEWS.map(c => {
            const on = c.ins === ins && c.del === del;
            return (
              <button type="button" key={c.id} role="menuitemradio" aria-checked={on} data-changes={c.id} class="edit-mode-filter" title={c.title} onClick={() => pickView(c)}>
                <span class="edit-mode-check lead">{on ? '✓' : ''}</span>
                <span class="edit-mode-text">{c.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

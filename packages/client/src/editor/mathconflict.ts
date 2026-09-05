import { ySyncPluginKey } from 'y-prosemirror';
import type { EditorView } from 'prosemirror-view';
import { schema } from '@overlyx/core';
import { editorContext } from './context';

/** Preserve a competing local formula as a normal, persistent review comment. */
function clockValue(text: string): Record<string, number> {
  try {
    const value = JSON.parse(text || '{}');
    return value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0)) as Record<string, number> : {};
  } catch { return {}; }
}

export class FormulaReview {
  private local: string | null = null;
  private base: Record<string, number> = {};
  private localClock: Record<string, number> = {};
  private queued = false;
  private pending: string | null = null;
  private retained = new Set<string>();
  constructor(private view: EditorView, private getPos: () => number | undefined, private display: boolean, clock: string) { this.adopt(clock); }
  adopt(clock: string): void { this.base = clockValue(clock); }
  edited(latex: string): string {
    const client = String(ySyncPluginKey.getState(this.view.state)?.doc.clientID ?? 'local');
    this.base = { ...this.base, [client]: Math.max(this.base[client] ?? 0, this.localClock[client] ?? 0) + 1 };
    this.localClock = this.base;
    this.local = latex;
    return JSON.stringify(this.base);
  }
  received(latex: string, clock: string, focused: boolean): void {
    const incoming = clockValue(clock);
    if (!focused) this.base = incoming;
    const sync = ySyncPluginKey.getState(this.view.state);
    if (!sync?.isChangeOrigin || sync.isUndoRedoOperation || this.local === null || this.local === latex || this.retained.has(this.local)) return;
    // A later author who started from our displayed version is making an ordinary
    // sequential edit. Only a version based on older content needs conflict preservation.
    if (Object.entries(this.localClock).every(([id, count]) => (incoming[id] ?? 0) >= count)) { this.local = null; return; }
    this.pending = this.local;
    if (!this.queued) { this.queued = true; queueMicrotask(() => { this.queued = false; this.flush(); }); }
  }
  private flush(): void {
    const latex = this.pending; this.pending = null;
    if (latex === null || this.view.isDestroyed || this.retained.has(latex)) return;
    const pos = this.getPos();
    const current = pos === undefined ? null : this.view.state.doc.nodeAt(pos);
    if (pos === undefined || !current) return;
    this.retained.add(latex);
    const author = editorContext.user?.name ?? 'a collaborator';
    const paragraph = schema.nodes.paragraph;
    const formula = schema.nodes[this.display ? 'math_display' : 'math_inline'].create({ latex, delim: '$' });
    const note = schema.nodes.inset.create({ name: 'Note', arg: 'Comment', status: 'open', params: '[]' }, [
      paragraph.create({ layout: 'Plain Layout' }, schema.text(`Concurrent formula edit by ${author} — retained for review:`)),
      paragraph.create({ layout: 'Plain Layout' }, formula),
    ]);
    this.view.dispatch(this.view.state.tr.insert(pos + current.nodeSize, note).setMeta('lyx-changes', true));
    editorContext.notify?.('Concurrent formula edits: a competing version was saved in a comment beside the formula.');
  }
  destroy(): void { this.pending = null; }
}

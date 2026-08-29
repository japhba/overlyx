/**
 * Navigation history — VS Code's *Go Back* / *Go Forward* (`Ctrl+Alt+←` / `Ctrl+Alt+→`, ⌥⌘← / ⌥⌘→
 * on a Mac): a stack of the places the cursor has been, across the documents of the workspace.
 *
 * A new entry is made for a jump — following a cross-reference, the outline, a presence avatar,
 * Ctrl+Home/End, a far mouse click or find hit (at least JUMP_DISTANCE positions away), a switch
 * to another tab — while typing and stepping through the text only update the current entry. So
 * *Back* returns to where one was before the last jump, and *Forward* to where one was at its
 * target. Positions are kept the way the cursor memory keeps them (offset + the text before the
 * cursor), so an entry still finds its place after the document changed.
 *
 * The stack survives a reload of the page (sessionStorage, one per browser tab).
 */
import type { EditorState } from 'prosemirror-state';
import { cursorToSave, type SavedCursor } from '../editor/cursormemory';

export interface NavLocation {
  /** workspace document id (`project/file.tex`; `text:project/file.tex` for a text-file tab) */
  docId: string;
  /** null: no position (a text-file tab) */
  cursor: SavedCursor | null;
}

const MAX_ENTRIES = 100;
/** a cursor move of at least this many document positions is a jump (~ a few lines of text) */
export const JUMP_DISTANCE = 400;
/** cursor moves right after a document was opened settle on its entry (restored cursor, `?goto=label`) */
const SETTLE_MS = 1500;
/** a restore that never arrives (the document could not be opened) is forgotten after this */
const RESTORE_TIMEOUT_MS = 15000;
const STORAGE = 'ol.nav';

export class NavHistory {
  entries: NavLocation[] = [];
  /** index of the entry the cursor is at (-1: nothing yet) */
  index = -1;
  private settleUntil = 0;
  private forcing = false;
  /** the entry being navigated to (Back/Forward): its first cursor position is the arrival, not a new jump */
  private restoring: { loc: NavLocation; until: number } | null = null;
  private listeners = new Set<() => void>();

  canBack(): boolean { return this.index > 0; }
  canForward(): boolean { return this.index >= 0 && this.index < this.entries.length - 1; }
  current(): NavLocation | null { return this.entries[this.index] ?? null; }
  /** the entry Back would go to */
  previous(): NavLocation | null { return this.canBack() ? this.entries[this.index - 1] : null; }

  subscribe(l: () => void): () => void { this.listeners.add(l); return () => { this.listeners.delete(l); }; }
  private changed() { for (const l of this.listeners) l(); this.save(); }

  /** run an explicit jump: the position it moves the cursor to becomes an entry however near it is */
  jump<T>(fn: () => T): T {
    const was = this.forcing;
    this.forcing = true;
    try { return fn(); } finally { this.forcing = was; }
  }

  /**
   * The cursor is at `cursor` in `docId` — called on every selection change. `docChanged`: the
   * selection moved because the document changed (typing, remote edits, undo, a document being
   * loaded): never a jump, only the current entry's position is brought up to date.
   */
  visit(docId: string, cursor: SavedCursor | null, opts: { docChanged?: boolean; now?: number } = {}): void {
    const now = opts.now ?? Date.now();
    const cur = this.entries[this.index] as NavLocation | undefined;
    if (this.restoring) {
      if (now > this.restoring.until) this.restoring = null;
      else if (this.restoring.loc.docId === docId) {
        if (opts.docChanged) return;                  // the document is still loading
        this.restoring = null;
        this.entries[this.index] = { docId, cursor };  // arrived; what the user does next is a move of its own
        this.settleUntil = 0;
        this.changed();
        return;
      } else if (!opts.docChanged) this.restoring = null;   // went elsewhere meanwhile: the restore is off
      else return;
    }
    if (opts.docChanged) {
      if (cur && cur.docId === docId) { this.entries[this.index] = { docId, cursor }; this.save(); }
      return;
    }
    let push: boolean;
    if (!cur || cur.docId !== docId || this.forcing) push = true;
    else if (now < this.settleUntil) push = false;
    else push = !!cur.cursor && !!cursor && Math.abs(cur.cursor.pos - cursor.pos) >= JUMP_DISTANCE;
    if (push && cur && cur.docId === docId && samePlace(cur.cursor, cursor)) push = false;
    if (push) {
      this.entries.splice(this.index + 1);
      this.entries.push({ docId, cursor });
      if (this.entries.length > MAX_ENTRIES) this.entries.shift();
      this.index = this.entries.length - 1;
      this.settleUntil = cur && cur.docId !== docId ? now + SETTLE_MS : 0;
    } else {
      this.entries[this.index] = { docId, cursor };
    }
    this.changed();
  }

  /** the cursor of the view the user is in (a convenience for callers holding an editor state) */
  visitState(docId: string, state: EditorState, opts: { docChanged?: boolean } = {}): void {
    this.visit(docId, cursorToSave(state), opts);
  }

  /** step back; the returned location is to be shown by the caller (see `restored`) */
  back(now = Date.now()): NavLocation | null {
    if (!this.canBack()) return null;
    return this.go(this.index - 1, now);
  }
  forward(now = Date.now()): NavLocation | null {
    if (!this.canForward()) return null;
    return this.go(this.index + 1, now);
  }
  private go(to: number, now: number): NavLocation {
    this.index = to;
    const loc = this.entries[to];
    this.restoring = { loc, until: now + RESTORE_TIMEOUT_MS };
    this.changed();
    return loc;
  }
  /** the caller placed the cursor at the location returned by back/forward itself (or gave up) */
  restored(): void { this.restoring = null; }
  save(): void {
    try { sessionStorage.setItem(STORAGE, JSON.stringify({ entries: this.entries, index: this.index })); } catch { /* storage disabled */ }
  }
  load(): void {
    try {
      const raw = sessionStorage.getItem(STORAGE);
      if (!raw) return;
      const v = JSON.parse(raw);
      if (!Array.isArray(v?.entries)) return;
      this.entries = v.entries.filter((e: NavLocation) => e && typeof e.docId === 'string' && (e.cursor === null || typeof e.cursor?.pos === 'number'));
      this.index = Math.min(Math.max(-1, Number(v.index)), this.entries.length - 1);
    } catch { /* ignore */ }
  }
}

const samePlace = (a: SavedCursor | null, b: SavedCursor | null): boolean => (a === null && b === null) || (!!a && !!b && a.pos === b.pos);

/** the workspace's history */
export const navHistory = new NavHistory();

/**
 * Which OverLyX editors are open: their sessions, webview panels, current outline and cursor.
 * The outline tree, the PDF panel and the commands all look things up here.
 */
import * as vscode from 'vscode';
import type { DocSession } from './session.ts';
import type { OutlineEntry } from '../shared/protocol.ts';

export interface OpenEditor {
  session: DocSession;
  panel: vscode.WebviewPanel;
  outline: OutlineEntry[];
  selectionPos: number;
}

export class Registry {
  private related = new Map<OpenEditor, Map<string, DocSession>>();
  relatedSessions(e: OpenEditor): Map<string, DocSession> {
    if (!this.related.has(e)) this.related.set(e, new Map());
    return this.related.get(e)!;
  }
  sessionByDocId(id: string): DocSession | undefined {
    const direct = this.byDocId(id);
    if (direct) return direct.session;
    for (const sessions of this.related.values()) if (sessions.has(id)) return sessions.get(id);
    return undefined;
  }
  private editors = new Map<string, OpenEditor>();   // by docId
  active: OpenEditor | null = null;
  private changed = new vscode.EventEmitter<void>();
  /** fired when the active editor, its outline or its cursor changed */
  readonly onDidChange = this.changed.event;

  add(e: OpenEditor): void {
    this.editors.set(e.session.docId, e);
    this.active = e;
    this.changed.fire();
  }

  remove(e: OpenEditor): void {
    for (const session of this.relatedSessions(e).values()) session.dispose();
    this.related.delete(e);
    if (this.editors.get(e.session.docId) === e) this.editors.delete(e.session.docId);
    if (this.active === e) { this.active = this.editors.values().next().value ?? null; }
    this.changed.fire();
  }

  setActive(e: OpenEditor | null): void {
    if (e === this.active) return;
    this.active = e;
    this.changed.fire();
  }

  byDocId(docId: string): OpenEditor | undefined { return this.editors.get(docId); }
  byDocument(doc: vscode.TextDocument): OpenEditor | undefined {
    for (const e of this.editors.values()) if (e.session.document === doc) return e;
    return undefined;
  }
  all(): OpenEditor[] { return [...this.editors.values()]; }
  touch(): void { this.changed.fire(); }
}

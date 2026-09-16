/**
 * One open OverLyX custom editor: the bridge between the webview's ProseMirror document and the
 * VS Code TextDocument. The webview sends the full PM doc (debounced) after each change; we
 * serialize it with the core writer and replace the TextDocument's text (VS Code then owns dirty
 * state, save, undo at file level, git). A TextDocument change we did not cause (git checkout,
 * another editor, VS Code undo) is parsed and pushed back to the webview as a diff.
 */
import * as vscode from 'vscode';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { lyxToPm, headerValue, mergeLyx, type LyxDocument, type PMJSON } from '@overlyx/core';
import { documentModel, sameModel, modelDocument, type DocumentModel } from '../shared/documentModel.ts';
import { parseDocumentText, writeDocumentText, includeResolver, cachedParseFile, type TexContext } from './texdoc.ts';
import { buildMeta } from './meta.ts';
import { findMaster } from './project.ts';

export class DocSession {
  private headerLines: string[] = [];
  isChild = false;
  /** the exact text we last wrote into the TextDocument (to tell our own echoes from external edits) */
  private lastWritten: string | null = null;
  private disposed = false;
  private diskText: string;

  constructor(
    public document: vscode.TextDocument,
    public readonly ctx: TexContext,
    public readonly project: string,
    public readonly relPath: string,
    private readonly recoveryDir: string,
  ) { this.diskText = fs.readFileSync(document.uri.fsPath, 'utf8'); }

  get docId(): string { return `${this.project}/${this.relPath}`; }

  getHeaderLines(): string[] { return [...this.headerLines]; }

  /** Parse the current TextDocument text into the model + PM JSON for the webview. */
  parseCurrent(): { pmDoc: PMJSON; headerLines: string[]; fragment: boolean; warnings: string[] } {
    const r = parseDocumentText(this.document.getText(), this.ctx, this.relPath);
    this.isChild = r.fragment;
    this.headerLines = r.doc.header.lines;
    const pmDoc = lyxToPm(r.doc);
    return { pmDoc, headerLines: this.headerLines, fragment: r.fragment, warnings: r.warnings };
  }

  /** The TextDocument is authoritative; webview snapshots are changes against a supplied base. */
  toLyxDocument(): LyxDocument { return parseDocumentText(this.document.getText(), this.ctx, this.relPath).doc; }

  header(): LyxDocument['header'] { return { lines: this.headerLines } as LyxDocument['header']; }

  /** Serialize the current model to .tex text. */
  toText(): string {
    return writeDocumentText(this.toLyxDocument(), this.ctx, this.relPath, this.isChild, includeResolver(this.ctx, this.relPath)).text;
  }

  /** The webview sent an updated PM doc: write it into the TextDocument. */
  async applyPmUpdate(pmDoc: PMJSON, headerLines: string[], base: DocumentModel): Promise<boolean> {
    if (this.disposed) return false;
    const diskChanged = await this.syncFromDisk();
    const incoming = documentModel(pmDoc, headerLines);
    if (sameModel(incoming, base)) return diskChanged;
    const current = parseDocumentText(this.document.getText(), this.ctx, this.relPath);
    const currentModel = documentModel(lyxToPm(current.doc), current.doc.header.lines);
    if (sameModel(incoming, currentModel)) return diskChanged;
    const ours = modelDocument(incoming, current.doc);
    const merged = mergeLyx(modelDocument(base, current.doc), ours, current.doc);
    const mergedModel = documentModel(lyxToPm(merged), merged.header.lines);
    const rebased = !sameModel(incoming, mergedModel);
    if (rebased) this.preserveDraft(writeDocumentText(ours, this.ctx, this.relPath, current.fragment, includeResolver(this.ctx, this.relPath)).text);
    const { text, files } = writeDocumentText(merged, this.ctx, this.relPath, current.fragment, includeResolver(this.ctx, this.relPath));
    this.writeSidecars(files);
    await this.replaceText(text);
    this.parseCurrent();
    return diskChanged || rebased;
  }

  /** VS Code does not reload a dirty TextDocument when another process changes its file. */
  async syncFromDisk(): Promise<boolean> {
    // Child editors in a joint view do not own VS Code tabs, so their buffers may be released.
    const reopened = this.document.isClosed;
    if (reopened) this.document = await vscode.workspace.openTextDocument(this.document.uri);
    const disk = fs.readFileSync(this.document.uri.fsPath, 'utf8');
    if (disk === this.diskText) return reopened;
    // Let VS Code reload a clean file itself: a WorkspaceEdit would mark it dirty while
    // leaving VS Code's saved-file timestamp behind, causing a false save conflict.
    if (!this.document.isDirty && this.document.getText() !== disk) {
      await new Promise<void>((resolve, reject) => {
        const listener = vscode.workspace.onDidChangeTextDocument(event => {
          if (event.document !== this.document || event.contentChanges.length === 0) return;
          clearTimeout(timeout); listener.dispose(); resolve();
        });
        const timeout = setTimeout(() => { listener.dispose(); reject(new Error(`VS Code did not reload ${this.docId} from disk`)); }, 5000);
      });
      return this.syncFromDisk();
    }
    const local = this.document.getText();
    let text = disk;
    if (local !== this.diskText && local !== disk) {
      const base = parseDocumentText(this.diskText, this.ctx, this.relPath);
      const ours = parseDocumentText(local, this.ctx, this.relPath);
      const theirs = parseDocumentText(disk, this.ctx, this.relPath);
      this.preserveDraft(local);
      const merged = mergeLyx(base.doc, ours.doc, theirs.doc);
      text = writeDocumentText(merged, this.ctx, this.relPath, theirs.fragment, includeResolver(this.ctx, this.relPath)).text;
    }
    await this.replaceText(text);
    this.diskText = disk;
    this.parseCurrent();
    return true;
  }

  /** Drawing data lives in SVGs: persist it before reparsing the TeX anchor. */
  private writeSidecars(files: Record<string, string>): void {
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.resolve(path.dirname(this.document.uri.fsPath), rel);
      if (!abs.startsWith(this.ctx.root + path.sep) || !abs.endsWith('.svg')) throw new Error(`Invalid drawing sidecar: ${rel}`);
      if (fs.existsSync(abs) && fs.readFileSync(abs, 'utf8') === content) continue;
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
  }

  private preserveDraft(text: string): void {
    fs.mkdirSync(this.recoveryDir, { recursive: true });
    const destination = path.join(this.recoveryDir, `${path.basename(this.relPath, '.tex')}-${crypto.randomUUID()}.tex`);
    fs.writeFileSync(destination, text, { flag: 'wx' });
    console.info(`OverLyX preserved an unsaved draft before merging external changes: ${destination}`);
  }

  private async replaceText(text: string): Promise<void> {
    if (text === this.document.getText()) return;
    this.lastWritten = text;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(this.document.uri, new vscode.Range(0, 0, this.document.lineCount, 0), text);
    if (!await vscode.workspace.applyEdit(edit)) throw new Error(`Could not apply the edit to ${this.docId}`);
  }

  /**
   * The TextDocument changed. Returns null when it was our own write (nothing to do), else the
   * re-parsed content to push to the webview.
   */
  externalChange(): { pmDoc: PMJSON; headerLines: string[] } | null {
    const text = this.document.getText();
    if (text === this.lastWritten) return null;
    const r = this.parseCurrent();
    return { pmDoc: r.pmDoc, headerLines: r.headerLines };
  }

  /** Update header lines (document settings / tracking switches) and re-serialize. */
  async setHeader(body: { headerLines?: string[]; preamble?: string; set?: Record<string, string> }): Promise<string[]> {
    const before = this.toLyxDocument();
    const base = documentModel(lyxToPm(before), before.header.lines);
    let lines = [...this.headerLines];
    if (Array.isArray(body.headerLines)) lines = body.headerLines.map(String);
    if (typeof body.preamble === 'string') {
      const start = lines.indexOf('\\begin_preamble');
      const content = body.preamble.replace(/\r\n/g, '\n').split('\n');
      if (start >= 0) { const end = lines.indexOf('\\end_preamble', start); lines.splice(start + 1, end - start - 1, ...content); }
      else { const idx = lines.findIndex(l => l.startsWith('\\textclass')); lines.splice(idx + 1, 0, '\\begin_preamble', ...content, '\\end_preamble'); }
    }
    if (body.set && typeof body.set === 'object') {
      for (const [k, v] of Object.entries(body.set)) {
        const i = lines.findIndex(l => l === '\\' + k || l.startsWith('\\' + k + ' '));
        if (i >= 0) lines[i] = `\\${k} ${v}`; else lines.push(`\\${k} ${v}`);
      }
    }
    await this.applyPmUpdate(base.pmDoc, lines, base);
    return this.getHeaderLines();
  }

  meta(): Record<string, unknown> {
    return buildMeta({
      ctx: this.ctx, project: this.project, relPath: this.relPath,
      lyx: this.toLyxDocument(), isChild: this.isChild, fileText: this.document.getText(),
    });
  }

  /** For a build: the master's file (a child builds through its master), and that file's header. */
  buildTarget(): { absPath: string; header: LyxDocument['header'] | null } {
    const masterRel = this.isChild ? findMaster(this.ctx.root, this.relPath) : null;
    if (masterRel) {
      let header: LyxDocument['header'] | null = null;
      try { header = cachedParseFile(this.ctx, masterRel).doc.header; } catch { /* master unreadable */ }
      return { absPath: path.join(this.ctx.root, masterRel), header };
    }
    return { absPath: path.join(this.ctx.root, this.relPath), header: this.header() };
  }

  dispose(): void { this.disposed = true; }
}

export function headerBool(header: LyxDocument['header'] | null, key: string): boolean {
  return header ? headerValue(header, key) === 'true' : false;
}

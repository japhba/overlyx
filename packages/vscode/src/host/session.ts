/**
 * One open OverLyX custom editor: the bridge between the webview's ProseMirror document and the
 * VS Code TextDocument. The webview sends the full PM doc (debounced) after each change; we
 * serialize it with the core writer and replace the TextDocument's text (VS Code then owns dirty
 * state, save, undo at file level, git). A TextDocument change we did not cause (git checkout,
 * another editor, VS Code undo) is parsed and pushed back to the webview as a diff.
 */
import * as vscode from 'vscode';
import path from 'node:path';
import { lyxToPm, pmToLyxBody, headerValue, type LyxDocument, type PMJSON } from '@overlyx/core';
import { parseDocumentText, writeDocumentText, includeResolver, cachedParseFile, type TexContext } from './texdoc.ts';
import { buildMeta } from './meta.ts';
import { findMaster } from './project.ts';

export class DocSession {
  /** header/preamble/format/trailer of the last parse — the parts the PM doc does not carry */
  private preamble: string[] = ['#LyX 2.5 created this file. For more info see https://www.lyx.org/'];
  private format = 643;
  private headerLines: string[] = [];
  private trailer: string[] = [];
  isChild = false;
  /** the exact text we last wrote into the TextDocument (to tell our own echoes from external edits) */
  private lastWritten: string | null = null;
  /** the latest PM doc received from the webview (null until it edits) */
  private pmDoc: PMJSON | null = null;
  private disposed = false;

  constructor(
    public readonly document: vscode.TextDocument,
    public readonly ctx: TexContext,
    public readonly project: string,
    public readonly relPath: string,
  ) {}

  get docId(): string { return `${this.project}/${this.relPath}`; }

  getHeaderLines(): string[] { return [...this.headerLines]; }

  /** Parse the current TextDocument text into the model + PM JSON for the webview. */
  parseCurrent(): { pmDoc: PMJSON; headerLines: string[]; fragment: boolean; warnings: string[] } {
    const r = parseDocumentText(this.document.getText(), this.ctx, this.relPath);
    this.isChild = r.fragment;
    this.preamble = r.doc.preamble;
    this.format = r.doc.format;
    this.headerLines = r.doc.header.lines;
    this.trailer = r.doc.trailer;
    this.pmDoc = null;
    return { pmDoc: lyxToPm(r.doc), headerLines: this.headerLines, fragment: r.fragment, warnings: r.warnings };
  }

  /** The current document model: from the webview's PM doc if it edited, else from the file text. */
  toLyxDocument(): LyxDocument {
    if (this.pmDoc) {
      return { preamble: this.preamble, format: this.format, header: { lines: this.headerLines }, body: pmToLyxBody(this.pmDoc), trailer: this.trailer };
    }
    const r = parseDocumentText(this.document.getText(), this.ctx, this.relPath);
    return r.doc;
  }

  header(): LyxDocument['header'] { return { lines: this.headerLines } as LyxDocument['header']; }

  /** Serialize the current model to .tex text. */
  toText(): string {
    return writeDocumentText(this.toLyxDocument(), this.ctx, this.relPath, this.isChild, includeResolver(this.ctx, this.relPath)).text;
  }

  /** The webview sent an updated PM doc: write it into the TextDocument. */
  async applyPmUpdate(pmDoc: PMJSON, headerLines?: string[]): Promise<void> {
    if (this.disposed) return;
    this.pmDoc = pmDoc;
    if (headerLines) this.headerLines = headerLines;
    const text = this.toText();
    if (text === this.document.getText()) return;
    this.lastWritten = text;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(this.document.uri, new vscode.Range(0, 0, this.document.lineCount, 0), text);
    await vscode.workspace.applyEdit(edit);
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
    this.headerLines = lines;
    if (this.pmDoc) await this.applyPmUpdate(this.pmDoc);
    else {
      // no webview edit yet: rewrite from the parsed file with the new header
      const r = parseDocumentText(this.document.getText(), this.ctx, this.relPath);
      const doc: LyxDocument = { ...r.doc, header: { ...r.doc.header, lines } };
      const text = writeDocumentText(doc, this.ctx, this.relPath, this.isChild, includeResolver(this.ctx, this.relPath)).text;
      if (text !== this.document.getText()) {
        this.lastWritten = text;
        const edit = new vscode.WorkspaceEdit();
        edit.replace(this.document.uri, new vscode.Range(0, 0, this.document.lineCount, 0), text);
        await vscode.workspace.applyEdit(edit);
      }
    }
    return lines;
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

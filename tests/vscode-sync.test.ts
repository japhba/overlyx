import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inkSvg, lyxToPm } from '@overlyx/core';
import { documentModel, mergeModels } from '../packages/vscode/src/shared/documentModel.ts';
import { parseDocumentText } from '../packages/vscode/src/host/texdoc.ts';

const state = vi.hoisted(() => ({ documents: new Map<string, { text: string; version: number }>(), listeners: new Set<(event: unknown) => void>() }));
vi.mock('vscode', () => ({
  Range: class { constructor(..._args: unknown[]) {} },
  WorkspaceEdit: class {
    edits: { uri: { fsPath: string }; text: string }[] = [];
    replace(uri: { fsPath: string }, _range: unknown, text: string) { this.edits.push({ uri, text }); }
  },
  workspace: { openTextDocument: async (uri: { fsPath: string }) => state.documents.get(uri.fsPath)!, onDidChangeTextDocument: (listener: (event: unknown) => void) => { state.listeners.add(listener); return { dispose: () => state.listeners.delete(listener) }; }, applyEdit: async (edit: { edits: { uri: { fsPath: string }; text: string }[] }) => {
    for (const { uri, text } of edit.edits) { const doc = state.documents.get(uri.fsPath)!; doc.text = text; doc.version++; }
    return true;
  } },
}));
import { DocSession } from '../packages/vscode/src/host/session.ts';

const initial = '\\section{Replica derivation}\n\nOld directions d and e.\n\nAn unchanged anchor.\n\nAnother unchanged anchor.\n\nLocal notes.\n';
const revised = initial.replace('Replica derivation', 'MSRJD derivation').replace('Old directions d and e.', 'New normalized representation directions.');
let root: string;
let ctx: { root: string; layoutDir: string };
let doc: { text: string; version: number; isDirty: boolean; isClosed: boolean; uri: { fsPath: string }; getText(): string; readonly lineCount: number };
let session: DocSession;
const model = (text: string) => { const parsed = parseDocumentText(text, ctx, 'appendix.tex'); return documentModel(lyxToPm(parsed.doc), parsed.doc.header.lines); };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'overlyx-sync-test-'));
  ctx = { root, layoutDir: path.resolve('lyx/lib/layouts') };
  fs.writeFileSync(path.join(root, 'main.tex'), '\\documentclass{article}\n\\begin{document}\n\\input{appendix}\n\\end{document}\n');
  fs.writeFileSync(path.join(root, 'appendix.tex'), initial);
  doc = { text: initial, version: 1, isDirty: true, isClosed: false, uri: { fsPath: path.join(root, 'appendix.tex') }, getText() { return this.text; }, get lineCount() { return this.text.split('\n').length; } };
  state.documents.set(doc.uri.fsPath, doc);
  session = new DocSession(doc as never, ctx, 'paper', 'appendix.tex', path.join(root, 'recovery'));
  session.parseCurrent();
});

describe('VS Code external source synchronization', () => {
  it('persists new drawing data before reparsing and updates strokes when the TeX anchor is unchanged', async () => {
    const base = model(initial);
    const data = JSON.stringify({ v: 1, strokes: [{ color: '#000000', w: 2, pts: [[0, 0, 0.5], [10, 20, 0.5]] }] });
    const incoming = structuredClone(base);
    (incoming.pmDoc as any).content[0].content.unshift({ type: 'sketch', attrs: { src: 'figures/sketch.svg', data } });
    await session.applyPmUpdate(incoming.pmDoc, incoming.headerLines, base);
    expect(fs.readFileSync(path.join(root, 'figures/sketch.svg'), 'utf8')).toBe(inkSvg(data));
    const current = session.parseCurrent();
    expect(JSON.stringify(current.pmDoc)).toContain('figures/sketch.svg');
    const nextBase = documentModel(current.pmDoc, current.headerLines);
    const next = structuredClone(nextBase);
    const edited = data.replace('[10,20,0.5]', '[30,40,0.5]');
    (next.pmDoc as any).content[0].content.find((node: any) => node.type === 'sketch').attrs.data = edited;
    const before = doc.text;
    await session.applyPmUpdate(next.pmDoc, next.headerLines, nextBase);
    expect(doc.text).toBe(before);
    expect(fs.readFileSync(path.join(root, 'figures/sketch.svg'), 'utf8')).toBe(inkSvg(edited));
    expect(JSON.stringify(session.parseCurrent().pmDoc)).toContain('30,40');
  });

  it('reopens a child buffer released when its separate editor tab closes', async () => {
    doc.isDirty = false;
    doc.isClosed = true;
    fs.writeFileSync(doc.uri.fsPath, revised);
    const reopened = { ...doc, text: revised, isClosed: false };
    state.documents.set(doc.uri.fsPath, reopened);
    expect(await session.syncFromDisk()).toBe(true);
    expect(session.document).toBe(reopened);
    expect(JSON.stringify(session.parseCurrent().pmDoc)).toContain('MSRJD derivation');
    expect(reopened.isDirty).toBe(false);
  });

  it('refreshes a reopened child with unsaved source edits even when disk is unchanged', async () => {
    doc.isDirty = false;
    doc.isClosed = true;
    const reopened = { ...doc, text: revised, isDirty: true, isClosed: false };
    state.documents.set(doc.uri.fsPath, reopened);
    expect(await session.syncFromDisk()).toBe(true);
    expect(session.document).toBe(reopened);
    expect(JSON.stringify(session.parseCurrent().pmDoc)).toContain('MSRJD derivation');
    expect(fs.readFileSync(doc.uri.fsPath, 'utf8')).toBe(initial);
  });

  it('lets VS Code reload a clean buffer without creating a dirty edit or stale save timestamp', async () => {
    doc.isDirty = false;
    fs.writeFileSync(doc.uri.fsPath, revised);
    const refreshing = session.syncFromDisk();
    expect(doc.text).toBe(initial);
    doc.text = revised;
    doc.version++;
    for (const listener of state.listeners) listener({ document: doc, contentChanges: [{}] });
    expect(await refreshing).toBe(true);
    expect(doc.version).toBe(2);
    expect(doc.isDirty).toBe(false);
    expect(doc.text).toBe(revised);
  });

  it('ignores an unchanged stale view after the file is replaced', async () => {
    const stale = model(initial);
    fs.writeFileSync(doc.uri.fsPath, revised);
    expect(await session.applyPmUpdate(stale.pmDoc, stale.headerLines, stale)).toBe(true);
    expect(doc.text).toBe(revised);
    expect(fs.readFileSync(doc.uri.fsPath, 'utf8')).toBe(revised);
  });

  it('refreshes an unsaved buffer and keeps an independent local edit', async () => {
    doc.text = initial.replace('Local notes.', 'Unsaved local notes.');
    fs.writeFileSync(doc.uri.fsPath, revised);
    expect(await session.syncFromDisk()).toBe(true);
    expect(doc.text).toContain('MSRJD derivation');
    expect(doc.text).toContain('Unsaved local notes.');
    expect(doc.text).not.toContain('Old directions');
    expect(doc.text.match(/An unchanged anchor/g)).toHaveLength(1);
    const drafts = fs.readdirSync(path.join(root, 'recovery'));
    expect(drafts).toHaveLength(1);
    expect(fs.readFileSync(path.join(root, 'recovery', drafts[0]), 'utf8')).toContain('Unsaved local notes.');
  });

  it('rebases a queued edit that was made before the external refresh arrived', async () => {
    const base = model(initial);
    const queued = model(initial.replace('Local notes.', 'Queued local notes.'));
    fs.writeFileSync(doc.uri.fsPath, revised);
    await session.syncFromDisk();
    session.parseCurrent();
    await session.applyPmUpdate(queued.pmDoc, queued.headerLines, base);
    expect(doc.text).toContain('MSRJD derivation');
    expect(doc.text).toContain('Queued local notes.');
    expect(doc.text).not.toContain('Replica derivation');
  });

  it('does not let a second stale editor put a deleted section back', async () => {
    const second = new DocSession(doc as never, ctx, 'paper', 'appendix.tex', path.join(root, 'recovery'));
    const stale = model(initial);
    second.parseCurrent();
    fs.writeFileSync(doc.uri.fsPath, revised);
    await session.syncFromDisk();
    await second.applyPmUpdate(stale.pmDoc, stale.headerLines, stale);
    expect(doc.text).toContain('MSRJD derivation');
    expect(doc.text).not.toContain('Replica derivation');
  });

  it('leaves both current file contents and an overlapping unsaved draft recoverable', async () => {
    const local = initial.replace('Old directions d and e.', 'Unsaved conflicting directions.');
    doc.text = local;
    fs.writeFileSync(doc.uri.fsPath, revised);
    await session.syncFromDisk();
    expect(doc.text).toContain('New normalized representation directions.');
    const draft = fs.readdirSync(path.join(root, 'recovery'))[0];
    expect(fs.readFileSync(path.join(root, 'recovery', draft), 'utf8')).toBe(local);
    expect(fs.readFileSync(doc.uri.fsPath, 'utf8')).toBe(revised);
  });

  it('refreshes the header and body of a cached webview without duplicating paragraphs', () => {
    const base = model(initial);
    const local = model(initial.replace('Local notes.', 'Pending local notes.'));
    const incoming = model(revised);
    incoming.headerLines.push('\\use_hyperref true');
    const merged = mergeModels(base, local, incoming);
    const text = JSON.stringify(merged.pmDoc);
    expect(text).toContain('MSRJD derivation');
    expect(text).toContain('Pending local notes.');
    expect(text).not.toContain('Replica derivation');
    expect(merged.headerLines).toContain('\\use_hyperref true');
    expect(text.match(/An unchanged anchor/g)).toHaveLength(1);
  });
});

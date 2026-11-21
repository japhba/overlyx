/**
 * Edits in neighbouring paragraphs while a document is open in the VS Code extension: what the user
 * types in one paragraph and what reaches the file in the next one (a co-author's change through the
 * synced clone, a local agent, git) both survive — in the webview's merge of the host's snapshot
 * (shared/documentModel.ts mergeModels), in the host's merge of the webview's update
 * (host/session.ts writePmUpdate) and of a file that changed under unsaved edits (readDisk). Before
 * 21 Nov 2026 core mergeLyx grew a region over touching changes and took the file's side for all of
 * it: the typing vanished (on the host side it went to a hidden recovery file).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lyxToPm, lyxAuthorId } from '@overlyx/core';

const state = vi.hoisted(() => ({ documents: new Map<string, { text: string; version: number }>(), listeners: new Set<(event: unknown) => void>() }));
vi.mock('vscode', () => ({
  Range: class { constructor(..._args: unknown[]) {} },
  EndOfLine: { LF: 1, CRLF: 2 },
  commands: { getCommands: async () => [] },
  WorkspaceEdit: class {
    edits: { uri: { fsPath: string }; text: string }[] = [];
    replace(uri: { fsPath: string }, _range: unknown, text: string) { this.edits.push({ uri, text }); }
  },
  workspace: {
    openTextDocument: async (uri: { fsPath: string }) => state.documents.get(uri.fsPath)!,
    onDidChangeTextDocument: (listener: (event: unknown) => void) => { state.listeners.add(listener); return { dispose: () => state.listeners.delete(listener) }; },
    applyEdit: async (edit: { edits: { uri: { fsPath: string }; text: string }[] }) => {
      for (const { uri, text } of edit.edits) { const doc = state.documents.get(uri.fsPath)!; doc.text = text; doc.version++; }
      return true;
    },
  },
}));
import { documentModel, mergeModels } from '../packages/vscode/src/shared/documentModel.ts';
import { parseDocumentText } from '../packages/vscode/src/host/texdoc.ts';
import { DocSession } from '../packages/vscode/src/host/session.ts';
import { LYX_LAYOUTS } from './lyxlib';

const tex = (...pars: string[]) => `\\documentclass{article}\n\\begin{document}\n${pars.join('\n\n')}\n\\end{document}\n`;
const original = ['First paragraph.', 'Second paragraph.', 'Third paragraph.', 'Fourth paragraph.'];
const initial = tex(...original);
const withPars = (change: Record<number, string>, insertAfter?: [number, string]) => {
  const ps = original.map((p, i) => change[i] ?? p);
  if (insertAfter) ps.splice(insertAfter[0] + 1, 0, insertAfter[1]);
  return tex(...ps);
};

let root: string;
let ctx: { root: string; layoutDir: string };
let doc: { text: string; version: number; isDirty: boolean; isClosed: boolean; uri: { fsPath: string }; eol: number; getText(): string; readonly lineCount: number };
let session: DocSession;
const model = (text: string) => { const parsed = parseDocumentText(text, ctx, 'main.tex'); return documentModel(lyxToPm(parsed.doc), parsed.doc.header.lines); };
const textOf = (m: ReturnType<typeof model>) => JSON.stringify(m.pmDoc);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'overlyx-neighbours-'));
  ctx = { root, layoutDir: LYX_LAYOUTS };
  fs.writeFileSync(path.join(root, 'main.tex'), initial);
  doc = { text: initial, version: 1, isDirty: false, isClosed: false, eol: 1, uri: { fsPath: path.join(root, 'main.tex') }, getText() { return this.text; }, get lineCount() { return this.text.split('\n').length; } };
  state.documents.set(doc.uri.fsPath, doc);
  session = new DocSession(doc as never, ctx, 'paper', 'main.tex', path.join(root, 'recovery'));
  session.parseCurrent();
});

describe('neighbouring paragraphs changed in the editor and in the file', () => {
  it('the webview keeps its typing when the host\'s snapshot changed the next paragraph', () => {
    const merged = textOf(mergeModels(model(initial), model(withPars({ 1: 'Second paragraph, typed in VS Code.' })), model(withPars({ 2: 'Third paragraph, changed on the server.' }))));
    expect(merged).toContain('typed in VS Code');
    expect(merged).toContain('changed on the server');
  });

  it('the webview keeps a new paragraph typed right before one the snapshot changed', () => {
    const merged = textOf(mergeModels(model(initial), model(withPars({}, [1, 'A new paragraph typed in VS Code.'])), model(withPars({ 2: 'Third paragraph, changed on the server.' }))));
    expect(merged).toContain('A new paragraph typed in VS Code.');
    expect(merged).toContain('changed on the server');
  });

  it('the same paragraph changed on both sides still takes the file\'s version (unchanged rule)', () => {
    const merged = textOf(mergeModels(model(initial), model(withPars({ 1: 'Second, typed in VS Code.' })), model(withPars({ 1: 'Second, changed on the server.' }))));
    expect(merged).toContain('changed on the server');
    expect(merged).not.toContain('typed in VS Code');
  });

  it('the host keeps the webview\'s update when the file changed the next paragraph meanwhile', async () => {
    const base = model(initial);
    // the synced clone wrote a co-author's change; VS Code reloaded the clean document
    const outside = withPars({ 2: 'Third paragraph, changed on the server.' });
    fs.writeFileSync(doc.uri.fsPath, outside);
    doc.text = outside; doc.version++;
    const update = model(withPars({ 1: 'Second paragraph, typed in VS Code.' }));
    const told: string[] = [];
    session.onDropped = draft => told.push(draft);
    const push = await session.applyPmUpdate(update.pmDoc, update.headerLines, base);
    expect(push).toBe(true);
    expect(doc.text).toContain('typed in VS Code');
    expect(doc.text).toContain('changed on the server');
    expect(told).toEqual([]);
  });

  it('unsaved typing survives a file change in the next paragraph (an agent or git wrote it)', async () => {
    doc.isDirty = true;
    doc.text = withPars({ 1: 'Second paragraph, typed in VS Code.' });
    fs.writeFileSync(doc.uri.fsPath, withPars({ 2: 'Third paragraph, changed by an agent.' }));
    expect(await session.syncFromDisk()).toBe(true);
    expect(doc.text).toContain('typed in VS Code');
    expect(doc.text).toContain('changed by an agent');
  });
});

describe('when the file\'s version replaced what was typed', () => {
  it('the user is told, with the draft that holds their version', async () => {
    const told: string[] = [];
    session.onDropped = draft => told.push(draft);
    doc.isDirty = true;
    doc.text = withPars({ 1: 'Second paragraph, typed in VS Code.' });
    fs.writeFileSync(doc.uri.fsPath, withPars({ 1: 'Second paragraph, changed by an agent.' }));
    expect(await session.syncFromDisk()).toBe(true);
    expect(doc.text).toContain('changed by an agent');
    expect(told).toHaveLength(1);
    expect(fs.readFileSync(told[0], 'utf8')).toContain('typed in VS Code');
  });

  it('nobody is told when both sides\' changes were kept', async () => {
    const told: string[] = [];
    session.onDropped = draft => told.push(draft);
    doc.isDirty = true;
    doc.text = withPars({ 1: 'Second paragraph, typed in VS Code.' });
    fs.writeFileSync(doc.uri.fsPath, withPars({ 2: 'Third paragraph, changed by an agent.' }));
    expect(await session.syncFromDisk()).toBe(true);
    const base = model(doc.text);
    const update = model(doc.text.replace('First paragraph.', 'First paragraph, typed on.'));
    fs.writeFileSync(doc.uri.fsPath, doc.text.replace('Fourth paragraph.', 'Fourth paragraph, changed again.'));
    await session.applyPmUpdate(update.pmDoc, update.headerLines, base);
    expect(doc.text).toContain('typed on');
    expect(doc.text).toContain('changed again');
    expect(told).toEqual([]);
  });

  it('the webview\'s update that lost its paragraph to the file is told too', async () => {
    const told: string[] = [];
    session.onDropped = draft => told.push(draft);
    const base = model(initial);
    const outside = withPars({ 1: 'Second paragraph, changed on the server.' });
    fs.writeFileSync(doc.uri.fsPath, outside);
    doc.text = outside; doc.version++;
    const update = model(withPars({ 1: 'Second paragraph, typed in VS Code.' }));
    expect(await session.applyPmUpdate(update.pmDoc, update.headerLines, base)).toBe(true);
    expect(doc.text).toContain('changed on the server');
    expect(told).toHaveLength(1);
  });
});

describe('the same paragraph changed in the editor and in the file, the author known', () => {
  const ada = { id: lyxAuthorId('Ada Lovelace', ''), name: 'Ada Lovelace' };

  it('the webview lays its typing over the file\'s version as Ada\'s tracked change', () => {
    const merged = textOf(mergeModels(model(initial), model(withPars({ 1: 'Second, typed in VS Code.' })), model(withPars({ 1: 'Second, changed on the server.' })), ada));
    expect(merged).toContain('typed in VS Code');
    expect(merged).toContain('changed on the server');
  });

  it('the host does the same with unsaved typing and a changed file: nothing lost, nobody sent to a draft', async () => {
    const told: string[] = [];
    let tracked = 0;
    session.onDropped = draft => told.push(draft);
    session.onTracked = () => { tracked++; };
    session.author = 'Ada Lovelace';
    doc.isDirty = true;
    doc.text = withPars({ 1: 'Second paragraph, typed in VS Code.' });
    fs.writeFileSync(doc.uri.fsPath, withPars({ 1: 'Second paragraph, changed by an agent.' }));
    expect(await session.syncFromDisk()).toBe(true);
    expect(doc.text).toMatch(/\\lyxdeleted\{Ada Lovelace\}/);
    expect(doc.text).toMatch(/\\lyxadded\{Ada Lovelace\}/);
    expect(doc.text).toContain('typed in VS Code');
    expect(doc.text).toContain('changed by an agent');
    expect(told).toEqual([]);
    expect(tracked).toBe(1);
  });

  it('and with the webview\'s update', async () => {
    session.author = 'Ada Lovelace';
    const base = model(initial);
    const outside = withPars({ 1: 'Second paragraph, changed on the server.' });
    fs.writeFileSync(doc.uri.fsPath, outside);
    doc.text = outside; doc.version++;
    const update = model(withPars({ 1: 'Second paragraph, typed in VS Code.' }));
    expect(await session.applyPmUpdate(update.pmDoc, update.headerLines, base)).toBe(true);
    expect(doc.text).toMatch(/\\lyxadded\{Ada Lovelace\}/);
    expect(doc.text).toContain('typed in VS Code');
    expect(doc.text).toContain('changed on the server');
  });
});

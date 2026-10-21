/**
 * An editor reconnects with offline edits (packages/server/src/offlinemerge.ts): with the base it
 * sent, the server keeps the live document as a version, lets the CRDT merge, and lays the places
 * both sides changed differently out for review — the live text with the offline version over it
 * as tracked changes by "<name> (offline)", noted in the CRDT's offlineMerges map.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as Y from 'yjs';
import type { WebSocket } from 'ws';

const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), 'overlyx-offline-merge-test');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'projects', 'u', 'p'), { recursive: true });
process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');
process.env.OVERLYX_PROJECTS_DIR = join(ROOT, 'projects');

const { manager } = await import('../packages/server/src/docs.ts');
const { offlineBase, applyClientUpdate, OFFLINE_MERGES } = await import('../packages/server/src/offlinemerge.ts');
const { applyLyxDocument } = await import('../packages/server/src/ydiff.ts');
const { db } = await import('../packages/server/src/db.ts');

afterAll(async () => { await manager.saveAll(); rmSync(ROOT, { recursive: true, force: true }); });

const PRE = '\\documentclass{article}\n\\begin{document}\n';
const POST = '\n\\end{document}\n';
const BODY = 'The first sentence is here. The second sentence follows it.\n\nAnother paragraph stays.';

/** a document on the server and an editor's copy of it, which then goes offline */
async function setup(name: string) {
  writeFileSync(join(ROOT, 'projects', 'u', 'p', name), PRE + BODY + POST);
  const doc = await manager.open(`u/p/${name}`);
  const editor = new Y.Doc();
  Y.applyUpdate(editor, Y.encodeStateAsUpdate(doc.ydoc));
  const base = Y.encodeStateAsUpdate(editor);
  const edit = (ydoc: Y.Doc, body: string) => applyLyxDocument(ydoc, doc.parse(PRE + body + POST), 'test');
  /** the editor reconnects: its base, then its sync step 2 */
  const reconnect = () => {
    const conn = {} as WebSocket;
    offlineBase(conn, base, 'Ada');
    applyClientUpdate(doc, conn, Y.encodeStateAsUpdate(editor, Y.encodeStateVector(doc.ydoc)), true);
  };
  const versions = () => (db.prepare('SELECT name FROM versions WHERE doc_id = ?').all(doc.id) as { name: string }[]).map(v => v.name);
  return { doc, editor, edit, reconnect, versions };
}

describe('offline edits merged on reconnect', () => {
  it('the same words changed on both sides: kept as the live text with the offline version as tracked changes', async () => {
    const s = await setup('conflict.tex');
    s.edit(s.editor, BODY.replace('is here', 'is everywhere'));          // offline
    s.edit(s.doc.ydoc, BODY.replace('is here', 'is there'));             // a co-author, meanwhile
    s.reconnect();
    const text = s.doc.toText();
    expect(text).toMatch(/\\lyxdeleted\{Ada \(offline\)\}\{[^}]*\}\{there\.\}/);
    expect(text).toMatch(/\\lyxadded\{Ada \(offline\)\}\{[^}]*\}\{everywhere\.\}/);
    const merges = [...s.doc.ydoc.getMap<string>(OFFLINE_MERGES).values()].map(v => JSON.parse(v));
    expect(merges).toHaveLength(1);
    // the paragraphs around stay as they were
    expect(text).toContain('}{everywhere.} The second sentence follows it.\n\nAnother paragraph stays.');
    expect(merges[0]).toMatchObject({ name: 'Ada', reviewer: 'Ada (offline)', conflicts: 1 });
    expect(s.versions()).toContain("before merging Ada's offline edits");
  });

  it('different words changed: merged without review, the live document kept as a version', async () => {
    const s = await setup('clean.tex');
    s.edit(s.editor, BODY.replace('follows it', 'follows it closely'));
    s.edit(s.doc.ydoc, BODY.replace('is here', 'is right here'));
    s.reconnect();
    const text = s.doc.toText();
    expect(text).toContain('The first sentence is right here. The second sentence follows it closely.');
    expect(text).not.toContain('\\lyxadded');
    expect(s.doc.ydoc.getMap(OFFLINE_MERGES).size).toBe(0);
    expect(s.versions()).toContain("before merging Ada's offline edits");
  });

  it('nobody else changed anything: the offline edits just go in', async () => {
    const s = await setup('alone.tex');
    s.edit(s.editor, BODY.replace('is here', 'is everywhere'));
    s.reconnect();
    expect(s.doc.toText()).toContain('The first sentence is everywhere.');
    expect(s.doc.ydoc.getMap(OFFLINE_MERGES).size).toBe(0);
    expect(s.versions()).not.toContain("before merging Ada's offline edits");
  });
});

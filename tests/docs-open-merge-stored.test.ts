/**
 * The merge a document's open makes when its stored state and the parse of the (unchanged) file
 * differ ("parser normalisation changed the structure — merging", docwork.ts loadOverStored) must
 * be stored. It was not (docs.ts openCold persisted only when the file's hash had changed), so every
 * restart made the same merge again as new operations, and an editor that had synced the previous
 * round brought that copy back: the text appeared twice, and the next save wrote it to the file.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as Y from 'yjs';

const ROOT = vi.hoisted(() => {
  const root = (process.env.TMPDIR ?? '/tmp') + '/overlyx-open-merge-stored-test';
  process.env.OVERLYX_DATA_DIR = root + '/data';
  process.env.OVERLYX_PROJECTS_DIR = root + '/projects';
  return root;
});
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'projects', 'u', 'p'), { recursive: true });

const { manager } = await import('../packages/server/src/docs.ts');
const { db } = await import('../packages/server/src/db.ts');

const docText = (...pars: string[]) => '\\documentclass{article}\n\\begin{document}\n' + pars.map(t => `${t}\n\n`).join('') + '\\end{document}\n';
const file = (name: string) => join(ROOT, 'projects', 'u', 'p', name);
const sync = (a: Y.Doc, b: Y.Doc, origin?: unknown) => {
  const ua = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)), ub = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a));
  Y.applyUpdate(b, ua, origin); Y.applyUpdate(a, ub, origin);
};
const storedAt = (id: string) => (db.prepare('SELECT updated_at FROM ydocs WHERE id = ?').get(id) as { updated_at: number }).updated_at;
const restart = (doc: unknown) => (manager as any).forgetDoc(doc);

describe('the merge made at open is stored', () => {
  it('a restart does not make it again, and a connected editor does not bring text back twice', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const sentence = 'a second sentence that the user deletes.';
    writeFileSync(file('b.tex'), docText('one', `two has ${sentence} It ends here.`, 'three'));
    const doc = await manager.open('u/p/b.tex');
    const editor = new Y.Doc();
    sync(editor, doc.ydoc);
    // the user deletes the sentence; the state is stored, but the process stops before the file is written
    doc.loadFromLyx(doc.parse(docText('one', 'two has It ends here.', 'three')), 'test');
    sync(editor, doc.ydoc);
    doc.persistState();
    restart(doc);

    // restart 1: the stored state differs from the file's parse: merged — and that merge stored
    const before = storedAt('u/p/b.tex');
    await new Promise(r => setTimeout(r, 5));
    const r1 = await manager.open('u/p/b.tex');
    expect(storedAt('u/p/b.tex')).toBeGreaterThan(before);
    sync(editor, r1.ydoc);
    await manager.saveAll();
    restart(r1);

    // restart 2: nothing to merge again; the editor that kept the first round resyncs
    const r2 = await manager.open('u/p/b.tex');
    sync(editor, r2.ydoc, 'test');
    const line = r2.toText().split('\n').find(l => l.startsWith('two'))!;
    expect(line.split(sentence).length - 1).toBeLessThanOrEqual(1);
    await r2.saveToFile();
    const fileLine = readFileSync(file('b.tex'), 'utf8').split('\n').find(l => l.startsWith('two'))!;
    expect(fileLine.split(sentence).length - 1).toBeLessThanOrEqual(1);
    restart(r2);
  });
});

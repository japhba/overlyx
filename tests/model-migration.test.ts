/**
 * Documents stored in the CRDT's model 1 (y-prosemirror's tree, before 20 Oct 2026) are converted
 * to model 2 when they are opened (server collabdoc.ts, docs.ts convertStored): the same document,
 * a new history (epoch), the old state kept; and a local copy an editor of model 1 kept — offline
 * edits the server never received — is merged into the document three-way (legacyMerge), or kept
 * as a version when there is nothing to merge it against.
 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as Y from 'yjs';
import { prosemirrorJSONToYXmlFragment } from 'y-prosemirror';

const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), `overlyx-migration-test-${process.pid}`);
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'projects', 'u', 'p'), { recursive: true });
process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');
process.env.OVERLYX_PROJECTS_DIR = join(ROOT, 'projects');
process.env.OVERLYX_DOC_WORKERS = '0';

const { manager } = await import('../packages/server/src/docs.ts');
const { db } = await import('../packages/server/src/db.ts');
const { schema, lyxToPm } = await import('@overlyx/core');
const { isModel2, hasModel1Content } = await import('@overlyx/core/collab/index.ts');
const { parseDocumentText } = await import('../packages/server/src/texdoc.ts');
const { sha1 } = await import('../packages/server/src/docwork.ts');

const HEAD = '\\documentclass{article}\n\\begin{document}\n';
const TAIL = '\\end{document}\n';
const docText = (...pars: string[]) => HEAD + pars.map(p => `${p}\n\n`).join('') + TAIL;

/** a stored state in model 1 for a file: what the server of before stored (and what an editor's local copy held) */
function model1State(project: string, rel: string, text: string): Uint8Array {
  const parsed = parseDocumentText(text, project, rel).doc;
  const ydoc = new Y.Doc();
  ydoc.transact(() => {
    prosemirrorJSONToYXmlFragment(schema, lyxToPm(parsed), ydoc.getXmlFragment('prosemirror'));
    const m = ydoc.getMap<string>('meta');
    m.set('preamble', JSON.stringify(parsed.preamble)); m.set('format', JSON.stringify(parsed.format));
    m.set('header', JSON.stringify(parsed.header.lines)); m.set('trailer', JSON.stringify(parsed.trailer));
  });
  return Y.encodeStateAsUpdate(ydoc);
}

function store(id: string, state: Uint8Array, fileText: string, epoch: string): void {
  const sha = sha1(fileText);
  db.prepare('INSERT INTO ydocs (id, state, file_hash, updated_at, epoch) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state, file_hash=excluded.file_hash, epoch=excluded.epoch').run(id, Buffer.from(state), sha, Date.now(), epoch);
}

describe('model 1 → model 2', () => {
  it('a stored model-1 state is converted on open: the same document, a new epoch, the old state kept', async () => {
    const text = docText('First paragraph with words.', 'Second paragraph.');
    const id = 'u/p/a.tex';
    writeFileSync(join(ROOT, 'projects', 'u', 'p', 'a.tex'), text);
    const old = model1State('u/p', 'a.tex', text);
    store(id, old, text, 'oldepoch');
    const doc = await manager.open(id);
    expect(isModel2(doc.ydoc)).toBe(true);
    expect(hasModel1Content(doc.ydoc)).toBe(false);
    expect(doc.epoch).not.toBe('oldepoch');
    expect(doc.toText()).toBe(text);
    const kept = db.prepare('SELECT state FROM ydocs_model1 WHERE id = ?').get(id) as { state: Buffer } | undefined;
    expect(kept?.state.length).toBe(old.length);
    // the stored state is model 2 from now on
    const row = db.prepare('SELECT state, epoch FROM ydocs WHERE id = ?').get(id) as { state: Buffer; epoch: string };
    expect(row.epoch).toBe(doc.epoch);
    const probe = new Y.Doc(); Y.applyUpdate(probe, new Uint8Array(row.state));
    expect(isModel2(probe)).toBe(true);
  });

  it('an old local copy with offline edits is merged in; one with nothing new changes nothing', async () => {
    const text = docText('Alpha paragraph.', 'Beta paragraph.', 'Gamma paragraph.');
    const id = 'u/p/b.tex';
    writeFileSync(join(ROOT, 'projects', 'u', 'p', 'b.tex'), text);
    const old = model1State('u/p', 'b.tex', text);
    store(id, old, text, 'oldepoch2');
    // an editor of model 1 had the document and edited it offline (the first paragraph)
    const copy = new Y.Doc();
    Y.applyUpdate(copy, old);
    copy.transact(() => {
      const p = copy.getXmlFragment('prosemirror').get(0) as Y.XmlElement;
      const t = p.toArray().find(x => x instanceof Y.XmlText) as Y.XmlText;
      t.insert(t.length, ' Written offline.');
    });
    const doc = await manager.open(id);
    // meanwhile somebody edited the third paragraph in model 2
    doc.loadFromLyx(doc.parse(docText('Alpha paragraph.', 'Beta paragraph.', 'Gamma paragraph, edited.')), 'test');
    const r = await manager.legacyMerge(id, Y.encodeStateAsUpdate(copy), 'Offline Author');
    expect(r.merged).toBe(true);
    expect(doc.toText()).toBe(docText('Alpha paragraph. Written offline.', 'Beta paragraph.', 'Gamma paragraph, edited.'));
    // the same copy again: nothing new
    const again = await manager.legacyMerge(id, Y.encodeStateAsUpdate(copy), 'Offline Author');
    expect(again.merged).toBe(false);
    expect(doc.toText()).toBe(docText('Alpha paragraph. Written offline.', 'Beta paragraph.', 'Gamma paragraph, edited.'));
  });

  it('without the old state to merge against, the copy is kept as a version', async () => {
    const text = docText('Only paragraph.');
    const id = 'u/p/c.tex';
    writeFileSync(join(ROOT, 'projects', 'u', 'p', 'c.tex'), text);
    const copyState = model1State('u/p', 'c.tex', docText('Only paragraph, changed offline.'));
    await manager.open(id);
    const r = await manager.legacyMerge(id, copyState, 'Offline Author');
    expect(r.merged).toBe(false);
    const versions = manager.listVersions(id);
    expect(versions.some(v => /offline changes by Offline Author/.test(v.name))).toBe(true);
    const v = versions.find(x => /offline changes/.test(x.name))!;
    expect(manager.getVersion(id, v.id)?.lyx).toContain('Only paragraph, changed offline.');
  });
});

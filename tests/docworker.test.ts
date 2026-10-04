/**
 * The document workers (packages/server/src/docpool.ts, docworker.ts): the whole-document work of
 * a save, an external change, an agent's edit and an open, done on a worker's mirror of the
 * document, gives the same bytes as the same work on the main thread; saves of one document stay
 * in order and never claim a state the file does not hold; a dead worker is replaced without
 * losing anything; and the pool gives each project one worker.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as Y from 'yjs';

const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), 'overlyx-docworker-test');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'projects', 'u'), { recursive: true });
process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');
process.env.OVERLYX_PROJECTS_DIR = join(ROOT, 'projects');
process.env.OVERLYX_DOC_WORKERS = '2';

const { manager, docWorkers } = await import('../packages/server/src/docs.ts');
const { DocWorkers } = await import('../packages/server/src/docpool.ts');
const { applyTrackedSource, applyPlainSource } = await import('../packages/server/src/docedit.ts');

type Doc = Awaited<ReturnType<typeof manager.open>>;
const TEMPLATES = join(import.meta.dirname, '..', 'packages', 'server', 'templates');
const HEAD = '\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\n';
const TAIL = '\\end{document}\n';
const docText = (...pars: string[]) => HEAD + pars.map(p => `${p}\n\n`).join('') + TAIL;
const path = (project: string, rel: string) => join(ROOT, 'projects', 'u', project, rel);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** tracked changes carry the second they were made: two runs differ only there */
const untimed = (t: string) => t.replace(/\\lyx(added|deleted)\{([^}]*)\}\{[^}]*\}/g, '\\lyx$1{$2}{T}');

/** Type into a paragraph's first text node, the way a client's update arrives. */
function type(doc: Doc, index: number, text: string): void {
  doc.ydoc.transact(() => {
    const p = doc.fragment.get(Math.min(index, doc.fragment.length - 1)) as Y.XmlElement;
    const t = p.toArray().find(x => x instanceof Y.XmlText) as Y.XmlText | undefined;
    if (t) t.insert(0, text);
    else { const n = new Y.XmlText(); n.insert(0, text); p.insert(0, [n]); }
  }, 'test-client');
}

/** The same file in two projects: one document's work is done in a worker, its twin's on the main thread. */
async function twins(name: string, text: string, files: Record<string, string> = {}): Promise<[Doc, Doc]> {
  for (const project of [`${name}-w`, `${name}-m`]) {
    mkdirSync(join(ROOT, 'projects', 'u', project), { recursive: true });
    writeFileSync(path(project, 'main.tex'), text);
    for (const [rel, t] of Object.entries(files)) writeFileSync(path(project, rel), t);
  }
  const w = await manager.open(`u/${name}-w/main.tex`);
  return [w, await onMain(`u/${name}-m/main.tex`)];
}

/** Open a document whose work is all done on the main thread (opening included). */
async function onMain(id: string): Promise<Doc> {
  const pool = docWorkers as unknown as { broken: boolean };
  pool.broken = true;
  try {
    const d = await manager.open(id);
    Object.defineProperty(d, 'usesWorker', { get: () => false });
    return d;
  } finally { pool.broken = false; }
}

beforeAll(() => {
  expect(docWorkers.enabled).toBe(true);
});
afterAll(async () => { await docWorkers.close(); });

describe('the worker writes what the main thread writes', () => {
  const fixtures: [string, string][] = [
    ['welcome', join(TEMPLATES, 'welcome', 'welcome.tex')],
    ['paper', join(TEMPLATES, 'starters', 'paper', 'paper.tex')],
    ['poster', join(TEMPLATES, 'starters', 'poster', 'poster.tex')],
    ['slides', join(TEMPLATES, 'starters', 'slides', 'slides.tex')],
  ];
  for (const [name, file] of fixtures) {
    it(`${name}: open, the text and its map, edits and saves give the same bytes`, async () => {
      const text = readFileSync(file, 'utf8');
      const [w, m] = await twins(name, text);
      expect(await w.textAsync()).toBe(m.toText());
      expect(await w.textMapAsync()).toEqual(m.toTextMap());
      for (let round = 0; round < 3; round++) {
        for (const d of [w, m]) { type(d, 3 + round * 5, `Round ${round} `); type(d, 1, 'x'); }
        const expected = m.toText();
        expect(await w.textAsync()).toBe(expected);
        expect(await w.saveToFile()).toBe(true);
        expect(await m.saveToFile()).toBe(true);
        expect(readFileSync(w.absPath, 'utf8')).toBe(readFileSync(m.absPath, 'utf8'));
        expect(readFileSync(w.absPath, 'utf8')).toBe(expected);
        expect(w.dirty).toBe(false);
      }
    });
  }

  it('a long document (built in steps by the worker) is the same document', async () => {
    const pars = Array.from({ length: 450 }, (_, i) => i % 50 === 0 ? `\\section{Part ${i}}` : i % 7 === 0 ? `\\begin{itemize}\n\\item one ${i}\n\\item two\n\\end{itemize}` : `Paragraph ${i} with $x_{${i}}$ and \\emph{words}.`);
    const [w, m] = await twins('long', docText(...pars));
    expect(w.fragment.toJSON()).toBe(m.fragment.toJSON());
    expect(await w.textAsync()).toBe(m.toText());
    for (const d of [w, m]) type(d, 300, 'Late in the document: ');
    expect(await w.saveToFile()).toBe(true);
    expect(await m.saveToFile()).toBe(true);
    expect(readFileSync(w.absPath, 'utf8')).toBe(readFileSync(m.absPath, 'utf8'));
  });

  it('a master includes its open child\'s live state (the child\'s mirror is in the same worker)', async () => {
    const child = '\\begin{equation}\n\\mathbb{R}\n\\end{equation}\n';
    const [w, m] = await twins('master', docText('Intro.', '\\input{child}', 'End.'), { 'child.tex': child });
    const cw = await manager.open('u/master-w/child.tex'), cm = await onMain('u/master-m/child.tex');
    // the child gets a list (enumitem-free), unsaved: only its live state has it
    for (const c of [cw, cm]) c.loadFromLyx(c.parse('\\begin{itemize}\n\\item one\n\\end{itemize}\n\\begin{equation}\n\\mathbb{R}\n\\end{equation}\n'), 'test-client');
    expect(await w.textAsync()).toBe(m.toText());
    for (const d of [w, m]) type(d, 0, 'Edited. ');
    expect(await w.saveToFile()).toBe(true);
    expect(await m.saveToFile()).toBe(true);
    expect(readFileSync(w.absPath, 'utf8')).toBe(readFileSync(m.absPath, 'utf8'));
  });

  it('a change on disk merged with unsaved edits gives the same document and file', async () => {
    const [w, m] = await twins('merge', docText('one', 'two', 'three', 'four'));
    for (const d of [w, m]) type(d, 3, 'typed here ');
    for (const d of [w, m]) writeFileSync(d.absPath, docText('one from git', 'two', 'three', 'four'));
    expect(await w.absorbExternalChangeAsync()).toBe(true);
    expect(m.absorbExternalChange()).toBe(true);
    expect(w.toText()).toBe(m.toText());
    expect(w.toText()).toContain('one from git');
    expect(w.toText()).toContain('typed here four');
    expect(await w.saveToFile()).toBe(true);
    expect(await m.saveToFile()).toBe(true);
    expect(readFileSync(w.absPath, 'utf8')).toBe(readFileSync(m.absPath, 'utf8'));
  });

  it('an agent\'s tracked edit and a plain one give the same document and file, and the same report', async () => {
    const [w, m] = await twins('agent', docText('First paragraph.', 'The second paragraph stays.', 'Third, with $x^2$.'));
    const before = m.toText();
    const after = before.replace('second paragraph', 'second, edited paragraph').replace('Third', 'The third');
    const { result: rw } = await w.agentEdit('tracked', before, { after }, { author: 'Bot (MCP)' });
    const rm = applyTrackedSource(m, before, after, 'Bot (MCP)');
    expect(rw.inserted).toBe(rm.inserted);
    expect(rw.deleted).toBe(rm.deleted);
    expect(rw.changed).toBe(true);
    expect(untimed(rw.after)).toBe(untimed(rm.after));
    await m.saveToFile();
    expect(untimed(readFileSync(w.absPath, 'utf8'))).toBe(untimed(readFileSync(m.absPath, 'utf8')));
    expect(readFileSync(w.absPath, 'utf8')).toContain('\\lyxadded');
    // the edit is in the file when the call returns, and the save after it wrote the worker's text as is
    expect(w.dirty).toBe(false);

    const b2 = m.toText(), a2 = b2.replace('First paragraph.', 'First paragraph, plainly.');
    const { result: pw } = await w.agentEdit('plain', null, { replace: { oldText: 'First paragraph.', newText: 'First paragraph, plainly.', all: false } });
    const pm = applyPlainSource(m, b2, a2);
    await m.saveToFile();
    expect(pw.changed).toBe(pm.changed);
    expect(untimed(readFileSync(w.absPath, 'utf8'))).toBe(untimed(readFileSync(m.absPath, 'utf8')));
    // a passage that is not there: the agent gets the message, not a worker's stack trace
    await expect(w.agentEdit('tracked', null, { replace: { oldText: 'No such passage', newText: 'x', all: false } }, { author: 'Bot (MCP)' }))
      .rejects.toThrow(/^old_text was not found in the document/);
  });

  it('the editor\'s metadata (macros, labels, cited keys, layouts, health) is the same', async () => {
    const text = readFileSync(join(TEMPLATES, 'welcome', 'welcome.tex'), 'utf8');
    const [w, m] = await twins('meta', text, { 'refs.bib': readFileSync(join(TEMPLATES, 'welcome', 'refs.bib'), 'utf8') });
    const strip = ({ timings: _t, ...rest }: Awaited<ReturnType<typeof w.metaAsync>>) => rest;
    const mw = strip(await w.metaAsync()), mm = strip(await m.metaAsync());
    expect(mw).toEqual(mm);
    expect(mw.labels.length + mw.macroList.length + mw.citedKeys.length).toBeGreaterThan(0);
  });

  it('loaded source, read_document\'s paragraphs and parse warnings are the same', async () => {
    const [w, m] = await twins('source', docText('A.', 'B.'));
    const src = docText('A, rewritten by hand.', 'B.', '\\unknownmacro{C}');
    const ww = await w.loadText(src, 'source');
    const wm = await m.loadText(src, 'source');
    expect(ww).toEqual(wm);
    expect(w.toText()).toBe(m.toText());
    expect(await w.readAsync()).toEqual(await m.readAsync());
    expect(await w.parseWarnings(src)).toEqual(await m.parseWarnings(src));
  });

  it('a document opened again from its stored state is the same as on the main thread', async () => {
    const [w, m] = await twins('reopen', docText('Stored.', 'State.'));
    for (const d of [w, m]) type(d, 1, 'Unsaved but persisted. ');
    await w.persistStateAsync(); m.persistState();
    // the file changes while the documents are closed (they were saved when they were)
    for (const d of [w, m]) { await manager.unload(d.id); writeFileSync(d.absPath, docText('Stored, changed on disk.', 'Unsaved but persisted. State.')); }
    const w2 = await manager.open(w.id), m2 = await onMain(m.id);
    expect(w2).not.toBe(w);
    expect(w2.toText()).toBe(m2.toText());
    expect(w2.toText()).toContain('Stored, changed on disk.');
  });

  it('a paragraph split on disk while closed, then typed into by a client that had not seen it: the mirror gets the repair', async () => {
    const [w] = await twins('splitdisk', docText('Alpha beta gamma delta epsilon. Zeta eta theta iota kappa lambda mu nu xi omicron.', 'Closing.'));
    // a client with the document, offline from now on
    const client = new Y.Doc();
    Y.applyUpdate(client, Y.encodeStateAsUpdate(w.ydoc));
    await w.persistStateAsync();
    await manager.unload(w.id);
    writeFileSync(w.absPath, docText('Alpha beta gamma delta epsilon.', 'Zeta eta theta iota kappa lambda mu nu xi omicron.', 'Closing.'));
    // opened over the stored state: the worker's diff copies the second half (and records it), the
    // main thread restates the record (an update of its own)
    const w2 = await manager.open(w.id);
    expect(w2.ydoc.getMap('moves').size).toBe(1);
    const text = (client.getXmlFragment('prosemirror').get(0) as Y.XmlElement).toArray().find(x => x instanceof Y.XmlText) as Y.XmlText;
    client.transact(() => text.insert(text.toString().indexOf('lambda'), 'LATE '), 'client');
    w2.moves.receive(Y.encodeStateAsUpdate(client, Y.encodeStateVector(w2.ydoc)), {}, { step2: true, knows: Y.decodeStateVector(Y.encodeStateVector(client)) });
    // the late word goes where it was typed, in the new paragraph; the worker writes what the document holds
    expect(w2.toText()).toContain('\nZeta eta theta iota kappa LATE lambda mu nu xi omicron.\n');
    expect(await w2.textAsync()).toBe(w2.toText());
  });
});

describe('saves of one document', () => {
  it('run one at a time and resolve once the file holds the state they were asked for', async () => {
    const [d] = await twins('order', docText('one', 'two', 'three'));
    const asAny = d as unknown as { renderAsync: () => Promise<{ text: string }> };
    const orig = asAny.renderAsync.bind(d);
    let running = 0, most = 0;
    asAny.renderAsync = async () => { running++; most = Math.max(most, running); await sleep(150); try { return await orig(); } finally { running--; } };
    try {
      type(d, 0, 'A ');
      const s1 = d.saveToFile();
      await sleep(20);
      type(d, 1, 'B ');   // arrives while the first save makes its text
      const s2 = d.saveToFile();
      type(d, 2, 'C ');
      const s3 = d.saveToFile();
      expect(await s1).toBe(true);
      expect(await s2).toBe(true);
      expect(await s3).toBe(true);
      expect(most).toBe(1);
      const onDisk = readFileSync(d.absPath, 'utf8');
      expect(onDisk).toContain('A one');
      expect(onDisk).toContain('B two');
      expect(onDisk).toContain('C three');
      expect(d.dirty).toBe(false);
    } finally { asAny.renderAsync = orig; }
  });

  it('an edit made while the text is made leaves the document dirty, and the ack covers only what was written', async () => {
    const [d] = await twins('ack', docText('one', 'two'));
    const asAny = d as unknown as { renderAsync: () => Promise<{ text: string }> };
    const orig = asAny.renderAsync.bind(d);
    asAny.renderAsync = async () => { const r = await orig(); type(d, 1, 'late '); return r; };
    try {
      type(d, 0, 'early ');
      expect(await d.saveToFile()).toBe(true);
    } finally { asAny.renderAsync = orig; }
    expect(readFileSync(d.absPath, 'utf8')).toContain('early one');
    expect(readFileSync(d.absPath, 'utf8')).not.toContain('late two');
    expect(d.dirty).toBe(true);
    // the acknowledged state vector is the one before the late edit
    expect(Y.encodeStateVector(d.ydoc)).not.toEqual(d.lastSavedSV);
    expect(await d.saveToFile()).toBe(true);
    expect(readFileSync(d.absPath, 'utf8')).toContain('late two');
    expect(Y.encodeStateVector(d.ydoc)).toEqual(d.lastSavedSV);
  });

  it('never replaces the file with something that is not a document', async () => {
    const [d] = await twins('garbage', docText('keep me'));
    const asAny = d as unknown as { renderAsync: () => Promise<{ text: string; files: Record<string, string>; spans: [] }> };
    const orig = asAny.renderAsync.bind(d);
    asAny.renderAsync = async () => ({ text: '', files: {}, spans: [] });
    type(d, 0, 'x');
    try { expect(await d.saveToFile()).toBe(false); } finally { asAny.renderAsync = orig; }
    expect(d.saveError).toMatch(/not a document/);
    expect(readFileSync(d.absPath, 'utf8')).toBe(docText('keep me'));
    expect(await d.saveToFile()).toBe(true);
    expect(readFileSync(d.absPath, 'utf8')).toContain('xkeep me');
  });

  it('a file deleted while the text is made is not re-created', async () => {
    const [d] = await twins('deleted', docText('soon gone'));
    const asAny = d as unknown as { renderAsync: () => Promise<{ text: string }> };
    const orig = asAny.renderAsync.bind(d);
    asAny.renderAsync = async () => { const r = await orig(); unlinkSync(d.absPath); return r; };
    type(d, 0, 'x');
    try { expect(await d.saveToFile()).toBe(false); } finally { asAny.renderAsync = orig; }
    expect(existsSync(d.absPath)).toBe(false);
    expect(d.fileMissing).toBe(true);
  });

  it('a change written to the file while the text is made is merged, not written over', async () => {
    const [d, m] = await twins('race', docText('one', 'two', 'three'));
    const asAny = d as unknown as { renderAsync: () => Promise<{ text: string }> };
    const orig = asAny.renderAsync.bind(d);
    let once = true;
    const other = docText('one from another editor', 'two', 'three');
    asAny.renderAsync = async () => { const r = await orig(); if (once) { once = false; writeFileSync(d.absPath, other); } return r; };
    type(d, 2, 'typed ');
    try { expect(await d.saveToFile()).toBe(true); } finally { asAny.renderAsync = orig; }
    const onDisk = readFileSync(d.absPath, 'utf8');
    expect(onDisk).toContain('one from another editor');
    expect(onDisk).toContain('typed three');
    // as the main thread merges it
    type(m, 2, 'typed ');
    writeFileSync(m.absPath, other);
    expect(await m.saveToFile()).toBe(true);
    expect(readFileSync(m.absPath, 'utf8')).toBe(onDisk);
  });
});

describe('a worker that dies', () => {
  it('is replaced; the mirrors are rebuilt from the main thread and nothing is lost', async () => {
    const [d, m] = await twins('crash', docText('one', 'two', 'three'));
    for (const x of [d, m]) type(x, 0, 'before ');
    expect(await d.textAsync()).toBe(m.toText());
    const slots = (docWorkers as unknown as { slots: { worker: { terminate(): Promise<number> } | null; gen: number }[] }).slots;
    const slot = docWorkers.slotOf(d.project);
    const gen = slots[slot].gen;
    const pending = d.textAsync();   // in the worker as it dies
    await slots[slot].worker!.terminate();
    for (const x of [d, m]) type(x, 2, 'after ');
    expect(await pending).toContain('before one');   // sent again to the new worker
    expect(slots[slot].gen).toBe(gen + 1);
    expect(await d.saveToFile()).toBe(true);
    await m.saveToFile();
    expect(readFileSync(d.absPath, 'utf8')).toBe(readFileSync(m.absPath, 'utf8'));
    expect(readFileSync(d.absPath, 'utf8')).toContain('after three');
  });
});

describe('a client connecting while its document opens', () => {
  it('gets the document: what it sent meanwhile (its sync step 1) is answered once the document is open', async () => {
    const http = await import('node:http');
    const { WebSocket } = await import('ws');
    const syncProtocol = await import('y-protocols/sync');
    const encoding = await import('lib0/encoding');
    const decoding = await import('lib0/decoding');
    const { attachWebSocket } = await import('../packages/server/src/ws.ts');
    const { createUser, toSessionUser, signSession } = await import('../packages/server/src/auth.ts');
    const { registerProject } = await import('../packages/server/src/access.ts');
    const user = createUser('wsuser', 'WS User', 'pw');
    registerProject('u/wsopen', user.id);
    mkdirSync(join(ROOT, 'projects', 'u', 'wsopen'), { recursive: true });
    writeFileSync(path('wsopen', 'main.tex'), docText('Hello from the file.'));
    const server = http.createServer();
    attachWebSocket(server);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    // the open takes a while (a big document's parse in the worker)
    const open = manager.open.bind(manager);
    manager.open = async (id: string) => { await sleep(300); return open(id); };
    try {
      const client = new Y.Doc();
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?doc=${encodeURIComponent('u/wsopen/main.tex')}`, { headers: { cookie: `ol_session=${signSession(toSessionUser(user))}` } });
      ws.binaryType = 'arraybuffer';
      const synced = new Promise<void>((resolve) => {
        ws.on('message', (data: ArrayBuffer) => {
          const dec = decoding.createDecoder(new Uint8Array(data));
          if (decoding.readVarUint(dec) !== 0) return;
          const enc = encoding.createEncoder();
          if (syncProtocol.readSyncMessage(dec, enc, client, 'server') === syncProtocol.messageYjsSyncStep2) resolve();
        });
      });
      // like y-websocket: sync step 1 as soon as the socket is open — before the server has the document
      ws.on('open', () => { const enc = encoding.createEncoder(); encoding.writeVarUint(enc, 0); syncProtocol.writeSyncStep1(enc, client); ws.send(encoding.toUint8Array(enc)); });
      await Promise.race([synced, sleep(10000).then(() => { throw new Error('no sync step 2'); })]);
      expect(JSON.stringify(client.getXmlFragment('prosemirror').toJSON())).toContain('Hello from the file.');
      ws.close();
      // a big document: what the client lacks is encoded by the worker — the same update
      const pars = Array.from({ length: 1200 }, (_, i) => `Paragraph ${i} of a long thesis, with $x_${i}$ and some words to make it longer than it is.`);
      writeFileSync(path('wsopen', 'big.tex'), docText(...pars));
      const big = await open('u/wsopen/big.tex');
      expect(big.bigForSync).toBe(true);
      const sv = Y.encodeStateVector(new Y.Doc());
      const viaWorker = await big.missingFor(sv);
      const other = new Y.Doc();
      Y.applyUpdate(other, viaWorker);
      expect(other.getXmlFragment('prosemirror').toJSON()).toBe(big.fragment.toJSON());
      const client2 = new Y.Doc();
      const ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws?doc=${encodeURIComponent('u/wsopen/big.tex')}`, { headers: { cookie: `ol_session=${signSession(toSessionUser(user))}` } });
      ws2.binaryType = 'arraybuffer';
      const synced2 = new Promise<void>((resolve) => {
        ws2.on('message', (data: ArrayBuffer) => {
          const dec = decoding.createDecoder(new Uint8Array(data));
          if (decoding.readVarUint(dec) !== 0) return;
          if (syncProtocol.readSyncMessage(dec, encoding.createEncoder(), client2, 'server') === syncProtocol.messageYjsSyncStep2) resolve();
        });
      });
      ws2.on('open', () => { const enc = encoding.createEncoder(); encoding.writeVarUint(enc, 0); syncProtocol.writeSyncStep1(enc, client2); ws2.send(encoding.toUint8Array(enc)); });
      await Promise.race([synced2, sleep(20000).then(() => { throw new Error('no sync step 2 for the big document'); })]);
      expect(client2.getXmlFragment('prosemirror').toJSON()).toBe(big.fragment.toJSON());
      ws2.close();
    } finally {
      manager.open = open;
      server.close();
    }
  }, 60000);
});

describe('the pool', () => {
  it('gives each project one worker, the least busy one, and frees it when the project closes', () => {
    const pool = new DocWorkers(3);
    expect([pool.slotOf('a/x'), pool.slotOf('a/y'), pool.slotOf('a/z')].sort()).toEqual([0, 1, 2]);
    expect(pool.slotOf('a/x')).toBe(pool.slotOf('a/x'));
    const y = pool.slotOf('a/y');
    pool.release('a/y');
    expect(pool.slotOf('b/new')).toBe(y);
    expect(new DocWorkers(0).enabled).toBe(false);
  });

});

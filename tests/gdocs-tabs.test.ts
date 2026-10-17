/**
 * Google Docs with tabs (server/src/gdocs/: model.ts tabs, edits.ts inTab, sync.ts links to tabs,
 * importing.ts) against the simulation of the Docs and Drive APIs (gdocs/fake.ts): importing a Google
 * Doc with tabs makes a document group (a folder with a document per tab, core/docgroup.ts) that the
 * file listing shows; each document syncs with its own tab only — edits both ways, comments to the
 * tab whose text they quote; a tab made in Google Docs later becomes a document of the group; linking
 * a document to a Google Doc that exists brings the Google Doc's differences as tracked changes.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = vi.hoisted(() => {
  const root = (process.env.OVERLYX_SCRATCH || process.env.TMPDIR || '/tmp') + '/overlyx-gdocs-tabs-test';
  process.env.OVERLYX_DATA_DIR = root + '/data';
  process.env.OVERLYX_PROJECTS_DIR = root + '/projects';
  return root;
});
import { inTab } from '../packages/server/src/gdocs/edits.ts';
import { flatTabs, tabDocument } from '../packages/server/src/gdocs/model.ts';
import { FakeGoogle } from '../packages/server/src/gdocs/fake.ts';
import { parseDocGroup, GROUP_MANIFEST } from '../packages/core/src/docgroup.ts';

describe('requests aimed at a tab (edits.ts inTab)', () => {
  it('names the tab in every location and range, a footnote\'s too, and leaves the rest', () => {
    const reqs = [
      { insertText: { location: { index: 5 }, text: 'x' } },
      { deleteContentRange: { range: { startIndex: 1, endIndex: 3 } } },
      { updateParagraphStyle: { range: { startIndex: 1, endIndex: 9 }, paragraphStyle: { namedStyleType: 'HEADING_1' }, fields: 'namedStyleType' } },
      { insertText: { location: { segmentId: 'kix.fn1', index: 0 }, text: 'note' } },
      { createParagraphBullets: { range: { startIndex: 1, endIndex: 4 }, bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE' } },
    ];
    const aimed = inTab(reqs, 't.7') as typeof reqs;
    expect(aimed[0].insertText!.location).toEqual({ index: 5, tabId: 't.7' });
    expect((aimed[1] as any).deleteContentRange.range).toEqual({ startIndex: 1, endIndex: 3, tabId: 't.7' });
    expect((aimed[2] as any).updateParagraphStyle.paragraphStyle).toEqual({ namedStyleType: 'HEADING_1' });
    expect((aimed[2] as any).updateParagraphStyle.range.tabId).toBe('t.7');
    expect((aimed[3] as any).insertText.location).toEqual({ segmentId: 'kix.fn1', index: 0, tabId: 't.7' });
    expect((aimed[4] as any).createParagraphBullets.bulletPreset).toBe('BULLET_DISC_CIRCLE_SQUARE');
    expect(reqs[0].insertText!.location).toEqual({ index: 5 });   // the original requests are not changed
  });
});

describe('a Google Doc with tabs (the simulation)', () => {
  it('reads every tab with its own body, nested ones under their parent; a request goes to the tab it names', async () => {
    const g = new FakeGoogle();
    const f = await g.createDocument('Grant');
    g.tabs.get(f.id)![0].title = 'Summary';
    const aims = g.addTab(f.id, 'Aims');
    const sub = g.addTab(f.id, 'Aim 1', aims);
    g.tabDoc(f.id, aims).insertText(1, 'The aims.');
    await g.batchUpdate(f.id, [{ insertText: { location: { index: 1, tabId: sub }, text: 'First aim.' } }]);
    const whole = await g.getDocumentTabs(f.id);
    expect(flatTabs(whole)).toEqual([
      { id: 't.0', title: 'Summary', level: 0, parent: null },
      { id: aims, title: 'Aims', level: 0, parent: null },
      { id: sub, title: 'Aim 1', level: 1, parent: aims },
    ]);
    expect(g.tabDoc(f.id, sub).text()).toBe('First aim.');
    expect(g.doc(f.id).text()).toBe('');
    expect(JSON.stringify(tabDocument(whole, aims)!.body)).toContain('The aims.');
    expect(tabDocument(whole, 'nope')).toBeNull();
  });
});

describe('importing and syncing a Google Doc with tabs', async () => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(ROOT, 'projects', 'u', 'p'), { recursive: true });
  const { config } = await import('../packages/server/src/config.ts');
  if (!config.dataDir.startsWith(ROOT)) throw new Error('the test would use the real data directory: ' + config.dataDir);
  const { manager } = await import('../packages/server/src/docs.ts');
  const sync = await import('../packages/server/src/gdocs/sync.ts');
  const { importGoogleDoc } = await import('../packages/server/src/gdocs/importing.ts');
  const { collect } = await import('../packages/server/src/projectfiles.ts');
  const g = new FakeGoogle();
  sync.setGoogleApiFactory(() => g);
  const { createUser } = await import('../packages/server/src/auth.ts');
  const { registerProject } = await import('../packages/server/src/access.ts');
  const owner = createUser('u', 'U', null);
  registerProject('u/p', owner.id);
  const P = join(ROOT, 'projects', 'u', 'p');
  let fileId = '', aims = '', sub = '';
  let docs: string[] = [];
  const md = (rel: string) => readFileSync(join(P, rel), 'utf8');

  beforeAll(async () => {
    const f = await g.createDocument('Grant proposal');
    fileId = f.id;
    g.tabs.get(f.id)![0].title = 'Summary';
    g.tabDoc(f.id).insertText(1, 'We study latent reasoning.\nIt matters.');
    aims = g.addTab(f.id, 'Aims');
    g.tabDoc(f.id, aims).insertText(1, 'Aims overview\nThe aims follow.');
    await g.batchUpdate(f.id, [{ updateParagraphStyle: { range: { startIndex: 1, endIndex: 14, tabId: aims }, paragraphStyle: { namedStyleType: 'HEADING_1' }, fields: 'namedStyleType' } }]);
    sub = g.addTab(f.id, 'Aim 1: decoding', aims);
    g.tabDoc(f.id, sub).insertText(1, 'Decode the thoughts.');
    const r = await importGoogleDoc('u/p', '', fileId, owner.id);
    docs = r.docs;
    expect(r.group).toBe('Grant proposal');
  });

  it('becomes a document group: a folder with a document per tab, in tab order, titled and nested like the tabs', () => {
    const group = parseDocGroup(readFileSync(join(P, 'Grant proposal', GROUP_MANIFEST), 'utf8'))!;
    expect(group).toEqual({ version: 1, title: 'Grant proposal', members: [
      { file: 'Summary.md', title: 'Summary' },
      { file: 'Aims.md', title: 'Aims' },
      { file: 'Aim 1 decoding.md', title: 'Aim 1: decoding', level: 1 },
    ] });
    expect(docs).toEqual(['u/p/Grant proposal/Summary.md', 'u/p/Grant proposal/Aims.md', 'u/p/Grant proposal/Aim 1 decoding.md']);
    expect(md('Grant proposal/Summary.md')).toBe('We study latent reasoning.\n\nIt matters.\n');
    expect(md('Grant proposal/Aims.md')).toBe('# Aims overview\n\nThe aims follow.\n');
    expect(docs.map(d => sync.linkOf(d)!.tab_id)).toEqual(['t.0', aims, sub]);
    // the file listing shows the folder as the group
    const dir = collect(P, P, [], 0).find(f => f.path === 'Grant proposal')!;
    expect(dir.kind).toBe('dir');
    expect(dir.group?.members.map(m => m.file)).toEqual(['Summary.md', 'Aims.md', 'Aim 1 decoding.md']);
  });

  it('the import changes nothing in the Google Doc', async () => {
    const before = g.batches;
    for (const d of docs) expect((await sync.syncDoc(d)).pushed).toBe(0);
    expect(g.batches).toBe(before);
  });

  it('an edit in one tab comes back as a tracked change in its document only', async () => {
    const at = g.indexOf(fileId, 'The aims', aims);
    await g.batchUpdate(fileId, [{ insertText: { location: { index: at, tabId: aims }, text: 'Now ' } }], undefined, 'Kirsten');
    const summary = md('Grant proposal/Summary.md');
    for (const d of docs) await sync.syncDoc(d);
    expect(md('Grant proposal/Aims.md')).toMatch(/<ins author="Kirsten \(Google Docs\)" datetime="[^"]+">Now<\/ins> The aims follow\./);
    expect(md('Grant proposal/Summary.md')).toBe(summary);
  });

  it('an edit here goes to its own tab only', async () => {
    const id = docs[2];
    const doc = await manager.open(id);
    const lyx = doc.toLyxDocument();
    lyx.body[0].items = [{ kind: 'text', text: 'Decode the latent thoughts.', font: {} }];
    doc.loadFromLyx(lyx, 'test');
    await doc.saveToFile();
    await sync.syncDoc(id);
    expect(g.tabDoc(fileId, sub).text()).toBe('Decode the latent thoughts.');
    expect(g.doc(fileId).text()).toBe('We study latent reasoning.\nIt matters.');
    const reqs = g.requests.at(-1)!;
    expect(reqs.every(r => JSON.stringify(r).includes(`"tabId":"${sub}"`))).toBe(true);
  });

  it('a Google comment goes to the document of the tab whose text it quotes, once', async () => {
    const at = g.indexOf(fileId, 'It matters', 't.0');
    g.comment(fileId, at, at + 'It matters'.length, 'Does it?', 'Kirsten', 't.0');
    for (const d of docs) await sync.syncDoc(d);
    for (const d of docs) await sync.syncDoc(d);
    expect(md('Grant proposal/Summary.md')).toMatch(/It matters<!-- @comment\n +Kirsten \([^)]+\):\n +Does it\?\n +-->\./);
    expect(md('Grant proposal/Aims.md')).not.toContain('Does it?');
    expect(md('Grant proposal/Aim 1 decoding.md')).not.toContain('Does it?');
  });

  it('a thread written here becomes a comment anchored in its own tab', async () => {
    const id = docs[1];
    const doc = await manager.open(id);
    const lyx = doc.toLyxDocument();
    const p = lyx.body.find(x => x.items.some(i => i.kind === 'text' && i.text.includes('aims follow')))!;
    p.items.push({ kind: 'inset', font: {}, inset: { type: 'Text', name: 'Note', arg: 'Comment', params: [], status: 'open', paragraphs: [
      { layout: 'Plain Layout', depth: 0, params: {}, items: [{ kind: 'text', text: 'Jan (2026-10-14 11:00):', font: {} }] },
      { layout: 'Plain Layout', depth: 0, params: {}, items: [{ kind: 'text', text: 'Shorter?', font: {} }] },
    ] } });
    doc.loadFromLyx(lyx, 'test');
    await doc.saveToFile();
    await sync.syncDoc(id);
    const made = g.comments.get(fileId)!.at(-1)!;
    expect(made.content).toBe('Jan: Shorter?');
    expect(g.anchored(fileId, made.id)).toBe(true);
    // and the other tabs' documents do not take it back as a comment of theirs
    for (const d of docs) await sync.syncDoc(d);
    expect(md('Grant proposal/Summary.md')).not.toContain('Shorter?');
  });

  it('a tab made in Google Docs later becomes a document of the group', async () => {
    const extra = g.addTab(fileId, 'Budget');
    g.tabDoc(fileId, extra).insertText(1, 'Two GPUs.');
    const r = await sync.syncDoc(docs[0]);
    expect(r.notes.join('\n')).toContain('New tab “Budget”');
    expect(r.warnings).toEqual([]);
    expect(md('Grant proposal/Budget.md')).toBe('Two GPUs.\n');
    expect(sync.linkOf('u/p/Grant proposal/Budget.md')!.tab_id).toBe(extra);
    const group = parseDocGroup(readFileSync(join(P, 'Grant proposal', GROUP_MANIFEST), 'utf8'))!;
    expect(group.members.map(m => m.file)).toEqual(['Summary.md', 'Aims.md', 'Aim 1 decoding.md', 'Budget.md']);
    // a renamed tab: the group shows the new title, the file keeps its name
    g.tabs.get(fileId)!.find(t => t.id === aims)!.title = 'Specific aims';
    g.doc(fileId).revision++;
    await sync.syncDoc(docs[1]);
    expect(parseDocGroup(readFileSync(join(P, 'Grant proposal', GROUP_MANIFEST), 'utf8'))!.members[1]).toEqual({ file: 'Aims.md', title: 'Specific aims' });
    expect(existsSync(join(P, 'Grant proposal', 'Aims.md'))).toBe(true);
  });

  it('a tab\'s document deleted here stays deleted: its tab is not synced back in as "Budget 2.md"; a renamed one keeps its link', async () => {
    const { groupFileMoved } = await import('../packages/server/src/docgroups.ts');
    // deleted in the explorer (index.ts fileops): the file goes, its link and its group entry with it
    rmSync(join(P, 'Grant proposal', 'Budget.md'));
    sync.filesMoved('u/p', 'Grant proposal/Budget.md', null); groupFileMoved('u/p', 'Grant proposal/Budget.md', null);
    expect(sync.linkOf('u/p/Grant proposal/Budget.md')).toBeNull();
    g.doc(fileId).revision++;
    const r = await sync.syncDoc(docs[0]);
    expect(r.notes).toEqual([]);
    expect(existsSync(join(P, 'Grant proposal', 'Budget 2.md'))).toBe(false);
    expect(parseDocGroup(readFileSync(join(P, 'Grant proposal', GROUP_MANIFEST), 'utf8'))!.members.map(m => m.file)).toEqual(['Summary.md', 'Aims.md', 'Aim 1 decoding.md']);
    // renamed in the explorer: still synced, still in the group, under its new name
    const { renameSync } = await import('node:fs');
    renameSync(join(P, 'Grant proposal', 'Aims.md'), join(P, 'Grant proposal', 'Specific aims.md'));
    sync.filesMoved('u/p', 'Grant proposal/Aims.md', 'Grant proposal/Specific aims.md'); groupFileMoved('u/p', 'Grant proposal/Aims.md', 'Grant proposal/Specific aims.md');
    expect(sync.linkOf('u/p/Grant proposal/Specific aims.md')!.tab_id).toBe(aims);
    g.doc(fileId).revision++;
    expect((await sync.syncDoc(docs[0])).notes).toEqual([]);
    expect(existsSync(join(P, 'Grant proposal', 'Aims 2.md'))).toBe(false);
    expect(parseDocGroup(readFileSync(join(P, 'Grant proposal', GROUP_MANIFEST), 'utf8'))!.members.map(m => m.file)).toEqual(['Summary.md', 'Specific aims.md', 'Aim 1 decoding.md']);
    docs[1] = 'u/p/Grant proposal/Specific aims.md';
  });

  it('another document of the folder can sync with that dropped tab, its text replacing the tab\'s; one tab, one document', async () => {
    // the real Budget was written here, under another name; its tab in Google Docs is the old one
    writeFileSync(join(P, 'Grant proposal', 'Budget plan.md'), '# Budget\n\nTwo GPUs for a year, and a cluster.\n');
    const folder = await sync.folderGoogleDoc('u/p/Grant proposal/Budget plan.md', owner.id);
    expect(folder!.fileId).toBe(fileId);
    const budget = folder!.tabs.find(t => t.title === 'Budget')!;
    expect(folder!.tabs.map(t => t.title)).toEqual(['Budget']);
    await sync.linkExistingGoogleDoc('u/p/Grant proposal/Budget plan.md', owner.id, fileId, budget.id, 'ours');
    expect(md('Grant proposal/Budget plan.md')).toBe('# Budget\n\nTwo GPUs for a year, and a cluster.\n');
    expect(g.tabDoc(fileId, budget.id).text()).toContain('Two GPUs for a year, and a cluster.');
    // and it is one of the group's documents again, where its tab is
    expect(parseDocGroup(readFileSync(join(P, 'Grant proposal', GROUP_MANIFEST), 'utf8'))!.members.map(m => m.file)).toEqual(['Summary.md', 'Specific aims.md', 'Aim 1 decoding.md', 'Budget plan.md']);
    // offered no more, not dropped any more: a sync makes no "Budget 2.md"
    expect((await sync.folderGoogleDoc('u/p/Grant proposal/Other.md', owner.id))!.tabs).toEqual([]);
    g.doc(fileId).revision++;
    await sync.syncDoc(docs[0]);
    expect(existsSync(join(P, 'Grant proposal', 'Budget 2.md'))).toBe(false);
    // edits here keep going to the tab
    const doc = await manager.open('u/p/Grant proposal/Budget plan.md');
    const lyx = doc.toLyxDocument();
    lyx.body[1].items = [{ kind: 'text', text: 'Three GPUs for a year, and a cluster.', font: {} }];
    doc.loadFromLyx(lyx, 'test');
    await doc.saveToFile();
    await sync.syncDoc('u/p/Grant proposal/Budget plan.md');
    expect(g.tabDoc(fileId, budget.id).text()).toContain('Three GPUs');
    // a second document cannot take the same tab
    writeFileSync(join(P, 'Grant proposal', 'Other.md'), 'Other.\n');
    await expect(sync.linkExistingGoogleDoc('u/p/Grant proposal/Other.md', owner.id, fileId, budget.id, 'ours')).rejects.toThrow(/already syncs/);
  });

  it('a Google Doc with one tab is imported as a plain document', async () => {
    const f = await g.createDocument('Notes');
    g.tabDoc(f.id).insertText(1, 'Just notes.');
    const r = await importGoogleDoc('u/p', 'drafts', f.id, owner.id);
    expect(r).toEqual({ docs: ['u/p/drafts/Notes.md'], group: null });
    expect(md('drafts/Notes.md')).toBe('Just notes.\n');
    await expect(importGoogleDoc('u/p', '', f.id, owner.id)).rejects.toThrow(/already/);
  });

  it('imported without sync, a Google Doc is a copy: no link, and it can come in again', async () => {
    const f = await g.createDocument('Copy me');
    g.tabDoc(f.id).insertText(1, 'Only a copy.');
    const before = g.batches;
    const r = await importGoogleDoc('u/p', 'copies', f.id, owner.id, { sync: false });
    expect(r).toEqual({ docs: ['u/p/copies/Copy me.md'], group: null });
    expect(md('copies/Copy me.md')).toBe('Only a copy.\n');
    expect(sync.linkOf(r.docs[0])).toBeNull();
    expect(g.batches).toBe(before);
    expect((await importGoogleDoc('u/p', 'copies', f.id, owner.id, { sync: false })).docs).toEqual(['u/p/copies/Copy me 2.md']);
  });

  it('linking a document to a Google Doc that exists brings its differences as tracked changes, and leaves the Google Doc', async () => {
    writeFileSync(join(P, 'mine.md'), '# Plan\n\nWe write the paper.\n\nThen we submit.\n');
    const f = await g.createDocument('Theirs');
    g.tabDoc(f.id).insertText(1, 'Plan\nWe write the paper together.\nThen we submit.');
    await g.batchUpdate(f.id, [{ updateParagraphStyle: { range: { startIndex: 1, endIndex: 5 }, paragraphStyle: { namedStyleType: 'HEADING_1' }, fields: 'namedStyleType' } }], undefined, 'Kirsten');
    const before = g.batches;
    await sync.linkExistingGoogleDoc('u/p/mine.md', owner.id, f.id, null);
    expect(md('mine.md')).toMatch(/We write the <del author="Kirsten \(Google Docs\)" datetime="[^"]+">paper\.<\/del><ins author="Kirsten \(Google Docs\)" datetime="[^"]+">paper together\.<\/ins>/);
    expect(g.batches).toBe(before);
    expect(sync.linkOf('u/p/mine.md')!.tab_id).toBe('t.0');
  });
});

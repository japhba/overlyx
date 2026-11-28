/**
 * The Google Docs sync (server/src/gdocs/) against a simulation of the Docs and Drive APIs
 * (tests/gdocs-fake.ts): a document written into a Google Doc reads back as the same blocks; an
 * edit changes only the words that changed (comments anchored in Google Docs keep their text);
 * random edits always converge; changes made in Google Docs come back as edits (as tracked changes by their
 * editor; comment threads, replies and resolving go both ways.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// a scratch data and projects directory before anything can load the server's configuration
const ROOT = vi.hoisted(() => {
  const root = (process.env.OVERLYX_SCRATCH || process.env.TMPDIR || '/tmp') + '/overlyx-gdocs-test';
  process.env.OVERLYX_DATA_DIR = root + '/data';
  process.env.OVERLYX_PROJECTS_DIR = root + '/projects';
  return root;
});
import { parseMarkdown } from '../packages/core/src/md/index.ts';
import type { LyxDocument } from '../packages/core/src/lyx/ast.ts';
import { project, readGoogle, strip, blockKey, type GBlock } from '../packages/server/src/gdocs/model.ts';
import { planRound } from '../packages/server/src/gdocs/edits.ts';
import { FakeGoogle } from '../packages/server/src/gdocs/fake.ts';
import { GoogleApiError, retryDelay } from '../packages/server/src/gdocs/errors.ts';

const want = (md: string): GBlock[] => strip(project(parseMarkdown(md).doc).blocks);
const keys = (bs: GBlock[]) => bs.map(blockKey);

/** bring the Google Doc to `target` (as the sync does), returning the rounds it took */
async function push(g: FakeGoogle, id: string, target: GBlock[]): Promise<number> {
  for (let round = 0; round < 12; round++) {
    const raw = await g.getDocument(id);
    const reqs = planRound(raw, target);
    if (!reqs.length) return round;
    await g.batchUpdate(id, reqs, raw.revisionId);
  }
  throw new Error('did not converge');
}
const read = async (g: FakeGoogle, id: string) => strip(readGoogle(await g.getDocument(id)).blocks);

const SAMPLE = `# Title

Some *em*, **bold**, \`code\`, ~~gone~~, a [link](https://x.y), $x^2$ and a note[^1].

- one
  - nested
    - deeper
- two

1. first
2. second

> A quoted line

\`\`\`py
def f():
    return 1
\`\`\`

$$
E = mc^2
$$

| a | b |
|---|---|
| 1 | **2** |

Last paragraph.

[^1]: The footnote.
`;

describe('writing a document into a Google Doc', () => {
  it('an empty Google Doc becomes the document, and reads back as the same blocks', async () => {
    const g = new FakeGoogle();
    const f = await g.createDocument('Sample');
    const rounds = await push(g, f.id, want(SAMPLE));
    expect(rounds).toBeLessThanOrEqual(6);
    expect(keys(await read(g, f.id))).toEqual(keys(want(SAMPLE)));
    const text = g.doc(f.id).text();
    expect(text).toContain('Some em, bold, code, gone, a link, $x^2$ and a note[^The footnote.].');
    expect(text).toContain('$$E = mc^2$$');
    expect(text).toContain('| 1 | 2 |');
    // nothing more to do
    expect(planRound(await g.getDocument(f.id), want(SAMPLE))).toEqual([]);
  });

  it('an edit changes only its words: comments anchored in the rest of the paragraph and elsewhere keep their text', async () => {
    const g = new FakeGoogle();
    const f = await g.createDocument('Sample');
    await push(g, f.id, want(SAMPLE));
    const inPara = g.comment(f.id, g.indexOf(f.id, 'Some'), g.indexOf(f.id, 'Some') + 4, 'on "Some"');
    const elsewhere = g.comment(f.id, g.indexOf(f.id, 'Last'), g.indexOf(f.id, 'Last') + 4, 'on "Last"');
    const before = g.batches;
    await push(g, f.id, want(SAMPLE.replace('**bold**', '**strong**')));
    expect(g.batches - before).toBe(1);
    const reqs = g.requests.at(-1)!;
    // a word replaced: one deletion, one insertion (and its style) — no paragraph rewritten
    expect(reqs.filter(r => 'deleteContentRange' in r)).toHaveLength(1);
    expect((reqs.find(r => 'insertText' in r) as { insertText: { text: string } }).insertText.text).toBe('strong');
    expect(g.anchored(f.id, inPara.id)).toBe(true);
    expect(g.anchored(f.id, elsewhere.id)).toBe(true);
    expect(g.doc(f.id).text()).toContain('Some em, strong, code');
  });

  it('formatting changes are style updates, not new text', async () => {
    const g = new FakeGoogle();
    const f = await g.createDocument('Sample');
    await push(g, f.id, want('Plain words here.\n'));
    await push(g, f.id, want('Plain **words** here.\n'));
    const reqs = g.requests.at(-1)!;
    expect(reqs.map(r => Object.keys(r)[0])).toEqual(['updateTextStyle']);
    expect(keys(await read(g, f.id))).toEqual(keys(want('Plain **words** here.\n')));
  });

  it('random edits always converge to the document (seeded)', async () => {
    let seed = 7;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    const WORDS = ['alpha', 'beta', 'gamma', 'delta', '**bold**', '*em*', '`code`', '$x_1$', '[link](https://a.b)'];
    const para = () => Array.from({ length: 2 + rnd(6) }, () => WORDS[rnd(WORDS.length)]).join(' ');
    const BLOCKS = [
      () => '# ' + para(), () => '## ' + para(), () => para(), () => para() + '.', () => '- ' + para() + '\n- ' + para(), () => '1. ' + para() + '\n2. ' + para(),
      () => '> ' + para(), () => '```\ncode ' + rnd(9) + '\n```', () => '| a | b |\n|---|---|\n| ' + para() + ' | ' + rnd(99) + ' |', () => '- ' + para() + '\n  - ' + para(),
      () => para() + ' with a note[^n' + rnd(3) + '] here', () => '```js\nlet a = ' + rnd(9) + ';\n\nlet b = 2;\n```', () => '1. ' + para() + '\n   - ' + para() + '\n2. ' + para(),
      () => '$$\nx^' + rnd(9) + '\n$$', () => '| a | b | c |\n|---|---|---|\n| 1 | ' + para() + ' | 3 |\n| 4 | 5 | ' + rnd(9) + ' |', () => '### ' + para() + '\n\n' + para(),
    ];
    let doc = Array.from({ length: 6 }, () => BLOCKS[rnd(BLOCKS.length)]());
    const g = new FakeGoogle();
    const f = await g.createDocument('Fuzz');
    for (let step = 0; step < 80; step++) {
      const next = doc.slice();
      const op = rnd(4);
      const at = rnd(next.length + 1);
      if (op === 0 || next.length < 2) next.splice(at, 0, BLOCKS[rnd(BLOCKS.length)]());
      else if (op === 1) next.splice(Math.min(at, next.length - 1), 1);
      else if (op === 2) next[Math.min(at, next.length - 1)] = BLOCKS[rnd(BLOCKS.length)]();
      else { const k = Math.min(at, next.length - 1); next[k] = next[k].replace(/alpha|beta|gamma/, w => (w === 'alpha' ? 'beta' : 'delta')); }
      doc = next;
      const md = doc.join('\n\n') + '\n\n[^n0]: First note ' + step + '.\n[^n1]: Second note.\n[^n2]: Third note ' + (step % 3) + '.\n';
      const target = want(md);
      await push(g, f.id, target);
      expect(keys(await read(g, f.id)), `step ${step}:\n${md}`).toEqual(keys(target));
    }
  });
});

describe('a request Google did not take', () => {
  it('is tried again for rate limits, Google\'s own failures and no answer — later each time, or when Google says — and nothing else', () => {
    const mid = () => 0.5;
    // the Docs API's quota (429), the Drive API's "User rate limit exceeded" (403 with its reason), a 503, no answer (0)
    expect([0, 1, 2, 3].map(a => retryDelay(429, 'RESOURCE_EXHAUSTED', a, null, mid))).toEqual([1500, 2500, 4500, null]);
    expect(retryDelay(403, 'userRateLimitExceeded', 0, null, mid)).toBe(1500);
    expect(retryDelay(403, 'rateLimitExceeded', 1, null, mid)).toBe(2500);
    expect(retryDelay(403, 'RATE_LIMIT_EXCEEDED', 0, null, mid)).toBe(1500);
    expect(retryDelay(503, undefined, 0, null, mid)).toBe(1500);
    expect(retryDelay(0, undefined, 2, null, mid)).toBe(4500);
    // Google says when: in seconds or as a date; longer than a sync waits is no retry (the automatic sync's back-off takes over)
    expect(retryDelay(429, undefined, 0, '7')).toBe(7000);
    expect(retryDelay(403, 'userRateLimitExceeded', 0, new Date(Date.UTC(2026, 10, 28, 12, 0, 12)).toUTCString(), mid, Date.UTC(2026, 10, 28, 12, 0, 0))).toBe(12_000);
    expect(retryDelay(429, undefined, 0, '120')).toBeNull();
    // the request's own fault: no access, no such file, a revision that moved on, a daily limit, an expired token
    for (const [status, reason] of [[403, 'insufficientFilePermissions'], [403, 'dailyLimitExceeded'], [404, 'notFound'], [400, 'FAILED_PRECONDITION'], [401, 'authError']] as const) expect(retryDelay(status, reason, 0)).toBeNull();
  });
});

describe('the sync of a document', async () => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(ROOT, 'projects', 'u', 'p'), { recursive: true });
  const { config } = await import('../packages/server/src/config.ts');
  if (!config.dataDir.startsWith(ROOT)) throw new Error('the test would use the real data directory: ' + config.dataDir);
  const { manager } = await import('../packages/server/src/docs.ts');
  const sync = await import('../packages/server/src/gdocs/sync.ts');
  const g = new FakeGoogle();
  sync.setGoogleApiFactory(() => g);
  const file = join(ROOT, 'projects', 'u', 'p', 'paper.md');
  const ID = 'u/p/paper.md';
  let fileId = '';
  // the linker owns the project (a link whose linker may not edit the document any more stops syncing)
  const { createUser } = await import('../packages/server/src/auth.ts');
  const { registerProject } = await import('../packages/server/src/access.ts');
  const owner = createUser('u', 'U', null);
  registerProject('u/p', owner.id);
  beforeAll(async () => {
    writeFileSync(file, '# Paper\n\nThe first paragraph says something.\n\nThe second paragraph says more.\n\n- an item\n- another item\n');
    const link = await sync.linkNewGoogleDoc(ID, owner.id, 'Paper');
    fileId = link.file_id;
  });
  const text = () => readFileSync(file, 'utf8');
  const docModel = async (): Promise<LyxDocument> => (await manager.open(ID)).toLyxDocument();

  it('a collaborator who may not edit the document any more cannot keep it flowing to their Google Doc', async () => {
    const stranger = createUser('w', 'W', null);
    writeFileSync(join(ROOT, 'projects', 'u', 'p', 'private.md'), '# Private\n\nNot for W.\n');
    await expect(sync.linkNewGoogleDoc('u/p/private.md', stranger.id, 'Private')).rejects.toThrow(/may not edit it any more/);
    expect(sync.linkOf('u/p/private.md')).toBeNull();
  });

  it('linking writes the document into a new Google Doc', async () => {
    expect(g.doc(fileId).text()).toBe('Paper\nThe first paragraph says something.\nThe second paragraph says more.\nan item\nanother item');
    const before = g.batches;
    const r = await sync.syncDoc(ID);
    expect(r.pushed).toBe(0);
    expect(g.batches).toBe(before);   // nothing changed: nothing written
  });

  it('an edit in Google Docs comes back as an edit while Editing, and as a tracked change by its editor while Suggesting', async () => {
    let at = g.indexOf(fileId, 'something');
    await g.batchUpdate(fileId, [{ deleteContentRange: { range: { startIndex: at, endIndex: at + 'something'.length } } }, { insertText: { location: { index: at }, text: 'a lot' } }], undefined, 'Kirsten');
    const batches = g.batches;
    const r = await sync.syncDoc(ID);
    expect(r.pulled).toBeGreaterThan(0);
    expect(g.batches).toBe(batches);   // nothing to write back
    expect(text()).toContain('The first paragraph says a lot.');
    expect(text()).not.toContain('<ins');
    // Suggesting (the document's change tracking): Google's edits arrive for review, by whoever made them
    const doc = await manager.open(ID);
    doc.ydoc.transact(() => { doc.meta.set('header', JSON.stringify(doc.getMeta().headerLines.map(l => (l.startsWith('\\tracking_changes') ? '\\tracking_changes true' : l)))); }, 'header');
    await doc.saveToFile();
    await sync.syncDoc(ID);
    at = g.indexOf(fileId, 'a lot');
    await g.batchUpdate(fileId, [{ deleteContentRange: { range: { startIndex: at, endIndex: at + 'a lot'.length } } }, { insertText: { location: { index: at }, text: 'plenty' } }], undefined, 'Kirsten');
    await sync.syncDoc(ID);
    // (word by word, as tracked changes are: the full stop is part of the word)
    expect(text()).toMatch(/The first paragraph says <del author="Kirsten \(Google Docs\)" datetime="[^"]+">a lot\.?<\/del><ins author="Kirsten \(Google Docs\)" datetime="[^"]+">plenty\.?<\/ins>/);
    expect(g.doc(fileId).text()).toContain('The first paragraph says plenty.');
    // the document's mode stays as it is
    expect((await manager.open(ID)).getMeta().headerLines).toContain('\\tracking_changes true');
  });

  it('paragraphs added, removed and changed in Google Docs, and a new list item, come back too — and the next sync writes nothing', async () => {
    // a new paragraph after the heading, the second paragraph removed, a third list item
    const second = g.indexOf(fileId, 'The second paragraph');
    const raw = await g.getDocument(fileId);
    const par = raw.body.content.find(el => el.startIndex === second)!;
    const item = g.indexOf(fileId, 'another item');
    await g.batchUpdate(fileId, [
      { insertText: { location: { index: item + 'another item'.length }, text: '\na third item' } },
      { deleteContentRange: { range: { startIndex: par.startIndex!, endIndex: par.endIndex } } },
      { insertText: { location: { index: g.indexOf(fileId, 'The first') }, text: 'A new opening paragraph.\n' } },
    ], undefined, 'Kirsten');
    await sync.syncDoc(ID);
    const md = text();
    expect(md).toMatch(/<ins author="Kirsten \(Google Docs\)" datetime="[^"]+">A new opening paragraph\.<\/ins>/);
    expect(md).toMatch(/<del author="Kirsten \(Google Docs\)" datetime="[^"]+">The second paragraph says more\.<\/del>/);
    expect(md).toMatch(/- <ins author="Kirsten \(Google Docs\)" datetime="[^"]+">a third item<\/ins>/);
    const batches = g.batches;
    await sync.syncDoc(ID);
    expect(g.batches).toBe(batches);
    // the changes accepted here: the Google Doc stays as it is
    const doc = await manager.open(ID);
    const { resolveChanges } = await import('../packages/core/src/lyx/trackdiff.ts');
    const lyx = await docModel();
    lyx.body = resolveChanges(lyx.body, true);
    doc.loadFromLyx(lyx, 'test');
    await doc.saveToFile();
    await sync.syncDoc(ID);
    expect(g.batches).toBe(batches);
    expect(text()).not.toContain('<ins');
    expect(text()).toContain('A new opening paragraph.');
  });

  it('an edit here goes to Google Docs, word by word', async () => {
    const doc = await manager.open(ID);
    const lyx = await docModel();
    const p = lyx.body.findIndex(x => x.items.some(i => i.kind === 'text' && i.text.includes('A new opening')));
    lyx.body[p].items = [{ kind: 'text', text: 'A new and much longer opening paragraph.', font: {} }];
    doc.loadFromLyx(lyx, 'test');
    await doc.saveToFile();
    await sync.syncDoc(ID);
    expect(g.doc(fileId).text()).toContain('A new and much longer opening paragraph.');
    const reqs = g.requests.at(-1)!;
    expect(reqs.filter(r => 'insertText' in r).map(r => (r as { insertText: { text: string } }).insertText.text)).toEqual(['and much longer ']);
  });

  it('a comment in Google Docs becomes a thread after the text it is on; a reply here goes back; resolving goes both ways', async () => {
    const at = g.indexOf(fileId, 'an item');
    const c = g.comment(fileId, at, at + 'an item'.length, 'Is this needed?', 'Kirsten');
    const r1 = await sync.syncDoc(ID);
    expect(r1.comments.fromGoogle).toBe(1);
    expect(text()).toMatch(/- an item<!-- @comment\n {6}Kirsten \(2026-10-04 \d\d:30\):\n {6}Is this needed\?\n {6}-->/);
    // a reply here
    const doc = await manager.open(ID);
    const lyx = await docModel();
    const item = lyx.body.find(x => x.items.some(i => i.kind === 'inset' && i.inset.type === 'Text' && i.inset.arg === 'Comment'))!;
    const thread = item.items.find(i => i.kind === 'inset' && i.inset.type === 'Text' && i.inset.arg === 'Comment') as Extract<LyxDocument['body'][0]['items'][0], { kind: 'inset' }>;
    if (thread.inset.type !== 'Text') throw new Error();
    thread.inset.paragraphs.push({ layout: 'Plain Layout', depth: 0, params: {}, items: [{ kind: 'text', text: 'Jan (2026-10-04 10:00):', font: {} }] }, { layout: 'Plain Layout', depth: 0, params: {}, items: [{ kind: 'text', text: 'Yes, it is.', font: {} }] });
    doc.loadFromLyx(lyx, 'test');
    await doc.saveToFile();
    const r2 = await sync.syncDoc(ID);
    expect(r2.comments.toGoogle).toBe(1);
    expect(g.comments.get(fileId)!.find(x => x.id === c.id)!.replies!.map(r => r.content)).toEqual(['Yes, it is.']);
    // resolved in Google Docs
    await g.createReply(fileId, c.id, { action: 'resolve' }, 'Kirsten');
    await sync.syncDoc(ID);
    expect(text()).toMatch(/Kirsten \(2026-10-04 \d\d:30\) \[resolved\]:/);
    // reopened here
    const lyx2 = await docModel();
    const t2 = lyx2.body.flatMap(x => x.items).find(i => i.kind === 'inset' && i.inset.type === 'Text' && i.inset.arg === 'Comment') as Extract<LyxDocument['body'][0]['items'][0], { kind: 'inset' }>;
    if (t2.inset.type !== 'Text') throw new Error();
    const h = t2.inset.paragraphs[0].items[0] as { text: string };
    h.text = h.text.replace(' [resolved]', '');
    doc.loadFromLyx(lyx2, 'test');
    await doc.saveToFile();
    await sync.syncDoc(ID);
    expect(g.comments.get(fileId)!.find(x => x.id === c.id)!.resolved).toBe(false);
    // and nothing is sent twice
    const n = g.comments.get(fileId)!.length, replies = g.comments.get(fileId)!.find(x => x.id === c.id)!.replies!.length;
    await sync.syncDoc(ID);
    expect(g.comments.get(fileId)!.length).toBe(n);
    expect(g.comments.get(fileId)!.find(x => x.id === c.id)!.replies!.length).toBe(replies);
  });

  it('a thread written here becomes a Google comment anchored to the text before it (quoted, where anchoring is not available)', async () => {
    const doc = await manager.open(ID);
    const lyx = await docModel();
    const p = lyx.body.find(x => x.items.some(i => i.kind === 'text' && i.text.includes('Paper')))!;
    p.items.push({ kind: 'inset', font: {}, inset: { type: 'Text', name: 'Note', arg: 'Comment', params: [], status: 'open', paragraphs: [
      { layout: 'Plain Layout', depth: 0, params: {}, items: [{ kind: 'text', text: 'Jan (2026-10-04 11:00):', font: {} }] },
      { layout: 'Plain Layout', depth: 0, params: {}, items: [{ kind: 'text', text: 'A better title?', font: {} }] },
    ] } });
    doc.loadFromLyx(lyx, 'test');
    await doc.saveToFile();
    const r = await sync.syncDoc(ID);
    expect(r.comments.toGoogle).toBe(1);
    const made = g.comments.get(fileId)!.at(-1)!;
    expect(made.content).toBe('Jan: A better title?');
    expect(made.quotedFileContent?.value).toBe('Paper');
    expect(g.anchored(fileId, made.id)).toBe(true);
    // the Drive fallback when anchored comments are not available
    g.anchoredComments = false;
    const lyx2 = await docModel();
    const p2 = lyx2.body.find(x => x.items.some(i => i.kind === 'text' && i.text.includes('much longer')))!;
    p2.items.push({ kind: 'inset', font: {}, inset: { type: 'Text', name: 'Note', arg: 'Comment', params: [], status: 'open', paragraphs: [
      { layout: 'Plain Layout', depth: 0, params: {}, items: [{ kind: 'text', text: 'Jan (2026-10-04 11:05):', font: {} }] },
      { layout: 'Plain Layout', depth: 0, params: {}, items: [{ kind: 'text', text: 'Cite this.', font: {} }] },
    ] } });
    doc.loadFromLyx(lyx2, 'test');
    await doc.saveToFile();
    await sync.syncDoc(ID);
    const fallback = g.comments.get(fileId)!.at(-1)!;
    expect(fallback.content).toBe('Jan: Cite this.');
    expect(fallback.quotedFileContent?.value).toBe('A new and much longer opening paragraph.');
    g.anchoredComments = true;
  });

  it('a failed sync leaves saved local edits pending for the next automatic sync', async () => {
    const id = 'u/p/retry.md';
    writeFileSync(join(ROOT, 'projects', 'u', 'p', 'retry.md'), '# Retry\n\nOriginal text.\n');
    const link = await sync.linkNewGoogleDoc(id, owner.id, 'Retry');
    const lastSync = link.last_sync!;
    const doc = await manager.open(id);
    const getDocument = vi.spyOn(g, 'getDocument');
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    try {
      vi.setSystemTime(lastSync + 1000);
      doc.loadFromLyx(parseMarkdown('# Retry\n\nSaved edit.\n').doc, 'test');
      await doc.saveToFile();
      getDocument.mockRejectedValueOnce(new TypeError('fetch failed'));
      vi.setSystemTime(lastSync + 2000);
      await expect(sync.syncDoc(id)).rejects.toThrow('fetch failed');
      expect(sync.linkOf(id)?.last_sync).toBe(lastSync);
      expect(sync.linkOf(id)?.last_error).toBe('fetch failed');
      expect(g.doc(link.file_id).text()).toContain('Original text.');

      sync.startAutoSync();
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(() => {
        expect(g.doc(link.file_id).text()).toContain('Saved edit.');
        expect(sync.linkOf(id)?.last_error).toBeNull();
      });
    } finally {
      getDocument.mockRestore();
      vi.useRealTimers();
    }
  });

  it('Drive\'s "User rate limit exceeded" is asked again after the pause Google names; a refusal of the request itself is not', async () => {
    const { googleApi } = await import('../packages/server/src/gdocs/google.ts');
    const { sealer } = await import('../packages/server/src/sealed.ts');
    const { db } = await import('../packages/server/src/db.ts');
    const { seal } = sealer('google-drive');
    db.prepare('INSERT OR REPLACE INTO google_drive (user_id, email, refresh_token, access_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(owner.id, null, seal('refresh'), seal('access'), Date.now() + 3_600_000, Date.now());
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
    // (Drive v3's answer, as its documentation gives it)
    const limited = json(403, { error: { code: 403, message: 'User rate limit exceeded.', errors: [{ domain: 'usageLimits', reason: 'userRateLimitExceeded', message: 'User rate limit exceeded.' }] } }, { 'retry-after': '0' });
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(limited).mockResolvedValueOnce(json(200, { id: 'f1', version: '3' }));
    try {
      expect((await googleApi(owner.id).getFile('f1')).version).toBe('3');
      expect(fetch).toHaveBeenCalledTimes(2);
      fetch.mockResolvedValueOnce(json(404, { error: { code: 404, message: 'File not found: f2.', errors: [{ domain: 'global', reason: 'notFound', message: 'File not found: f2.' }] } }));
      await expect(googleApi(owner.id).getFile('f2')).rejects.toMatchObject({ status: 404, reason: 'notFound', message: 'File not found: f2.' });
      expect(fetch).toHaveBeenCalledTimes(3);
    } finally {
      fetch.mockRestore();
      db.prepare('DELETE FROM google_drive WHERE user_id = ?').run(owner.id);
    }
  });

  it('an automatic sync that keeps failing is tried less and less often; a manual sync always runs, and one that works ends the waiting', async () => {
    const id = 'u/p/gone.md';
    writeFileSync(join(ROOT, 'projects', 'u', 'p', 'gone.md'), '# Gone\n\nText.\n');
    const link = await sync.linkNewGoogleDoc(id, owner.id, 'Gone');
    const real = g.getFile.bind(g);
    let asked = 0, gone = true;
    // (Drive's answer for a Google Doc deleted for good)
    const getFile = vi.spyOn(g, 'getFile').mockImplementation(async fid => {
      if (fid !== link.file_id) return real(fid);
      asked++;
      if (gone) throw new GoogleApiError(`File not found: ${fid}.`, 404, 'notFound');
      return real(fid);
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const t0 = Date.now();
      const pass = async (minute: number) => { vi.setSystemTime(t0 + minute * 60_000); await sync.tick(60_000); return asked; };
      expect(await pass(0)).toBe(1);
      expect(sync.linkOf(id)?.last_error).toMatch(/File not found/);
      // passes a minute apart: asked again 1, 2, 4 minutes after each failure
      expect([await pass(1), await pass(2), await pass(3), await pass(4), await pass(5), await pass(6), await pass(7)]).toEqual([2, 2, 3, 3, 3, 3, 4]);
      await expect(sync.syncDoc(id)).rejects.toThrow(/File not found/);
      expect(asked).toBe(5);
      gone = false;
      await sync.syncDoc(id);
      expect(sync.linkOf(id)?.last_error).toBeNull();
      // (without it the next automatic attempt would be at minute 14)
      const before = asked;
      expect(await pass(8)).toBeGreaterThan(before);
    } finally {
      getFile.mockRestore();
      vi.useRealTimers();
    }
  });

  it('a .tex document syncs too: headings, formulas and citations as text Docs can hold', async () => {
    const tex = join(ROOT, 'projects', 'u', 'p', 'note.tex');
    writeFileSync(tex, '\\documentclass{article}\n\\begin{document}\n\\section{Intro}\nEnergy $E=mc^2$ as in \\cite{einstein}.\n\\begin{itemize}\n\\item one\n\\end{itemize}\n\\end{document}\n');
    const link = await sync.linkNewGoogleDoc('u/p/note.tex', 1, 'Note');
    expect(g.doc(link.file_id).text()).toBe('Intro\nEnergy $E=mc^2$ as in [@einstein].\none');
    const raw = await g.getDocument(link.file_id);
    expect(readGoogle(raw).blocks.map(b => (b.t === 'p' ? [b.style, !!b.list] : 'table'))).toEqual([['HEADING_1', false], ['NORMAL_TEXT', false], ['NORMAL_TEXT', true]]);
    // an edit there: the citation and the formula come back as insets
    const at = g.indexOf(link.file_id, 'Energy');
    await g.batchUpdate(link.file_id, [{ insertText: { location: { index: at }, text: 'Total ' } }], undefined, 'Kirsten');
    await sync.syncDoc('u/p/note.tex');
    const saved = readFileSync(tex, 'utf8');
    // (the document is not Suggesting: the edit is applied as it was made)
    expect(saved).not.toContain('\\lyxadded');
    expect(saved).toContain('Total Energy');
    expect(saved).toContain('$E=mc^2$');
    expect(saved).toContain('\\cite{einstein}');
  });
});

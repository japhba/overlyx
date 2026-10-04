/**
 * The Google Docs sync (server/src/gdocs/) against a simulation of the Docs and Drive APIs
 * (tests/gdocs-fake.ts): a document written into a Google Doc reads back as the same blocks; an
 * edit changes only the words that changed (comments anchored in Google Docs keep their text);
 * random edits always converge; changes made in Google Docs come back as tracked changes by their
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
  beforeAll(async () => {
    writeFileSync(file, '# Paper\n\nThe first paragraph says something.\n\nThe second paragraph says more.\n\n- an item\n- another item\n');
    const link = await sync.linkNewGoogleDoc(ID, 1, 'Paper');
    fileId = link.file_id;
  });
  const text = () => readFileSync(file, 'utf8');
  const docModel = async (): Promise<LyxDocument> => (await manager.open(ID)).toLyxDocument();

  it('linking writes the document into a new Google Doc', async () => {
    expect(g.doc(fileId).text()).toBe('Paper\nThe first paragraph says something.\nThe second paragraph says more.\nan item\nanother item');
    const before = g.batches;
    const r = await sync.syncDoc(ID);
    expect(r.pushed).toBe(0);
    expect(g.batches).toBe(before);   // nothing changed: nothing written
  });

  it('an edit in Google Docs comes back as a tracked change by its editor; the Google Doc is left as it is', async () => {
    const at = g.indexOf(fileId, 'something');
    await g.batchUpdate(fileId, [{ deleteContentRange: { range: { startIndex: at, endIndex: at + 'something'.length } } }, { insertText: { location: { index: at }, text: 'a lot' } }], undefined, 'Kirsten');
    const batches = g.batches;
    const r = await sync.syncDoc(ID);
    expect(r.pulled).toBeGreaterThan(0);
    expect(g.batches).toBe(batches);   // nothing to write back
    // (word by word, as tracked changes are: the full stop is part of the word)
    expect(text()).toMatch(/The first paragraph says <del author="Kirsten \(Google Docs\)" datetime="[^"]+">something\.?<\/del><ins author="Kirsten \(Google Docs\)" datetime="[^"]+">a lot\.?<\/ins>/);
    expect(g.doc(fileId).text()).toContain('The first paragraph says a lot.');
    // the document does not start tracking its own edits because of it
    expect((await manager.open(ID)).getMeta().headerLines).toContain('\\tracking_changes false');
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
    expect(saved).toContain('\\lyxadded{Kirsten (Google Docs)}');
    expect(saved).toContain('Total');
    expect(saved).toContain('$E=mc^2$');
    expect(saved).toContain('\\cite{einstein}');
  });
});

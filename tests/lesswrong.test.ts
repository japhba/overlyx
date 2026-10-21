/**
 * The LessWrong sync (server/src/lesswrong/) against a simulation of LessWrong's agent API
 * (lesswrong/fake.ts): a document written into an empty draft reads back as the same blocks; edits
 * here become quoted-text edits there and converge; edits made on LessWrong come back as edits
 * (tracked while Suggesting); open suggestions there are left alone; comment threads go both ways
 * with the link-sharing key; the addresses people paste are understood.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// a scratch data and projects directory before anything can load the server's configuration
const ROOT = vi.hoisted(() => {
  const root = (process.env.OVERLYX_SCRATCH || process.env.TMPDIR || '/tmp') + '/overlyx-lesswrong-test';
  process.env.OVERLYX_DATA_DIR = root + '/data';
  process.env.OVERLYX_PROJECTS_DIR = root + '/projects';
  return root;
});
import { parseMarkdown } from '../packages/core/src/md/index.ts';
import { projectDocument, readBlocks, planPush, withoutSuggestions, opKey } from '../packages/server/src/lesswrong/model.ts';
import { parsePostRef, parseThreads, parseReadPost } from '../packages/server/src/lesswrong/api.ts';
import { FakeLessWrong } from '../packages/server/src/lesswrong/fake.ts';

const SAMPLE = `# Title

Some *em*, **bold**, \`code\`, ~~gone~~, a [link](https://x.y), $x^2$ and a note[^1].

- one
  - nested
- two

1. first
2. second

> A quoted line

$$
E = mc^2
$$

| a | b |
|---|---|
| 1 | **2** |

Last paragraph.

[^1]: The footnote.
`;

const keys = (md: string) => readBlocks(withoutSuggestions(md).text).blocks.map(b => b.key);

/** bring the draft to `md` (as the sync does), returning the rounds it took */
async function push(g: FakeLessWrong, id: string, md: string): Promise<number> {
  const p = projectDocument(parseMarkdown(md).doc);
  const skip = new Set<string>();
  for (let round = 0; round < 12; round++) {
    const have = readBlocks(withoutSuggestions(g.markdown(id)).text).blocks;
    const ops = planPush(have, p.blocks, p.doc, {}, skip);
    if (!ops.length) return round;
    for (const op of ops) {
      const r = op.op === 'replace' ? await g.replaceText(id, null, op) : op.op === 'insert' ? await g.insertBlock(id, null, op) : await g.deleteBlock(id, null, op);
      if (!r.ok) skip.add(opKey(op));
    }
  }
  throw new Error('did not converge');
}

describe('writing a document into a LessWrong draft', () => {
  it('an empty draft becomes the document in one insertion, and reads back as the same blocks', async () => {
    const g = new FakeLessWrong();
    const id = g.create('Sample');
    expect(await push(g, id, SAMPLE)).toBe(1);
    expect(g.edits).toBe(1);
    expect(keys(g.markdown(id))).toEqual(projectDocument(parseMarkdown(SAMPLE).doc).blocks.map(b => b.key));
    expect(g.markdown(id)).toContain('*   one');   // (LessWrong's own bullets: the same blocks all the same)
  });

  it('an edit changes only its words; list items, paragraphs and kinds of block come and go', async () => {
    const g = new FakeLessWrong();
    const id = g.create('Sample');
    await push(g, id, SAMPLE);
    const steps = [
      SAMPLE.replace('Last paragraph.', 'The last paragraph, now longer.'),
      SAMPLE.replace('- two', '- two\n- three').replace('2. second', '2. second item'),
      SAMPLE.replace('> A quoted line\n', '').replace('Some *em*', 'Some new *em*'),
      SAMPLE.replace('# Title', '## Title').replace('| 1 | **2** |', '| 1 | **3** |'),
      SAMPLE.replace('Last paragraph.', 'Last paragraph.\n\nAnother one.\n\nAnd a third.').replace('  - nested\n', ''),
      SAMPLE.replace('E = mc^2', 'E = mc^3').replace('The footnote.', 'The changed footnote.'),
    ];
    for (const md of steps) {
      const before = g.edits;
      await push(g, id, md);
      expect(keys(g.markdown(id)), md).toEqual(projectDocument(parseMarkdown(md).doc).blocks.map(b => b.key));
      expect(g.edits - before).toBeLessThanOrEqual(8);
    }
    // a word: one replacement of a few words, not the paragraph
    const before = g.edits;
    const last = steps[steps.length - 1];
    await push(g, id, last.replace('a note', 'a short note'));
    expect(g.edits - before).toBe(1);
  });

  it('random edits always converge', async () => {
    const words = ['alpha', 'beta', 'gamma', 'delta', 'the', 'a', 'and'];
    let seed = 7;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
    const g = new FakeLessWrong();
    const id = g.create('Fuzz');
    let pars = ['# Fuzz', 'First paragraph here.', '- item a\n- item b', 'Second paragraph *with* emphasis.'];
    await push(g, id, pars.join('\n\n') + '\n');
    for (let step = 0; step < 25; step++) {
      const k = rnd(pars.length);
      const what = rnd(4);
      if (what === 0) pars.splice(k, 0, `New ${words[rnd(words.length)]} ${step} paragraph.`);
      else if (what === 1 && pars.length > 2) pars.splice(k, 1);
      else if (what === 2) pars[k] = pars[k].replace(/(\w+)/, m => m + ' ' + words[rnd(words.length)]);
      else pars[k] = pars[k].startsWith('- ') ? pars[k] + `\n- item ${step}` : pars[k] + ' More.';
      const md = pars.join('\n\n') + '\n';
      await push(g, id, md);
      expect(keys(g.markdown(id)), `step ${step}:\n${md}`).toEqual(projectDocument(parseMarkdown(md).doc).blocks.map(b => b.key));
    }
  });

  it('a paragraph with an open suggestion on LessWrong is left alone', async () => {
    const g = new FakeLessWrong();
    const id = g.create('S');
    await push(g, id, 'One paragraph says this.\n\nAnother says that.\n');
    g.suggest(id, 'One paragraph says', ' maybe');
    const p = projectDocument(parseMarkdown('One paragraph says something else.\n\nAnother says that.\n').doc);
    const warnings = new Set<string>();
    expect(planPush(readBlocks(withoutSuggestions(g.markdown(id)).text).blocks, p.blocks, p.doc, {}, new Set(), warnings)).toEqual([]);
    expect([...warnings].join()).toMatch(/open suggestions/);
  });
});

describe('the sync of a document', async () => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(ROOT, 'projects', 'u', 'p'), { recursive: true });
  const { config } = await import('../packages/server/src/config.ts');
  if (!config.dataDir.startsWith(ROOT)) throw new Error('the test would use the real data directory: ' + config.dataDir);
  const { manager } = await import('../packages/server/src/docs.ts');
  const sync = await import('../packages/server/src/lesswrong/sync.ts');
  const g = new FakeLessWrong();
  const { createUser } = await import('../packages/server/src/auth.ts');
  const { registerProject } = await import('../packages/server/src/access.ts');
  const owner = createUser('u', 'U', null);
  registerProject('u/p', owner.id);
  const file = join(ROOT, 'projects', 'u', 'p', 'post.md');
  const ID = 'u/p/post.md';
  const KEY = 'sharekey123';
  let post = '';
  beforeAll(async () => {
    sync.setLessWrongApiFactory(() => g);
    writeFileSync(file, '# Post\n\nThe first paragraph says something.\n\nThe second paragraph says more.\n\n- an item\n- another item\n');
    post = g.create('My post', '', KEY);
    await sync.linkPost(ID, owner.id, { postId: post, key: KEY });
  });
  const text = () => readFileSync(file, 'utf8');

  it('linking writes the document into the empty draft; the next sync writes nothing', async () => {
    expect(g.markdown(post)).toContain('The first paragraph says something.');
    expect(g.markdown(post)).toContain('*   another item');
    const before = g.edits;
    const r = await sync.syncDoc(ID);
    expect(r.pushed).toBe(0);
    expect(g.edits).toBe(before);
    expect(sync.lwLinkOf(ID)?.title).toBe('My post');
  });

  it('an edit here becomes an edit there', async () => {
    const doc = await manager.open(ID);
    await doc.agentEdit('plain', null, { replace: { oldText: 'says more', newText: 'says a lot more' } });
    const r = await sync.syncDoc(ID);
    expect(r.pushed).toBe(1);
    expect(g.markdown(post)).toContain('The second paragraph says a lot more.');
  });

  it('an edit on LessWrong comes back as an edit while Editing, as a tracked change by LessWrong while Suggesting', async () => {
    g.edit(post, 'says something', 'says a great deal');
    const before = g.edits;
    const r = await sync.syncDoc(ID);
    expect(r.pulled).toBeGreaterThan(0);
    expect(g.edits).toBe(before);   // nothing to write back
    expect(text()).toContain('The first paragraph says a great deal.');
    // Suggesting: LessWrong's edits arrive for review
    const doc = await manager.open(ID);
    doc.ydoc.transact(() => { doc.meta.set('header', JSON.stringify(doc.getMeta().headerLines.map(l => (l.startsWith('\\tracking_changes') ? '\\tracking_changes true' : l)))); }, 'header');
    await doc.saveToFile();
    await sync.syncDoc(ID);
    g.edit(post, '*   another item', '*   another item\n*   a third item');
    g.edit(post, 'a great deal', 'plenty');
    await sync.syncDoc(ID);
    expect(text()).toMatch(/<ins author="LessWrong" datetime="[^"]+">plenty\.?<\/ins>/);
    expect(text()).toMatch(/- <ins author="LessWrong" datetime="[^"]+">a third item<\/ins>/);
    expect((await manager.open(ID)).getMeta().headerLines).toContain('\\tracking_changes true');
    // the draft stays as LessWrong has it (tracked changes count as accepted)
    const edits = g.edits;
    await sync.syncDoc(ID);
    expect(g.edits).toBe(edits);
  });

  it('comment threads go both ways with the link-sharing key', async () => {
    const tid = g.comment(post, 'The second paragraph', 'Is this claim true?', 'Kirsten');
    let r = await sync.syncDoc(ID);
    expect(r.comments.fromLessWrong).toBe(1);
    expect(text()).toContain('Kirsten');
    expect(text()).toContain('Is this claim true?');
    // a reply written here goes there
    const doc = await manager.open(ID);
    const before = text();
    const after = before.replace(/( {4}Is this claim true\?\n)/, '$1    U (2026-10-21 12:00):\n    Yes, see the appendix.\n');
    expect(after).not.toBe(before);
    await doc.agentEdit('plain', before, { after });
    r = await sync.syncDoc(ID);
    expect(r.comments.toLessWrong).toBe(1);
    expect(g.threads(post).find(t => t.id === tid)!.comments.map(c => c.text)).toEqual(['Is this claim true?', 'Yes, see the appendix.']);
    // resolved there: resolved here
    g.resolve(post, tid);
    await sync.syncDoc(ID);
    expect(text()).toMatch(/Kirsten \([^)]*\) \[resolved\]:/);
  });

  it('a thread written here becomes a LessWrong comment at its text', async () => {
    const doc = await manager.open(ID);
    const before = text();
    const after = before.replace('says a lot more.', 'says a lot more.<!-- @comment\n    U (2026-10-21 12:30):\n    Cite something here.\n    -->');
    await doc.agentEdit('plain', before, { after });
    const r = await sync.syncDoc(ID);
    expect(r.comments.toLessWrong).toBe(1);
    const t = g.threads(post).find(x => x.comments[0].text === 'Cite something here.')!;
    expect(t.comments[0].author).toBe('U (OverLyX)');
    expect(t.quote).toContain('says a lot more');
    // not sent again, nor taken back as a new thread
    const r2 = await sync.syncDoc(ID);
    expect(r2.comments).toEqual({ fromLessWrong: 0, toLessWrong: 0 });
  });
});

describe('a LaTeX document', async () => {
  const { manager } = await import('../packages/server/src/docs.ts');
  const sync = await import('../packages/server/src/lesswrong/sync.ts');
  const g = new FakeLessWrong();
  beforeAll(() => { sync.setLessWrongApiFactory(() => g); });
  const file = join(ROOT, 'projects', 'u', 'p', 'note.tex');
  const ID = 'u/p/note.tex';

  it('goes to LessWrong without its title block, labels and LaTeX code; an edit there comes back into the LaTeX', async () => {
    writeFileSync(file, '\\documentclass{article}\n\\title{A Note}\n\\begin{document}\n\\maketitle\n\n\\section{Introduction}\\label{sec:intro}\n\nWe study $x^2$ here.\\vspace{1em}\n\n\\begin{itemize}\n\\item first point\n\\item second point\n\\end{itemize}\n\\end{document}\n');
    const post = g.create('A Note');
    const owner = (await import('../packages/server/src/db.ts')).db.prepare("SELECT id FROM users WHERE username = 'u'").get() as { id: number };
    await sync.linkPost(ID, owner.id, { postId: post, key: null });
    const md = g.markdown(post);
    expect(md).toContain('# Introduction');
    expect(md).toContain('We study $x^2$ here.');
    expect(md).toContain('*   second point');
    expect(md).not.toMatch(/A Note|sec:intro|vspace|maketitle/);
    g.edit(post, 'We study', 'We carefully study');
    await sync.syncDoc(ID);
    const tex = readFileSync(file, 'utf8');
    expect(tex).toContain('We carefully study $x^2$ here.');
    expect(tex).toContain('\\label{sec:intro}');
    expect(tex).toContain('\\section{Introduction}');
    expect(tex).toContain('\\title{A Note}');
    const edits = g.edits;
    await sync.syncDoc(ID);
    expect(g.edits).toBe(edits);
    expect((await manager.open(ID)).relPath).toBe('note.tex');
  });
});

describe('what LessWrong says and what people paste', () => {
  it('reads the addresses of drafts and posts', () => {
    expect(parsePostRef('https://www.lesswrong.com/editPost?postId=AbCdEfGhIjKlMnOpQ&key=k3y_x')).toEqual({ postId: 'AbCdEfGhIjKlMnOpQ', key: 'k3y_x' });
    expect(parsePostRef('https://www.lesswrong.com/posts/AbCdEfGhIjKlMnOpQ/some-slug')).toEqual({ postId: 'AbCdEfGhIjKlMnOpQ', key: null });
    expect(parsePostRef('AbCdEfGhIjKlMnOpQ')).toEqual({ postId: 'AbCdEfGhIjKlMnOpQ', key: null });
    expect(parsePostRef('https://example.com/editPost?postId=AbCdEfGhIjKlMnOpQ')).toBeNull();
  });

  it('reads read_post and the comment threads of /api/editPost', () => {
    expect(parseReadPost('# A title\n\npostId: AbCdEfGhIjKlMnOpQ\ndraft: true\n\nBody text.\n', 'x')).toEqual({ id: 'AbCdEfGhIjKlMnOpQ', title: 'A title', draft: true, markdown: 'Body text.\n' });
    const page = 'Title: T\n\n* * *\n\nBody.\n\n* * *\n\n## Comment Threads\n\n2 open threads. To reply: POST /api/agent/replyToComment { postId, key, threadId, comment }\n\n### Thread `t1` · comment\n> the quoted\n> words\n**Kirsten** (2026-10-21, 14:05): First line\nsecond line\n**Ada** (2026-10-21, 14:07): A reply\n\n### Thread `t2` · suggestion\nSuggested insert: "x"\n\n* * *\n\n## Navigation\n';
    expect(parseThreads(page)).toEqual([
      { id: 't1', type: 'comment', quote: 'the quoted\nwords', comments: [{ author: 'Kirsten', time: Date.UTC(2026, 9, 21, 14, 5), text: 'First line\nsecond line' }, { author: 'Ada', time: Date.UTC(2026, 9, 21, 14, 7), text: 'A reply' }] },
      { id: 't2', type: 'suggestion', quote: '', comments: [] },
    ]);
  });
});

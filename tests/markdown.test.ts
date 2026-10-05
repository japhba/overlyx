/**
 * Markdown documents (core md/): the parser maps markdown onto the document model, the writer maps
 * it back — from scratch, or into the file's own text so unchanged blocks keep their bytes — and the
 * document manager opens, edits and saves a .md file like a .tex one.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseMarkdown, writeMarkdown, writeMarkdownPreserving, markdownLayoutFor } from '../packages/core/src/md/index.ts';
import type { Inset, Item, LyxDocument, Paragraph } from '../packages/core/src/lyx/ast.ts';
import { getAuthors } from '../packages/core/src/lyx/ast.ts';
import { parseThread } from '../packages/core/src/comments.ts';

const body = (md: string) => parseMarkdown(md).doc.body;
const insetOf = (p: Paragraph, k = 0): Inset => (p.items.filter(i => i.kind === 'inset')[k] as Extract<Item, { kind: 'inset' }>).inset;
const roundTrip = (md: string) => writeMarkdown(parseMarkdown(md).doc).text;
const sameModel = (a: string, b: string) => expect(JSON.stringify(parseMarkdown(b).doc.body)).toBe(JSON.stringify(parseMarkdown(a).doc.body));

describe('markdown → document model', () => {
  it('headings, paragraphs and inline formatting', () => {
    const [h1, h3, p] = body('# Title\n\n### Third\n\nSome *em*, **bold**, `code`, ~~gone~~ and <u>under</u>.\n');
    expect([h1.layout, h3.layout]).toEqual(['Section', 'Subsubsection']);
    const fonts = p.items.map(i => (i.kind === 'text' ? [i.text, i.font] : null)).filter(Boolean);
    expect(fonts).toEqual([
      ['Some ', {}], ['em', { emph: 'on' }], [', ', {}], ['bold', { series: 'bold' }], [', ', {}], ['code', { family: 'typewriter' }],
      [', ', {}], ['gone', { strikeout: 'on' }], [' and ', {}], ['under', { bar: 'under' }], ['.', {}],
    ]);
  });

  it('lists nest by depth, continuation paragraphs sit one level below their item', () => {
    const pars = body('- a\n  - b\n- c\n\n  more c\n1. one\n');
    expect(pars.map(p => [p.layout, p.depth])).toEqual([['Itemize', 0], ['Itemize', 1], ['Itemize', 0], ['Standard', 1], ['Enumerate', 0]]);
  });

  it('quotes, fenced code with its language, display math, rules, tables', () => {
    const pars = body('> quoted\n\n```python\nx = 1\n```\n\n$$\na^2\n$$\n\n---\n\n| a | b |\n|:-:|--:|\n| 1 | 2 |\n');
    expect(pars[0].layout).toBe('Quote');
    const code = insetOf(pars[1]);
    expect(code.type === 'Text' && code.name).toBe('listings');
    expect(code.type === 'Text' && code.params[0]).toBe('lstparams "language=python"');
    expect(insetOf(pars[2])).toEqual({ type: 'Formula', inline: false, latex: '\\[a^2\\]' });
    expect(insetOf(pars[3]).type === 'Leaf' && (insetOf(pars[3]) as { arg: string }).arg).toBe('line');
    const t = insetOf(pars[4]);
    expect(t.type).toBe('Tabular');
    if (t.type === 'Tabular') expect(t.columns.map(c => c.attrs[0][1])).toEqual(['center', 'right']);
  });

  it('inline math, but no math out of prices', () => {
    const [p] = body('Area $\\pi r^2$ costs $5 and $10.\n');
    expect(p.items.filter(i => i.kind === 'inset').map(i => (i as { inset: Inset }).inset)).toEqual([{ type: 'Formula', inline: true, latex: '$\\pi r^2$' }]);
    expect(p.items.map(i => (i.kind === 'text' ? i.text : '')).join('')).toContain('costs $5 and $10.');
  });

  it('footnotes become Foot insets at their reference, with their label', () => {
    const [p] = body('Text[^a].\n\n[^a]: The note.\n');
    const f = insetOf(p);
    expect(f.type === 'Text' && f.name).toBe('Foot');
    expect(f.type === 'Text' && f.params).toEqual(['label "a"']);
    expect(f.type === 'Text' && f.paragraphs[0].items[0]).toMatchObject({ text: 'The note.' });
  });

  it('comment threads and notes are HTML comments; tracked changes <ins>/<del> with their author', () => {
    const md = 'Text<!-- @comment\n    Jan Bauer (2026-10-04 12:00):\n    Why?\n    Kirsten (2026-10-04 13:00):\n    Because.\n    --> and <ins author="Kirsten" datetime="2026-10-04T13:00:00Z">new</ins> <del author="Jan Bauer" datetime="2026-10-04T12:00:00Z">old</del>.\n\n<!-- a note -->\n';
    const r = parseMarkdown(md);
    const [p, n] = r.doc.body;
    const c = insetOf(p);
    expect(c.type === 'Text' && [c.name, c.arg]).toEqual(['Note', 'Comment']);
    const thread = parseThread(c.type === 'Text' ? c.paragraphs : []);
    expect(thread.messages.map(m => [m.author, m.text])).toEqual([['Jan Bauer', 'Why?'], ['Kirsten', 'Because.']]);
    const changed = p.items.filter(i => i.change);
    expect(changed.map(i => [i.kind === 'text' && i.text, i.change!.type])).toEqual([['new', 'inserted'], ['old', 'deleted']]);
    expect(changed[0].change!.time).toBe(Date.parse('2026-10-04T13:00:00Z') / 1000);
    expect(getAuthors(r.doc.header).map(a => a.name).sort()).toEqual(['Jan Bauer', 'Kirsten']);
    const note = insetOf(n);
    expect(note.type === 'Text' && [note.arg, note.paragraphs[0].items[0]]).toEqual(['Note', { kind: 'text', text: 'a note', font: {} }]);
  });

  it('a comment at the start of a paragraph stays in that paragraph', () => {
    const pars = body('<!-- @comment\n    Jan (2026-10-04 12:00):\n    hm\n    -->Text after the thread\\\nand a second line.\n\nNext.\n');
    expect(pars.length).toBe(2);
    expect(insetOf(pars[0]).type).toBe('Text');
    expect(pars[0].items.map(i => (i.kind === 'text' ? i.text : i.kind === 'inset' && i.inset.type === 'Leaf' ? '⏎' : '')).join('')).toBe('Text after the thread⏎and a second line.');
  });

  it('front matter is kept verbatim, links and images keep their targets', () => {
    const r = parseMarkdown('---\ntitle: X\n---\n\nSee [the docs](https://x.y "Docs") and ![logo](img/logo.png).\n');
    expect(r.doc.preamble).toEqual(['---', 'title: X', '---']);
    const [p] = r.doc.body;
    const link = insetOf(p), img = insetOf(p, 1);
    expect(link.type === 'Leaf' && link.params).toEqual(['LatexCommand href', 'name "the docs"', 'target "https://x.y"', 'title "Docs"', 'literal "true"']);
    expect(img.type === 'Leaf' && img.params).toEqual(['\tfilename img/logo.png', '\tspecial alt={logo}']);
  });
});

describe('document model → markdown', () => {
  const SAMPLE = [
    '---', 'title: Demo', '---', '', '# Title', '',
    'Some *em*, **bold**, `code`, ~~strike~~, $x^2$, a [link](https://a.b), <https://c.d>, a footnote[^1] and snake_case_name.', '',
    '- one', '  - nested', '- two', '', '1. first', '2. second', '', '> quoted', '>', '> - in a quote', '',
    '$$', 'E = mc^2', '$$', '', '```js', 'let x = `y`;', '```', '', '---', '', '![A cat](img/cat.png)', '',
    '| a   | b      |', '| :-: | -----: |', '| 1   | 2 \\| 3 |', '',
    'Commented<!-- @comment', '    Jan (2026-10-04 12:00):', '    the -- comment', '    --> and <ins author="Jan" datetime="2026-10-04T12:00:00Z">inserted **bold**</ins> text.', '',
    '- [ ] task', '- [x] done', '', '[^1]: The note.', '',
  ].join('\n');

  it('the canonical markdown reads back as the same document, and writing it again changes nothing', () => {
    const once = roundTrip(SAMPLE);
    sameModel(SAMPLE, once);
    expect(roundTrip(once)).toBe(once);
    expect(once).toBe(SAMPLE);
  });

  it('text that looks like markup is escaped', () => {
    const doc = parseMarkdown('x\n').doc;
    const texts = ['# not a heading', '- not a list', '1. not a list', '*stars* and _under_ and `ticks`', 'a $5 price', '<div> and [link](x) and a\\b', '> no quote', '~~not struck~~'];
    doc.body = texts.map(t => ({ layout: 'Standard', depth: 0, params: {}, items: [{ kind: 'text', text: t, font: {} }] }));
    const md = writeMarkdown(doc).text;
    expect(parseMarkdown(md).doc.body.map(p => p.items.map(i => (i.kind === 'text' ? i.text : '?')).join(''))).toEqual(texts);
  });

  it('emphasis that the delimiter rules cannot express is written as HTML tags', () => {
    const doc = parseMarkdown('x\n').doc;
    doc.body = [{ layout: 'Standard', depth: 0, params: {}, items: [
      { kind: 'text', text: 'a', font: {} }, { kind: 'text', text: '"quoted"', font: { series: 'bold' } }, { kind: 'text', text: 'b', font: {} },
    ] }];
    const md = writeMarkdown(doc).text;
    expect(md).toContain('<strong>"quoted"</strong>');
    expect(JSON.stringify(parseMarkdown(md).doc.body)).toBe(JSON.stringify(doc.body));
  });

  it('a formula, image, footnote, script, line break or comment inside emphasis stays inside it', () => {
    // each used to end the emphasis: written back as `<em>the value </em>$x$<em> is</em>`
    for (const md of ['*the value $x$ is* known.', 'Let *$x$* be given.', '**bold $x$ text** here', '*see ![i](a.png) here* x', '*a<sub>2</sub> b* c', '*a <kbd>K</kbd> b* x', '*a\\\nb* x', 'a *b <!-- note --> c* d', '*text[^1] more* x\n\n[^1]: The note.']) {
      expect(roundTrip(md + '\n')).toBe(md + '\n');
    }
    const [p] = body('*the value $x$ is*\n');
    expect(p.items.map(i => i.font)).toEqual([{ emph: 'on' }, { emph: 'on' }, { emph: 'on' }]);
    // the script carries the emphasis around it; its text only what is set inside it
    expect((insetOf(body('*a<sub>**2**</sub>*\n')[0]) as Extract<Inset, { type: 'Text' }>).paragraphs[0].items[0].font).toEqual({ series: 'bold' });
  });

  it('emphasis on the space after a word is written with delimiters, not HTML tags', () => {
    // typed with Ctrl+I: the space after "value" is italic too; a space shows no emphasis
    const doc = parseMarkdown('x\n').doc;
    doc.body = [{ layout: 'Standard', depth: 0, params: {}, items: [
      { kind: 'text', text: 'the value ', font: { emph: 'on' } },
      { kind: 'inset', font: {}, inset: { type: 'Formula', inline: true, latex: '$x$' } },
      { kind: 'text', text: ' and ', font: {} }, { kind: 'text', text: 'bold ', font: { series: 'bold' } }, { kind: 'text', text: 'end.', font: {} },
    ] }];
    expect(writeMarkdown(doc).text).toBe('*the value* $x$ and **bold** end.\n');
    // …also at the end of the paragraph, while typing on in italic
    doc.body[0].items = [{ kind: 'text', text: 'So ', font: {} }, { kind: 'text', text: 'typing on ', font: { emph: 'on' } }];
    expect(writeMarkdown(doc).text).toBe('So *typing on*\n');
    // a mark that continues stays open; the longer one is outermost
    expect(roundTrip('_Note: this **does not** work._ And **_both_** here.\n')).toBe('*Note: this **does not** work.* And ***both*** here.\n');
  });

  it('LaTeX-only constructs degrade to their closest markdown, with warnings', () => {
    const doc = parseMarkdown('x\n').doc;
    doc.body = [
      { layout: 'Chapter', depth: 0, params: {}, items: [{ kind: 'text', text: 'Intro', font: {} }] },
      { layout: 'Standard', depth: 0, params: {}, items: [{ kind: 'text', text: 'Small caps', font: { noun: 'on' } }, { kind: 'inset', font: {}, inset: { type: 'Leaf', name: 'CommandInset', arg: 'citation', params: ['LatexCommand cite', 'key "knuth84"'] } }] },
    ];
    const r = writeMarkdown(doc);
    expect(r.text).toBe('# Intro\n\nSmall caps\\[@knuth84]\n');
    expect(r.warnings.join('\n')).toMatch(/small caps/);
    expect(markdownLayoutFor('Quotation')).toBe('Quote');
    expect(markdownLayoutFor('Description')).toBe('Itemize');
  });
});

describe('writing into the file', () => {
  const FILE = [
    'Intro paragraph with *stars*', 'wrapped over two lines.', '',
    '* bullet with a star', '* another', '',
    'Reference [link][r].', '', '[r]: https://example.com', '',
    'Setext heading', '==============', '',
    'Last paragraph[^n].', '', '[^n]: A footnote', '    on two lines.', '',
  ].join('\n');

  it('gives the file back byte for byte', () => {
    const r = parseMarkdown(FILE);
    expect(writeMarkdownPreserving(r.doc, FILE).text).toBe(FILE);
  });

  it('an edit rewrites only the edited block', () => {
    const doc = parseMarkdown(FILE).doc;
    const last = doc.body.findIndex(p => p.items.some(i => i.kind === 'text' && i.text.startsWith('Last')));
    (doc.body[last].items[0] as { text: string }).text = 'Last paragraph, edited';
    const out = writeMarkdownPreserving(doc, FILE).text;
    expect(out).toBe(FILE.replace('Last paragraph[^n].', 'Last paragraph, edited[^n].'));
  });

  it('inserted and deleted blocks leave their neighbours and the link definitions alone', () => {
    const doc = parseMarkdown(FILE).doc;
    doc.body.splice(1, 2);   // the two bullets
    doc.body.splice(1, 0, { layout: 'Standard', depth: 0, params: {}, items: [{ kind: 'text', text: 'New paragraph.', font: {} }] });
    const out = writeMarkdownPreserving(doc, FILE).text;
    expect(out).toContain('Intro paragraph with *stars*\nwrapped over two lines.\n\nNew paragraph.\n\nReference [link][r].');
    expect(out).toContain('[r]: https://example.com');
    expect(out).toContain('Setext heading\n==============');
    expect(out).not.toContain('bullet');
  });
});

describe('the document manager with a .md file', async () => {
  const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), 'overlyx-markdown-test');
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(ROOT, 'projects', 'u', 'p'), { recursive: true });
  process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');
  process.env.OVERLYX_PROJECTS_DIR = join(ROOT, 'projects');
  const { manager } = await import('../packages/server/src/docs.ts');
  const file = join(ROOT, 'projects', 'u', 'p', 'notes.md');
  const TEXT = '# Notes\n\nFirst  paragraph, *kept* as it is.\n\n* one\n* two\n\nSecond paragraph.\n';
  writeFileSync(file, TEXT);

  it('opens it as a document, saves an edit as markdown, everything else untouched', async () => {
    const doc = await manager.open('u/p/notes.md');
    expect(doc.toText()).toBe(TEXT);
    const lyx: LyxDocument = doc.toLyxDocument();
    expect(lyx.body.map(p => p.layout)).toEqual(['Section', 'Standard', 'Itemize', 'Itemize', 'Standard']);
    (lyx.body[4].items[0] as { text: string }).text = 'Second paragraph, **now** edited.';
    doc.loadFromLyx(lyx, 'test');
    expect(await doc.saveToFile()).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(TEXT.replace('Second paragraph.', 'Second paragraph, \\*\\*now\\*\\* edited.'));
    expect(doc.health()).toEqual([]);
  });

  it('merges a change made to the file on disk', async () => {
    const doc = await manager.open('u/p/notes.md');
    const now = readFileSync(file, 'utf8');
    writeFileSync(file, now.replace('# Notes', '# Notes from git'));
    await doc.absorbExternalChangeAsync();
    expect(doc.toLyxDocument().body[0].items[0]).toMatchObject({ text: 'Notes from git' });
    expect(existsSync(file)).toBe(true);
  });

  it('reports markdown as its format and only the layouts markdown has', async () => {
    const doc = await manager.open('u/p/notes.md');
    const meta = await doc.metaAsync();
    expect(meta.format).toBe('markdown');
    expect((meta.layouts as { name: string }[]).map(l => l.name).sort()).toEqual(['Enumerate', 'Itemize', 'Paragraph', 'Quote', 'Section', 'Standard', 'Subparagraph', 'Subsection', 'Subsubsection']);
  });
});

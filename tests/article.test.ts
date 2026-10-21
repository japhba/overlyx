/**
 * HTML articles (core html/article.ts): a page's prose read as a document — headings, paragraphs,
 * lists, formulas, citations, notes, figures — and HTML blocks kept as their source; written back
 * into the page's own text so that unchanged blocks keep their bytes, an edited block its start tag,
 * and the markup between blocks (sections, comments) stays where it is.
 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArticle, writeArticlePreserving, writeArticle, isArticleHtml, blockKey, htmlBlockOf, rawSource } from '../packages/core/src/html/article.ts';
import { newArticleText, articleVars } from '../packages/core/src/html/articletheme.ts';
import type { Item, LyxDocument, Paragraph } from '../packages/core/src/lyx/ast.ts';

const text = (s: string, font = {}): Item => ({ kind: 'text', text: s, font });
const par = (layout: string, items: Item[], depth = 0): Paragraph => ({ layout, depth, params: {}, items });
const plain = (p: Paragraph) => p.items.map(i => (i.kind === 'text' ? i.text : `[${i.kind === 'inset' ? (i.inset.type === 'Formula' ? i.inset.latex : i.inset.type === 'Leaf' ? i.inset.arg || i.inset.name : i.inset.type === 'Text' ? i.inset.name : '') : ''}]`)).join('');
const with_ = (doc: LyxDocument, body: Paragraph[]): LyxDocument => ({ ...doc, body });

const PAGE = `<!DOCTYPE html>
<html><head><meta name="overlyx" content="article"><title>X</title>
<style>:root { --accent: teal; } body { margin: 0 }</style></head>
<body>
<header class="site"><a href="/">Home</a></header>
<article class="post">
  <section id="intro">
    <h2 class="sec">Introduction</h2>
    <p class="lede">We study <em>clean</em> networks<!-- @comment
    Ann (2026-10-20 10:00):
    Is this true?
    --> citing \\citep[see][p.~3]{olah2020} and \\eqref{eq:a}, with \\(x^2\\).<span class="sidenote">A note.</span></p>
    <ul>
      <li>One <strong>bold</strong></li>
      <li><p>Two</p><p>Two more</p></li>
    </ul>
  </section>
  <section id="method">
    <h2>Method</h2>
    <blockquote><p>A quote.</p></blockquote>
    <figure class="wide"><img src="figs/a.png" alt="A plot"><figcaption>The plot.</figcaption></figure>
    <div class="widget" id="w"><canvas></canvas><script>draw()</script></div>
    <p>Last <ins author="Bob" datetime="2026-10-20T10:00:00Z">new</ins> words.</p>
  </section>
</article>
<script src="app.js"></script>
</body></html>
`;

describe('HTML articles', () => {
  it('knows an article by its meta tag', () => {
    expect(isArticleHtml(PAGE)).toBe(true);
    expect(isArticleHtml(newArticleText({ title: 'T' }))).toBe(true);
    expect(isArticleHtml('<html><head><meta name="overlyx" content="deck"></head><body></body></html>')).toBe(false);
    expect(isArticleHtml('<html><body><meta name="overlyx" content="article"></body></html>')).toBe(false);
  });

  it('reads the prose of the <article> as paragraphs and insets', () => {
    const { doc, region } = parseArticle(PAGE);
    expect(PAGE.slice(region.start, region.start + 12)).toBe('\n  <section ');
    const body = doc.body;
    expect(body.map(p => p.layout)).toEqual(['Section', 'Standard', 'Itemize', 'Itemize', 'Standard', 'Section', 'Quote', 'Standard', 'Standard', 'Standard']);
    expect(body[5 - 1].depth).toBe(1);
    const lede = body[1];
    expect(plain(lede)).toBe('We study clean networks[Note] citing [citation] and [ref], with [$x^2$].[Foot]');
    const cite = lede.items.find(i => i.kind === 'inset' && i.inset.type === 'Leaf' && i.inset.arg === 'citation');
    expect(cite?.kind === 'inset' && cite.inset.type === 'Leaf' && cite.inset.params).toEqual(['LatexCommand citep', 'after "p.~3"', 'before "see"', 'key "olah2020"', 'literal "true"']);
    const fig = body[7].items[0];
    expect(fig.kind === 'inset' && fig.inset.type === 'Text' && fig.inset.name === 'Float' && fig.inset.params).toEqual(['wide true', 'sideways false']);
    const widget = htmlBlockOf(body[8]);
    expect(widget && rawSource(widget)).toBe('<div class="widget" id="w"><canvas></canvas><script>draw()</script></div>');
    expect(body[9].items.some(i => i.change?.type === 'inserted')).toBe(true);
  });

  it('writes a page it read back to the byte', () => {
    for (const page of [PAGE, newArticleText({ title: 'A title', author: 'Your Name', date: new Date('2026-10-21') })]) {
      expect(writeArticlePreserving(parseArticle(page).doc, page).text).toBe(page);
    }
  });

  it('keeps an edited block\'s start tag and the sections around the blocks', () => {
    const { doc } = parseArticle(PAGE);
    const body = structuredClone(doc.body);
    body[1] = { ...body[1], items: [text('We carefully study '), ...body[1].items.slice(1)] };
    // a paragraph at the end of the first section, a heading and its text at the end of the article
    body.splice(5, 0, par('Standard', [text('Closing the intro.')]));
    body.push(par('Section', [text('Conclusion')]), par('Standard', [text('Done.')]));
    const out = writeArticlePreserving(with_(doc, body), PAGE).text;
    expect(out).toContain('<p class="lede">We carefully study <em>clean</em>');
    expect(out).toMatch(/Two more<\/p><\/li>\n {4}<\/ul>\n {4}<p>Closing the intro\.<\/p>\n {2}<\/section>/);
    expect(out).toMatch(/<\/section>\n {2}<h2>Conclusion<\/h2>\n {2}<p>Done\.<\/p>\n<\/article>/);
    expect(out.slice(0, out.indexOf('<article'))).toBe(PAGE.slice(0, PAGE.indexOf('<article')));
    // what it wrote reads back as what was written
    expect(JSON.stringify(parseArticle(out).doc.body)).toBe(JSON.stringify(body));
  });

  it('drops a deleted block and leaves the markup around it', () => {
    const { doc } = parseArticle(PAGE);
    const body = doc.body.filter((_p, i) => i !== 6);
    const out = writeArticlePreserving(with_(doc, body), PAGE).text;
    expect(out).not.toContain('blockquote');
    expect(out).toContain('<h2>Method</h2>\n    <figure class="wide">');
  });

  it('writes a document from scratch inside a page of its own', () => {
    const doc: LyxDocument = { preamble: [], format: 643, header: { lines: [] }, trailer: [], body: [par('Title', [text('Hello')]), par('Standard', [text('a < b & c', { series: 'bold' }), { kind: 'inset', inset: { type: 'Formula', inline: true, latex: '$a<b$' }, font: {} }])] };
    const out = writeArticle(doc).text;
    expect(isArticleHtml(out)).toBe(true);
    expect(out).toContain('<h1>Hello</h1>');
    expect(out).toContain('<p><strong>a &lt; b &amp; c</strong>\\(a&lt;b\\)</p>');
    expect(plain(parseArticle(out).doc.body[1])).toBe('a < b & c[$a<b$]');
  });

  it('names an HTML block by its source, as the server finds it', () => {
    expect(blockKey('<div>a</div>')).toBe(blockKey('<div>a</div>'));
    expect(blockKey('<div>a</div>')).not.toBe(blockKey('<div>b</div>'));
  });

  it('reads the look from the page: custom properties at :root, not inside @media', () => {
    const vars = articleVars('<style>@media (prefers-color-scheme: dark) { :root { --ink: white } } :root { --ink: #111; --measure: 700px }</style><link rel="stylesheet" href="look.css">', f => (f === 'look.css' ? ':root{--accent:teal}' : undefined));
    expect(vars).toEqual({ '--ink': '#111', '--measure': '700px', '--accent': 'teal' });
  });
});

describe('the document manager with an article', async () => {
  const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), 'overlyx-article-test');
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(ROOT, 'projects', 'u', 'p', 'post'), { recursive: true });
  process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');
  process.env.OVERLYX_PROJECTS_DIR = join(ROOT, 'projects');
  const { manager } = await import('../packages/server/src/docs.ts');
  const { isDocumentFile } = await import('../packages/server/src/projects.ts');
  const { liveHtml, embedHtml } = await import('../packages/server/src/deliverables.ts');
  const file = join(ROOT, 'projects', 'u', 'p', 'post', 'index.html');
  writeFileSync(file, PAGE);

  it('opens the page as a document and saves an edit into it', async () => {
    expect(isDocumentFile('u/p', 'post/index.html')).toBe(true);
    const doc = await manager.open('u/p/post/index.html');
    expect(doc.toText()).toBe(PAGE);
    const lyx = doc.toLyxDocument();
    lyx.body[9] = par('Standard', [text('Last words, edited.')]);
    doc.loadFromLyx(lyx, 'test');
    expect(await doc.saveToFile()).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(PAGE.replace(/<p>Last <ins[^]*?words\.<\/p>/, '<p>Last words, edited.</p>'));
    expect((await doc.metaAsync()).format).toBe('article');
    expect((await doc.metaAsync()).article?.vars).toEqual({ '--accent': 'teal' });
  });

  it('serves the page as it is now, and one HTML block of it marked for the editor', async () => {
    const doc = await manager.open('u/p/post/index.html');
    const lyx = doc.toLyxDocument();
    lyx.body[0] = par('Section', [text('Intro, live')]);
    doc.loadFromLyx(lyx, 'test');
    expect(await liveHtml('u/p', 'post/index.html')).toContain('<h2 class="sec">Intro, live</h2>');
    const block = '<div class="widget" id="w"><canvas></canvas><script>draw()</script></div>';
    expect(await embedHtml('u/p', 'post/index.html', blockKey(block))).toContain(`<template data-ol-embed></template>${block}<template data-ol-embed-end></template>`);
  });
});

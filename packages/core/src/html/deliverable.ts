/**
 * HTML deliverables: a folder with an index.html — a slide deck, a poster or a web page — that
 * agents design freely (any HTML, CSS, JavaScript, SVG) and people edit on a canvas, present and
 * export (source.ts turns canvas edits into edits of the text). What OverLyX relies on is little:
 * the kind (`<meta name="overlyx" content="deck|poster|page">`), pages as elements of class
 * `slide` of a fixed size, TeX math between \( \) / \[ \]. DELIVERABLE_GUIDE says it to agents.
 */
import { parseSource, walk, attr, hasClass, pathOf, elementChildren, type HElement, type HDocument, type Path } from './source.ts';

export type DeliverableKind = 'deck' | 'poster' | 'page';
export const DELIVERABLE_KINDS: DeliverableKind[] = ['deck', 'poster', 'page'];

export function isHtmlPath(p: string): boolean {
  return /\.html?$/i.test(p);
}

/** the pages of a deck or poster: elements of class "slide" not inside another one, in document order */
export function slideElements(doc: HDocument): HElement[] {
  const out: HElement[] = [];
  const visit = (n: HElement | HDocument) => {
    for (const c of elementChildren(n)) {
      if (hasClass(c, 'slide')) { out.push(c); continue; }
      if (c.tagName !== 'template' && c.tagName !== 'script' && c.tagName !== 'style') visit(c);
    }
  };
  visit(doc);
  return out;
}

export interface DeliverableInfo {
  kind: DeliverableKind;
  title: string;
  /** paths of the pages (decks, posters) */
  slides: Path[];
}

export function deliverableKindOf(doc: HDocument, slides = slideElements(doc)): DeliverableKind {
  for (const el of walk(doc)) {
    if (el.tagName === 'meta' && (attr(el, 'name') ?? '').toLowerCase() === 'overlyx') {
      const k = (attr(el, 'content') ?? '').trim().toLowerCase().split(/[\s;,]/)[0];
      if (k === 'deck' || k === 'slides') return 'deck';
      if (k === 'poster') return 'poster';
      if (k === 'page' || k === 'webpage') return 'page';
    }
  }
  return slides.length > 1 ? 'deck' : slides.length === 1 ? 'poster' : 'page';
}

export function deliverableInfo(text: string): DeliverableInfo {
  const { doc } = parseSource(text);
  const slides = slideElements(doc);
  const titleEl = [...walk(doc)].find(e => e.tagName === 'title');
  const title = titleEl ? textOf(titleEl).trim() : '';
  return { kind: deliverableKindOf(doc, slides), title, slides: slides.map(pathOf) };
}

function textOf(el: HElement): string {
  let s = '';
  for (const n of el.childNodes) s += 'value' in n ? (n as { value: string }).value : 'tagName' in n ? textOf(n as HElement) : '';
  return s;
}

/* ------------------------------------------------------------------ what agents are told */

export const DELIVERABLE_GUIDE = `Slide decks, posters and web pages are HTML deliverables: a folder with an index.html, plus any CSS, JavaScript, images or fonts you put next to it. Design them freely — layout, typography, colour, SVG, CSS, JavaScript — as a web designer would, for the kind of deliverable the user asked for. OverLyX shows the page live to the people in the project, lets them present it and export it as PDF, and lets them edit it on a canvas.

The conventions OverLyX relies on (everything else is up to you):
- <meta name="overlyx" content="deck"> in <head> — or content="poster" / "page" — says what it is.
- Deck: every slide is an element of class "slide", all of one fixed size set in CSS, e.g. .slide { width: 1280px; height: 720px; position: relative; overflow: hidden }. Poster: a single .slide the size of the poster (e.g. width: 841mm; height: 1189mm for A0 portrait). Page: an ordinary responsive web page, no .slide.
- Write no navigation or presentation code and never hide slides: OverLyX stacks the slides while editing, shows one at a time when presenting, and prints one per PDF page. Speaker notes go in <aside class="notes"> inside the slide (not shown on it).
- Math: TeX between \\( \\) inline, \\[ \\] or $$ $$ displayed. OverLyX typesets it with MathJax — no script needed.
- Files by relative paths (figures/plot.svg, ../figures/fig.pdf). PDF figures are shown as SVG, so a paper's figures can be used directly.
- So people can edit on the canvas: make each object of a slide (text block, image, shape, chart) a direct child of the .slide with position: absolute and its left/top/width (and height where it matters) — inline or in CSS — so it can be moved and resized; keep text in plain elements (h1–h4, p, ul/ol/li, span, strong, em, a) so it can be retyped in place. Anything else (an SVG drawing, a canvas, a script-made chart) still shows and can be moved and resized, but is changed in the code.

Tools: create_deliverable starts a folder for a kind; read_file / edit_file / write_file edit its files (applied live in people's editors); render_page shows you a page as an image and lists problems (text overflowing its box, objects overlapping or off the page, text too small to read). Look at your pages with render_page after every substantial change and fix what it reports.`;

/* ------------------------------------------------------------------ starting points */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A deck to start from: a title slide and a content slide in a plain, readable design. */
export function starterDeck(title: string): string {
  const t = esc(title || 'Untitled talk');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="overlyx" content="deck">
<title>${t}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap" rel="stylesheet">
<style>
  :root { --ink: #1d2433; --muted: #5b6475; --accent: #2f6fde; --paper: #ffffff; }
  body { margin: 0; background: #e9ebef; font-family: Inter, system-ui, sans-serif; color: var(--ink); }
  .slide { width: 1280px; height: 720px; position: relative; overflow: hidden; background: var(--paper); margin: 0 auto 40px; }
  .slide h1 { font-size: 64px; font-weight: 800; line-height: 1.1; margin: 0; }
  .slide h2 { font-size: 44px; font-weight: 800; margin: 0; }
  .slide p, .slide li { font-size: 28px; line-height: 1.45; margin: 0 0 14px; }
  .slide ul { margin: 0; padding-left: 1.1em; }
  .muted { color: var(--muted); }
  .bar { background: var(--accent); }
</style>
</head>
<body>

<section class="slide">
  <div class="bar" style="position: absolute; left: 0; top: 0; width: 24px; height: 720px"></div>
  <h1 style="position: absolute; left: 120px; top: 250px; width: 1040px">${t}</h1>
  <p class="muted" style="position: absolute; left: 120px; top: 420px; width: 1040px">Your name · Venue · Date</p>
</section>

<section class="slide">
  <h2 style="position: absolute; left: 96px; top: 72px; width: 1088px">The idea</h2>
  <ul style="position: absolute; left: 96px; top: 190px; width: 620px">
    <li>One message per slide</li>
    <li>Math is TeX: \\(e^{i\\pi} + 1 = 0\\)</li>
    <li>Pictures carry the argument</li>
  </ul>
  <div style="position: absolute; left: 780px; top: 190px; width: 400px; height: 400px; border-radius: 24px; background: #eef3fd"></div>
  <aside class="notes">Speaker notes go here.</aside>
</section>

</body>
</html>
`;
}

/** An A0 portrait poster to start from: a title band and three columns. */
export function starterPoster(title: string): string {
  const t = esc(title || 'Untitled poster');
  const col = (x: number, head: string, body: string) => `  <div class="block" style="position: absolute; left: ${x}mm; top: 230mm; width: 245mm">
    <h2>${head}</h2>
    <p>${body}</p>
  </div>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="overlyx" content="poster">
<title>${t}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap" rel="stylesheet">
<style>
  :root { --ink: #1d2433; --muted: #5b6475; --accent: #2f6fde; }
  body { margin: 0; background: #e9ebef; font-family: Inter, system-ui, sans-serif; color: var(--ink); }
  .slide { width: 841mm; height: 1189mm; position: relative; overflow: hidden; background: #fff; margin: 0 auto; }
  .band { background: var(--accent); color: #fff; }
  h1 { font-size: 110pt; font-weight: 800; line-height: 1.05; margin: 0; }
  h2 { font-size: 54pt; font-weight: 800; margin: 0 0 12mm; color: var(--accent); }
  p { font-size: 30pt; line-height: 1.4; margin: 0 0 10mm; }
</style>
</head>
<body>

<section class="slide">
  <div class="band" style="position: absolute; left: 0; top: 0; width: 841mm; height: 190mm">
    <h1 style="position: absolute; left: 40mm; top: 40mm; width: 761mm">${t}</h1>
    <p style="position: absolute; left: 40mm; top: 130mm; width: 761mm">Authors · Affiliations</p>
  </div>
${col(40, 'Question', 'What problem does this work address, and why does it matter?')}
${col(298, 'Method', 'The approach in one picture. Math is TeX: \\(\\nabla \\cdot E = \\rho / \\varepsilon_0\\).')}
${col(556, 'Result', 'The finding, with the figure that shows it.')}
</section>

</body>
</html>
`;
}

/** A one-page website to start from (a project page). */
export function starterPage(title: string): string {
  const t = esc(title || 'Untitled page');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="overlyx" content="page">
<title>${t}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap" rel="stylesheet">
<style>
  :root { --ink: #1d2433; --muted: #5b6475; --accent: #2f6fde; }
  body { margin: 0; font-family: Inter, system-ui, sans-serif; color: var(--ink); line-height: 1.6; }
  header { padding: 96px 24px 64px; text-align: center; background: #f4f6fa; }
  header h1 { font-size: clamp(36px, 6vw, 64px); line-height: 1.1; margin: 0 0 16px; }
  main { max-width: 760px; margin: 0 auto; padding: 48px 24px 96px; font-size: 19px; }
  h2 { margin-top: 48px; }
  .muted { color: var(--muted); }
</style>
</head>
<body>
<header>
  <h1>${t}</h1>
  <p class="muted">Authors · Affiliations</p>
</header>
<main>
  <h2>Abstract</h2>
  <p>A short summary of the work. Math is TeX: \\(E = mc^2\\).</p>
  <h2>Results</h2>
  <p>What was found, with figures.</p>
</main>
</body>
</html>
`;
}

export function starterFor(kind: DeliverableKind, title: string): string {
  return kind === 'deck' ? starterDeck(title) : kind === 'poster' ? starterPoster(title) : starterPage(title);
}

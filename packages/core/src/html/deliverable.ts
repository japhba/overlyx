/**
 * HTML deliverables: a folder with an index.html — a slide deck, a poster or a web page — that
 * agents design freely (any HTML, CSS, JavaScript, SVG) and people edit on a canvas, present and
 * export (source.ts turns canvas edits into edits of the text). What OverLyX relies on is little:
 * the kind (`<meta name="overlyx" content="deck|poster|page">`), pages as elements of class
 * `slide` of a fixed size, TeX math between \( \) / \[ \]. DELIVERABLE_GUIDE says it to agents.
 */
import { scientificDeck, scientificPoster } from './scientific.ts';
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
- Optional <body data-ol-layout-margins="72px 96px"> marks a template safe area (CSS margin shorthand: top/right/bottom/left; px, pt, mm, cm, in or %). The editor shows these as fixed purple dotted lines and objects snap to them while editing; unlike guides they cannot be dragged or reset. A slide may override the body's margins with its own data-ol-layout-margins.
- Placeholders, as in Google Slides' layouts: data-ol-ph="title" (or subtitle, body, text, picture) on an object of a slide. While empty the editor shows a prompt in it ("Click to add title") and nothing of it shows when presenting or in the PDF; put the slide's title in its title placeholder, its points as <li> in its body placeholder (a <ul>). Layouts of the deck: <template data-ol-layout="Name"><section class="slide">…</section></template> in <body> (never shown) keeps a slide that new slides can be made of — its placeholders empty.
- The slide master, kept in the markup: an object on every slide (a header bar, a logo, a footer) is a copy on each slide with the same data-ol-master="<key>" (e.g. data-ol-master="frame"); the editor keeps the copies identical — changed on one slide, changed on all — so give every repeated piece of a deck's design such a key, and leave it off a slide's own objects. Slide numbers: <span data-ol-field="slide-number">3</span> (and data-ol-field="slide-count" for the total) — write each slide's own number; the editor renumbers as slides are added, moved or removed. data-ol-skip on a slide: kept, but not presented or printed.
- Write no navigation or presentation code and never hide slides with CSS or scripts (data-ol-skip skips one): OverLyX stacks the slides while editing, shows one at a time when presenting, and prints one per PDF page. Speaker notes go in <aside class="notes"> inside the slide (not shown on it).
- Math: TeX between \\( \\) inline, \\[ \\] or $$ $$ displayed. OverLyX typesets it with MathJax — no script needed. Numbered equations as in LaTeX: \\begin{equation}\\label{eq:name} … \\end{equation} (align etc. too), referred to by \\eqref{eq:name} or \\ref{eq:name} anywhere in the text; numbers count through the whole deck.
- Macros: <link rel="overlyx-macros" href="../paper/macros.tex"> in <head> gives every formula the \\newcommand / \\def / \\DeclareMathOperator definitions of that .tex file of the project (and of the files it \\inputs) — use the paper's own notation.
- Citations: \\cite{key}, \\citep{key}, \\citet{key} (natbib's forms, several keys, [pre][post] notes) in the text cite entries of the project's .bib files (all of them, or only those of <link rel="overlyx-bibliography" href="refs.bib">); they show as [1] — or Knuth (1984) with <meta name="overlyx-citations" content="authoryear">. An empty element of class "ol-bibliography" (positioned like any object, e.g. on a last "References" slide) gets the list of the works cited. Keys no .bib file has show as ? and are reported.
- Steps (beamer's overlays, PowerPoint's animations): data-step on any object — an SVG's paths and groups too — says which steps it shows on when presenting. Step 1 is the slide as it comes up; each click goes one step on. data-step="3" means from step 3 on (as after two \pause); otherwise it is a beamer overlay specification: "-3" until step 3, then gone (it disappears on the third click), "2-4" steps 2 to 4, "1,3-" step 1 and from step 3 on. data-steps on a <ul>/<ol> makes its items appear one by one (data-steps="2": the first item at step 2). Nothing is hidden while editing or in the PDF. <meta name="overlyx-steps" content="dim"> shows what comes later faintly instead of hiding it.
- Files by relative paths (figures/plot.svg, ../figures/fig.pdf). PDF figures are shown as SVG, so a paper's figures can be used directly.
- Review (people comment and suggest on the canvas; keep these attributes and elements when you edit around them): data-ol-comments='[{"id":"c1","by":"Name","at":"2026-10-11 14:03","text":"…","re":[{"by":"…","at":"…","text":"…"}]}]' on an object or slide holds its comment threads ("done": true = resolved; "quote": the words commented on) — to answer one, append to its "re" with your name ("AI agent" if you have none); data-ol-ins / data-ol-del ("Name|YYYY-MM-DD HH:MM") mark an object suggested as added / deleted, data-ol-chg with data-ol-was (the old attribute values) one suggested as changed, <ins data-ol-by="…"> / <del data-ol-by="…"> words typed / deleted. Don't accept or reject suggestions (remove these marks) unless asked to; a deleted object stays in the file until then. <meta name="overlyx-suggesting" content="on"> means the people want changes as suggestions.
- So people can edit on the canvas: make each object of a slide (text block, image, shape, chart) a direct child of the .slide with position: absolute and its left/top/width (and height where it matters) — inline or in CSS — so it can be moved and resized; keep text in plain elements (h1–h4, p, ul/ol/li, span, strong, em, a) so it can be retyped in place. Anything else (an SVG drawing, a canvas, a script-made chart) still shows and can be moved and resized, but is changed in the code.

Tools: create_deliverable starts a folder for a kind; read_file / edit_file / write_file edit its files (applied live in people's editors); render_page shows you a page as an image and lists problems (text overflowing its box, objects overlapping or off the page, text too small to read, citations of keys no .bib file has, references to labels that do not exist). Look at your pages with render_page after every substantial change and fix what it reports.`;

/* ------------------------------------------------------------------ starting points */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Scientific starting points; omit the template id to use the first design of its kind. */
export const starterDeck = scientificDeck;
export const starterPoster = scientificPoster;

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

/** the title of a web page still exactly as starterPage made it (nothing written on it yet), else null */
export function untouchedPageTitle(text: string): string | null {
  if (text.length > 4000 || !/<meta name="overlyx" content="page">/.test(text)) return null;
  const { title } = deliverableInfo(text);
  return text === starterPage(title) ? title : null;
}

export function starterFor(kind: DeliverableKind, title: string, template?: string): string {
  if (kind === 'page' && template !== undefined) throw new Error('Web pages do not have scientific templates.');
  return kind === 'deck' ? starterDeck(title, template) : kind === 'poster' ? starterPoster(title, template) : starterPage(title);
}

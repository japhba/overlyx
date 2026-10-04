/**
 * Generate the starter projects every account gets besides the welcome project
 * (packages/server/templates/starters/<id>, created by ensureStarterProjects in
 * packages/server/src/access.ts): a beamer deck, a Layout-mode slide deck, a Layout-mode A0 poster
 * and a paper.
 *
 *   npx tsx scripts/gen-starters.ts             # the four .tex files (and refs.bib)
 *   npx tsx scripts/gen-starters.ts --figures   # also recompile the figures (pdflatex, pgfplots)
 *   npx tsx scripts/gen-starters.ts deck        # only the starters named (slides, deck, poster, paper)
 *
 * The beamer deck and the paper are written by hand (scripts/starters-src/*.tex); the poster is laid
 * out here, object by object, and the Layout-mode deck in scripts/starters-src/deck.ts. Each goes through OverLyX's own parser and writer, so the templates are in
 * the canonical form: opening and saving them in OverLyX changes nothing. Placeholders (@@NAME@@)
 * are filled in when the project is created for a user.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseTex, writeTex } from '../packages/core/src/tex/index.ts';
import { markEditedSettings } from '../packages/core/src/tex/preamble.ts';
import { setHeaderValue, writeBoxKeys, writeShapeKeys, writeImageKeys, writeRawKeys, parseBoxKeys, parseShapeKeys, parseImageKeys, parseRawKeys, parseOlx, type BoxProps, type ShapeProps, type ImageProps, type RawProps } from '../packages/core/src/index.ts';
import { deck, type Heights as DeckHeights } from './starters-src/deck.ts';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const SRC = path.join(HERE, 'starters-src');
const OUT = path.join(HERE, '..', 'packages', 'server', 'templates', 'starters');

/** parse → write with OverLyX (the template directory as the document's directory), settings applied */
function canonical(text: string, dir: string, settings: Record<string, string> = {}): string {
  const opts = { localDirs: [dir], readFile: (n: string) => { try { return fs.readFileSync(path.join(dir, n), 'utf8'); } catch { return undefined; } } };
  const r = parseTex(text, opts);
  if (r.warnings.length) throw new Error(`parser warnings:\n${r.warnings.join('\n')}`);
  if (Object.keys(settings).length) {
    const before = [...r.doc.header.lines];
    for (const [k, v] of Object.entries(settings)) setHeaderValue(r.doc.header, k, v);
    r.doc.header.lines = markEditedSettings(before, r.doc.header.lines, Object.keys(settings));
  }
  const once = writeTex(r.doc, opts).text;
  const twice = writeTex(parseTex(once, opts).doc, opts).text;
  if (once !== twice) throw new Error('not stable: a second parse → write changes the text');
  return once;
}

/* ------------------------------------------------------------------ figures */

const FIGURES: Record<string, string[]> = { slides: ['decay'], deck: ['scattering', 'sky'], poster: ['model', 'results'], paper: ['convergence'] };

function compileFigures(): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'overlyx-starters-'));
  for (const [id, figs] of Object.entries(FIGURES)) {
    if (!wanted(id)) continue;
    fs.mkdirSync(path.join(OUT, id, 'figures'), { recursive: true });
    for (const f of figs) {
      // reproducible PDFs (no creation date, a fixed ID): regenerating does not change the files
      const r = spawnSync('pdflatex', ['-interaction=nonstopmode', '-halt-on-error', path.join(SRC, 'figures', f + '.tex')], {
        cwd: tmp, encoding: 'utf8', env: { ...process.env, SOURCE_DATE_EPOCH: '1767225600', FORCE_SOURCE_DATE: '1' },
      });
      if (r.status !== 0) throw new Error(`figure ${f} failed:\n${r.stdout.slice(-2000)}`);
      fs.copyFileSync(path.join(tmp, f + '.pdf'), path.join(OUT, id, 'figures', f + '.pdf'));
      console.log(`figures: ${id}/figures/${f}.pdf`);
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

/* ------------------------------------------------------------------- poster */

const box = (p: Partial<BoxProps>, body: string) => `\\begin{olbox}{${writeBoxKeys({ ...parseBoxKeys(''), ...p })}}\n${body}\n\\end{olbox}`;
const rect = (p: Partial<ShapeProps>) => {
  const w = p.w ?? 10, h = p.h ?? 10;
  return `\\olshape{${writeShapeKeys({ ...parseShapeKeys(''), vb: `0 0 ${w} ${h}`, ...p })}}{M 0 0 L ${w} 0 L ${w} ${h} L 0 ${h} Z}`;
};
const image = (p: Partial<ImageProps>, file: string) => `\\olimage{${writeImageKeys({ ...parseImageKeys(''), ...p })}}{${file}}`;
const raw = (p: Partial<RawProps>, body: string) => `\\begin{olraw}{${writeRawKeys({ ...parseRawKeys(''), ...p })}}\n${body}\n\\end{olraw}`;

const POSTER_PREAMBLE = String.raw`% An A0 poster made in OverLyX's Layout mode: every element is an object on the page.
\documentclass[final]{beamer}
\usefonttheme{professionalfonts} % keep beamer from overriding the math fonts
\usepackage[T1]{fontenc}
\usepackage[utf8]{inputenc}
\usepackage{amsmath}
\usepackage[sfdefault]{notomath} % Noto Sans for text and formulas
\usepackage[scale=0.9]{noto-mono}
\usepackage{bm}
\usepackage{graphicx}
\usepackage{qrcode}

% colours: change them here and the whole poster follows
\definecolor{main}{RGB}{2,61,107}
\definecolor{mainlight}{RGB}{0,112,180}
\definecolor{pale}{RGB}{236,242,248}
\definecolor{highlight}{RGB}{214,39,40}
\definecolor{ink}{RGB}{28,32,38}

\setbeamertemplate{navigation symbols}{}
\setbeamercolor{normal text}{fg=ink}
\setbeamercolor{itemize item}{fg=mainlight}
\setbeamertemplate{itemize item}[circle]
`;

type Heights = Map<string, number>;

/**
 * The poster's objects. Text boxes are as high as their text (`heights`, measured in the compiled
 * PDF by fitPoster — until then a generous guess), stacked in two columns; what is left above the
 * footer is shared out between the sections.
 */
function poster(heights: Heights = new Map(), final = true): string {
  const W = 841, H = 1189, M = 30, GUT = 26, FOOT = 1100.5, TOP = 306;
  const colW = (W - 2 * M - GUT) / 2;
  const cols = [M, M + colW + GUT];
  const o: string[] = [];
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const body = { font: 27, leading: 1.34, color: 'ink', grow: true };
  const caption = { font: 23, leading: 1.304, color: 'ink!70', align: 'justify' as const, grow: true };

  // header
  o.push(rect({ x: 0, y: 0, w: W, h: 11, fill: 'main', lock: true, name: 'Top bar' }));
  o.push(box({ x: M, y: 26, w: 610, h: 70, font: 88, leading: 1.13, color: 'main', grow: true, name: 'Title' }, '\\textbf{The title of your poster says what you found, in one line}'));
  o.push(box({ x: M, y: 104, w: 610, h: 18, font: 40, leading: 1.24, color: 'ink', grow: true, name: 'Authors' }, '@@NAME@@$^{1}$\\quad{}Second Author$^{2}$\\quad{}Third Author$^{1}$'));
  o.push(box({ x: M, y: 126, w: 610, h: 34, font: 26, leading: 1.33, color: 'ink!70', grow: true, name: 'Affiliations' },
    '\\textcolor{mainlight}{$^{1}$}\\,Your Institute, City, Country\\qquad{}\\textcolor{mainlight}{$^{2}$}\\,Another Institute, City, Country\n\n\\texttt{you@example.org}'));
  o.push(rect({ x: 668, y: 20, w: 1.06, h: 136, fill: 'main!20', name: 'Header divider' }));
  o.push(raw({ x: 701, y: 22, w: 110, h: 110, name: 'QR code' }, '{\\color{main}\\qrcode[height=\\linewidth]{https://overlyx.app}}'));
  o.push(box({ x: 691, y: 138, w: 130, h: 12, font: 28, color: 'main', align: 'center', grow: true, name: 'QR code label' }, '\\textbf{Paper \\& code}'));
  o.push(rect({ x: 0, y: 168, w: W, h: 3.5, fill: 'main', lock: true, name: 'Header rule' }));
  o.push(rect({ x: 0, y: 171.5, w: W, h: 2.5, fill: 'mainlight', lock: true, name: 'Header rule (light)' }));

  // abstract
  const absH = heights.get('Abstract') ?? 86;
  const cardH = r2(Math.max(absH, 16) + 14);
  o.push(box({ x: M, y: 188, w: W - 2 * M, h: cardH, fill: 'pale', radius: 4.94, lock: true, name: 'Abstract card' }, ''));
  o.push(rect({ x: M, y: 188, w: 4.23, h: cardH, fill: 'main', name: 'Abstract bar' }));
  o.push(box({ x: M + 13, y: 195, w: 110, h: 16, font: 44, color: 'main', grow: true, name: 'Abstract heading' }, '\\textbf{Abstract}'));
  o.push(box({ x: 160, y: 195, w: W - M - 8 - 160, h: r2(absH), ...body, leading: 1.32, align: 'justify', name: 'Abstract' },
    'This poster is an example to start from, made in the \\emph{Layout} mode of OverLyX. Every element on it --- this text, the headings, the coloured bands, the figures and the QR code --- is an object that you can select, move, resize and restyle, as in Keynote or Inkscape, while the text inside keeps the typography of \\LaTeX{}, formulas included. The file is an ordinary beamer document: it compiles to an A0 PDF anywhere, and its git history stays readable. Replace the content with your own and delete what you do not need.'));
  const top = Math.max(TOP, 188 + cardH + 18);

  // the columns: items stacked with gaps, sections spread over the height that is left
  type Item = { gap: number; h: number; emit: (x: number, y: number) => void; section?: boolean };
  const columns: Item[][] = [[], []];
  let n = 0;
  const section = (col: number, title: string) => {
    const k = ++n;
    columns[col].push({ gap: 22, h: 31, section: true, emit: (x, y) => {
      o.push(box({ x, y, w: 21, h: 21, fill: 'main', shape: 'ellipse', valign: 'c', font: 44, color: 'white', align: 'center', name: `Section ${k} number` }, `\\textbf{${k}}`));
      o.push(box({ x: x + 29, y: y + 1.5, w: colW - 29, h: 18, font: 46, leading: 1.174, color: 'main', grow: true, name: `Section ${k} title` }, `\\textbf{${title}}`));
      o.push(rect({ x, y: y + 23.5, w: colW, h: 1.06, fill: 'main!25', name: `Section ${k} rule` }));
    } });
  };
  const text = (col: number, gap: number, guess: number, content: string, name: string, extra: Partial<BoxProps> = {}) => {
    const h = r2(heights.get(name) ?? guess);
    columns[col].push({ gap, h, emit: (x, y) => o.push(box({ x, y, w: colW, h, ...body, align: 'justify', name, ...extra }, content)) });
  };
  const equation = (col: number, gap: number, h: number, tex: string, name: string) => {
    columns[col].push({ gap, h, emit: (x, y) => {
      o.push(box({ x, y, w: colW, h, fill: 'pale', radius: 3.53, pad: 2, valign: 'c', font: 30, color: 'ink', name }, tex));
      o.push(rect({ x, y, w: 2.82, h, fill: 'main', name: `${name} bar` }));
    } });
  };
  const figure = (col: number, gap: number, w: number, aspect: number, file: string, name: string) => {
    const h = r2(w * aspect);
    columns[col].push({ gap, h, emit: (x, y) => o.push(image({ x: r2(x + (colW - w) / 2), y, w, h, name }, file)) });
  };
  const card = (col: number, gap: number, name: string, heading: string, content: string, formula: string) => {
    const th = r2(heights.get(`${name} text`) ?? 60);
    const h = r2(Math.max(th, 44) + 34);
    columns[col].push({ gap, h, emit: (x, y) => {
      o.push(box({ x, y, w: colW, h, fill: 'highlight!5!white', stroke: 'highlight', lw: 2.5, radius: 3.53, lock: true, name: `${name} card` }, ''));
      o.push(box({ x: x + 9, y: y + 6, w: colW - 18, h: 14, font: 34, color: 'highlight', grow: true, name: `${name} heading` }, `\\textbf{${heading}}`));
      o.push(box({ x: x + 9, y: y + 25, w: 205, h: th, ...body, name: `${name} text` }, content));
      o.push(box({ x: x + 222, y: y + 25, w: colW - 231, h: h - 31, valign: 'c', font: 30, color: 'ink', name: `${name} formula` }, formula));
    } });
  };

  // left column
  section(0, 'Everything is an object');
  text(0, 0, 70, 'Click an object to select it, Shift+click to add more. Drag it to move it --- it snaps to the page, to the other objects and to their centres --- and pull its handles to resize or rotate it. A second click (or a double click) edits the text of a box; Esc returns to the box. The arrow keys nudge a selection by 1\\,mm (with Shift by 10\\,mm).', 'Section 1 text');
  text(0, 6, 70, '\\begin{itemize}\n\\item \\textbf{T} text box, \\textbf{R} rectangle, \\textbf{E} ellipse, \\textbf{L} line, \\textbf{A} arrow, \\textbf{B} pen\n\\item the \\emph{Layout} toolbar: fill, outline, alignment, arrangement, groups\n\\item pinch or Ctrl + scroll to zoom; \\emph{Fit} shows the whole page\n\\end{itemize}', 'Section 1 list', { align: 'left' });
  text(0, 6, 30, 'Formulas are typed as in any OverLyX document and edited where they stand:', 'Section 1 formula text');
  equation(0, 6, 50, '\\[\n\\mathbf{h}_{t}=\\phi\\left(W\\mathbf{h}_{t-1}+U\\mathbf{x}_{t}\\right),\\qquad\\hat{\\mathbf{y}}_{t}=V\\mathbf{h}_{t}\n\\]', 'Equation 1');
  section(0, 'Figures');
  figure(0, 8, 320, 88.205 / 246.832, 'figures/model', 'Figure 1');
  text(0, 8, 40, '\\textbf{Figure 1.} Add images with the image tool, or drop a PDF, PNG or JPEG onto the page; double-click an image to crop it. This one is a PDF drawn with TikZ.', 'Figure 1 caption', caption);
  section(0, 'Text, colours and styles');
  text(0, 0, 100, 'Text boxes have a base font size and line spacing, a margin, a background and an outline, and set their text ragged right, justified or centred. The colours of this poster are defined once at the top of the file (\\texttt{\\textbackslash definecolor}); change one there and every object that uses it follows. Named sizes such as \\emph{small} and \\emph{large}, bold, italics and \\textcolor{highlight}{colour} work inside boxes as in documents.', 'Section 3 text');
  text(0, 6, 60, 'Objects that belong together can be grouped (Ctrl+G), and background shapes locked so that clicks go through them. The file order is the drawing order: \\emph{Bring to front} and \\emph{Send to back} change it.', 'Section 3 more');

  section(0, 'Pages, steps and notes');
  text(0, 0, 90, 'A poster is a single page; add more and the document becomes a slide deck. Every object can appear on a step of its own (\\emph{Animation} on the Layout toolbar), a page can have a background colour and a transition, and speaker notes go below the page.', 'Section 4 text');

  // right column
  section(1, 'Method');
  text(1, 0, 60, 'Say in two or three sentences what you did. A formula in its own card draws the eye to the model or the objective:', 'Section 5 text');
  equation(1, 6, 50, '\\[\n\\mathcal{L}(\\theta)=\\frac{1}{N}\\sum_{i=1}^{N}\\ell\\left(f_{\\theta}(\\mathbf{x}_{i}),\\,y_{i}\\right)+\\lambda\\lVert\\theta\\rVert^{2}\n\\]', 'Equation 2');
  text(1, 6, 60, 'Numbered equations, cross-references and citations work as in a paper when you need them, but a poster rarely does.', 'Section 5 more');
  section(1, 'Results');
  text(1, 0, 40, 'Replace this plot with your own: select it and choose another image, or drop a new file onto the page and delete this one.', 'Section 6 text');
  figure(1, 6, colW, 194.262 / 340.436, 'figures/results', 'Figure 2');
  text(1, 8, 40, '\\textbf{Figure 2.} Accuracy during training. The numbers are illustrative; the plot is a PDF made with pgfplots.', 'Figure 2 caption', caption);
  section(1, 'Key finding');
  card(1, 2, 'Key finding', 'The one thing to remember', 'Say it in a sentence, and give the formula that carries it --- people read this card first.', '\\[\n\\mathrm{error}\\propto\\frac{1}{\\sqrt{N}}\n\\]');
  section(1, 'Presenting and printing');
  text(1, 0, 80, 'The build button compiles the PDF for the printer: the page is exactly A0 (841\\,mm $\\times$ 1189\\,mm, \\emph{Page size} on the Layout toolbar). Press F5 to show the poster full screen and zoom in while you explain. Objects can even have animation steps, as on slides.', 'Section 8 text');
  text(1, 10, 70, '\\textbf{References}\n\n{[}1{]}~L.~Lamport. \\emph{\\LaTeX: A Document Preparation System}. Addison-Wesley, 1994.\n\n{[}2{]}~T.~Tantau. \\emph{The Ti\\emph{k}Z and PGF Packages}. Manual, CTAN.', 'References', { ...caption, font: 21, leading: 1.3, align: 'left' });

  const ends: number[] = [];
  for (const [c, items] of columns.entries()) {
    const natural = items.reduce((a, it, i) => a + (i ? it.gap : 0) + it.h, 0);
    const spread = items.filter((it, i) => i && it.section).length;
    const extra = spread ? Math.max(0, Math.min(60, (FOOT - 14 - top - natural) / spread)) : 0;
    let y = top;
    for (const [i, it] of items.entries()) {
      if (i) y += it.gap + (it.section ? extra : 0);
      it.emit(cols[c], r2(y));
      y += it.h;
    }
    ends.push(y);
  }

  // footer
  o.push(rect({ x: 0, y: FOOT, w: W, h: 2.5, fill: 'main', lock: true, name: 'Footer rule' }));
  o.push(rect({ x: 0, y: FOOT + 2.5, w: W, h: H - FOOT - 2.5, fill: 'pale', lock: true, name: 'Footer band' }));
  o.push(box({ x: M, y: 1112, w: 117, h: 62, valign: 'c', font: 48, color: 'main', name: 'Take-home heading' }, '\\textbf{Take-home}'));
  o.push(rect({ x: 158, y: 1115, w: 1.06, h: 56, fill: 'main!30', name: 'Footer divider' }));
  o.push(box({ x: 173.5, y: 1112, w: 437, h: 62, valign: 'c', font: 29, leading: 1.345, color: 'ink', name: 'Take-home' }, 'Keep the message of the poster to three sentences here. Everything above supports them; everything else is for the conversation in front of it.'));
  o.push(box({ x: 623.56, y: 1121, w: 187.44, h: 56, fill: 'main', radius: 4.94, pad: 6, valign: 'c', font: 40, leading: 1.143, color: 'white', align: 'center', name: 'Badge' }, '\\textbf{Made with OverLyX}'));

  if (final) console.log(`poster: the columns end at ${ends.map(e => e.toFixed(1)).join(' and ')} mm (footer at ${FOOT})`);
  if (final && Math.max(...ends) > FOOT - 6) throw new Error('the columns run into the footer');
  return `${POSTER_PREAMBLE}\\begin{document}\n\\begin{frame}[plain]\n${o.join('\n')}\n\\end{frame}\n\\end{document}\n`;
}

/** the boxes of a poster: name → [x, y, w, h, font, leading] (mm, pt) */
function boxesOf(tex: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const m of tex.matchAll(/\\begin\{olbox\}\{([^\n]*)\}\n/g)) {
    const p = parseBoxKeys(m[1]);
    if (p.name && p.grow && p.font) out.set(p.name, [p.x, p.y, p.w, p.h, p.font, p.leading ?? 1.2]);
  }
  return out;
}

/**
 * Compile the poster and measure its text boxes: from the first line's baseline to the last one's,
 * plus one line — the height the editor gives the same text. Repeated until nothing moves.
 */
function fitPoster(): string {
  let heights: Heights = new Map();
  let tex = poster(heights, false);
  for (let round = 0; round < 4; round++) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'overlyx-poster-'));
    fs.cpSync(path.join(OUT, 'poster', 'figures'), path.join(tmp, 'figures'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'poster.tex'), canonical(tex, path.join(OUT, 'poster'), POSTER_SETTINGS).replace(/@@NAME@@/g, 'Ada Lovelace'));
    for (let i = 0; i < 2; i++) {   // remember picture: the positions settle in the second run
      const r = spawnSync('pdflatex', ['-interaction=nonstopmode', 'poster.tex'], { cwd: tmp, encoding: 'utf8' });
      if (!fs.existsSync(path.join(tmp, 'poster.pdf'))) throw new Error(`poster failed:\n${r.stdout.slice(-3000)}`);
    }
    spawnSync('pdftotext', ['-bbox-layout', 'poster.pdf', 'poster.html'], { cwd: tmp });
    const html = fs.readFileSync(path.join(tmp, 'poster.html'), 'utf8');
    fs.rmSync(tmp, { recursive: true, force: true });
    const PT = 25.4 / 72;
    const lines = [...html.matchAll(/<line xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">/g)].map(m => m.slice(1, 5).map(v => Number(v) * PT));
    const next: Heights = new Map();
    // every object's place, to know where the next one below a box starts
    const objs = [...tex.matchAll(/\{x=([\d.]+)mm,y=([\d.]+)mm,w=([\d.]+)mm/g)].map(m => [Number(m[1]), Number(m[2]), Number(m[3])]);
    for (const [name, [x, y, w, h, font, leading]] of boxesOf(tex)) {
      const lh = font * leading * PT;
      const below = objs.filter(([ox, oy, ow]) => oy > y + 0.5 && ox < x + w && ox + ow > x).map(o => o[1]);
      const limit = Math.min(y + h + lh, ...below.map(b => b - 3));   // a first line may reach a little above its box
      // the lines inside the box, from its top down to the next object (text that overflows a little too)
      const mine = lines.filter(([x0, y0, x1]) => x0 >= x - 1 && x1 <= x + w + 1 && y0 >= y - 1 && y0 < limit);
      if (!mine.length) continue;
      const first = Math.min(...mine.map(l => l[3])), last = Math.max(...mine.map(l => l[3]));
      next.set(name, Math.round((last - first + lh) * 10) / 10);
    }
    const moved = [...next].some(([k, v]) => Math.abs((heights.get(k) ?? 0) - v) > 0.5);
    heights = next;
    tex = poster(heights, false);
    if (!moved) break;
  }
  return poster(heights);
}

const POSTER_SETTINGS = { papersize: 'custom', paperwidth: '841mm', paperheight: '1189mm' };

/* --------------------------------------------------------------------- deck */

/**
 * Compile the slide deck and give each text box that grows with its text the height TeX gives the
 * text — the natural height the layout macros write to the .olx file — plus its margins and the half
 * millimetre the editor's "make the box that tall" adds. One round is enough: a box's height does not change its
 * text. A box of fixed height that its text overflows in the PDF is an error.
 */
function fitDeck(): string {
  const dir = path.join(OUT, 'deck');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'overlyx-deck-'));
  fs.cpSync(path.join(dir, 'figures'), path.join(tmp, 'figures'), { recursive: true });
  const tex = canonical(deck(), dir);
  fs.writeFileSync(path.join(tmp, 'deck.tex'), tex.replace(/@@NAME@@/g, 'Ada Lovelace'));
  const r = spawnSync('pdflatex', ['-interaction=nonstopmode', 'deck.tex'], { cwd: tmp, encoding: 'utf8' });
  if (r.status !== 0 || !fs.existsSync(path.join(tmp, 'deck.olx'))) throw new Error(`deck failed:\n${r.stdout.slice(-3000)}`);
  const olx = parseOlx(fs.readFileSync(path.join(tmp, 'deck.olx'), 'utf8'));
  fs.rmSync(tmp, { recursive: true, force: true });
  const heights: DeckHeights = new Map();
  const MM = 25.4 / 72.27;
  for (const [i, frame] of [...tex.matchAll(/\\begin\{frame\}[\s\S]*?\\end\{frame\}/g)].entries()) {
    for (const m of frame[0].matchAll(/\\begin\{olbox\}\{([^\n]*)\}\n/g)) {
      const p = parseBoxKeys(m[1]);
      const rec = olx.boxes.find(b => b.frame === i + 1 && b.slide === 1 && Math.abs(b.x - p.x) < 0.01 && Math.abs(b.y - p.y) < 0.01 && Math.abs(b.w - p.w) < 0.01);
      if (!rec) throw new Error(`deck: no .olx record for the box "${p.name}" on slide ${i + 1}`);
      if (p.grow && p.name) heights.set(`${i + 1}/${p.name}`, Math.ceil((rec.natural * MM + 2 * (p.pad ?? 0) + 0.5) * 10) / 10);
      else if (rec.natural - rec.inner > 0.5) throw new Error(`deck: the text of "${p.name}" on slide ${i + 1} is ${(rec.natural - rec.inner).toFixed(1)} pt taller than its box`);
    }
  }
  return deck(heights);
}

/* --------------------------------------------------------------------- main */

const only = process.argv.slice(2).filter(a => !a.startsWith('--'));
function wanted(id: string): boolean { return !only.length || only.includes(id); }

if (process.argv.includes('--figures')) compileFigures();

const write = (id: string, file: string, text: string) => {
  fs.mkdirSync(path.join(OUT, id), { recursive: true });
  fs.writeFileSync(path.join(OUT, id, file), text);
  console.log(`${id}/${file}: ${text.length} bytes`);
};
if (wanted('slides')) write('slides', 'slides.tex', canonical(fs.readFileSync(path.join(SRC, 'slides.tex'), 'utf8'), path.join(OUT, 'slides')));
if (wanted('deck')) write('deck', 'deck.tex', canonical(fitDeck(), path.join(OUT, 'deck')));
if (wanted('paper')) {
  fs.copyFileSync(path.join(SRC, 'refs.bib'), path.join(OUT, 'paper', 'refs.bib'));
  write('paper', 'paper.tex', canonical(fs.readFileSync(path.join(SRC, 'paper.tex'), 'utf8'), path.join(OUT, 'paper')));
}
if (wanted('poster')) write('poster', 'poster.tex', canonical(fitPoster(), path.join(OUT, 'poster'), POSTER_SETTINGS));

/**
 * The pages of a deck's handouts and notes pages (the server prints them to a PDF:
 * render-export.ts): a document of its own around pictures of the slides, so a deck's own styles
 * never reach it.
 *
 * - Handouts: 1, 2, 3, 4 or 6 slides a page, upright A4 or Letter, each slide framed and numbered
 *   as in the deck; 3 a page puts lines for notes beside each slide (PowerPoint's).
 * - Notes pages: a slide on top, its speaker notes below; notes longer than the page run on.
 *
 * Every size is worked out here in millimetres rather than left to the browser's layout.
 */
import type { HandoutPaper, HandoutPerPage } from './exportsize.ts';

export interface HandoutSlide {
  /** the picture's address */
  src: string;
  /** the slide's number in the deck (from 1) */
  number: number;
  title: string;
  /** speaker notes, plain text */
  notes: string;
}
export interface HandoutOptions {
  title: string;
  layout: 'handout' | 'notes';
  per: HandoutPerPage;
  paper: HandoutPaper;
  /** a slide's width / height */
  aspect: number;
  slides: HandoutSlide[];
}

/** paper sizes, mm */
export const PAPER_MM: Record<HandoutPaper, { width: number; height: number; name: string }> = {
  a4: { width: 210, height: 297, name: 'A4' },
  letter: { width: 215.9, height: 279.4, name: 'Letter' },
};
/** the margins of a notes page (the PDF's own, so notes that run on keep them), mm */
export const NOTES_MARGIN_MM = { x: 18, y: 16 };

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const mm = (v: number) => `${Math.round(v * 100) / 100}mm`;

/** how the slides of a handout page are set out: columns, rows, and whether lines for notes stand beside them */
export function handoutGrid(per: HandoutPerPage): { cols: number; rows: number; lines: boolean } {
  if (per === 6) return { cols: 2, rows: 3, lines: false };
  if (per === 4) return { cols: 2, rows: 2, lines: false };
  return { cols: 1, rows: per, lines: per === 3 };
}

const FONT = 'Carlito, "Liberation Sans", "DejaVu Sans", sans-serif';

export function handoutHtml(o: HandoutOptions): string {
  const paper = PAPER_MM[o.paper];
  const aspect = o.aspect > 0 && Number.isFinite(o.aspect) ? o.aspect : 16 / 9;
  const title = esc(o.title);
  const head = (right: string) => `<div class="head"><span>${title}</span><span>${right}</span></div>`;
  let body = '';
  let css = '';
  if (o.layout === 'notes') {
    const w = paper.width - 2 * NOTES_MARGIN_MM.x, h = paper.height - 2 * NOTES_MARGIN_MM.y;
    // the slide: most of the width, never more than two fifths of the page's height
    const iw = Math.min(w * 0.86, h * 0.4 * aspect), ih = iw / aspect;
    css = `@page { size: ${mm(paper.width)} ${mm(paper.height)}; margin: ${mm(NOTES_MARGIN_MM.y)} ${mm(NOTES_MARGIN_MM.x)}; }
      .np { break-before: page; } .np:first-child { break-before: auto; }
      .np img { display: block; width: ${mm(iw)}; height: ${mm(ih)}; margin: 4mm auto 7mm; border: 0.25mm solid #888; break-after: avoid; }
      .notes { white-space: pre-wrap; overflow-wrap: break-word; font-size: 11pt; line-height: 1.45; }
      .head { margin-bottom: 0; }`;
    body = o.slides.map(s => `<section class="np">${head(`Slide ${s.number}`)}<img src="${esc(s.src)}" alt="${esc(s.title || `Slide ${s.number}`)}"><div class="notes">${esc(s.notes)}</div></section>`).join('\n');
  } else {
    const g = handoutGrid(o.per);
    const mx = 14, my = 12, headH = 7, footH = 6, gap = 7, numH = 4.5;
    const w = paper.width - 2 * mx, h = paper.height - 2 * my - headH - footH;
    // (3 a page: the slides in a column at the left, the lines in the rest)
    const cellW = g.lines ? w * 0.47 : (w - gap * (g.cols - 1)) / g.cols;
    const cellH = (h - gap * (g.rows - 1)) / g.rows;
    const iw = Math.min(cellW, (cellH - numH) * aspect), ih = iw / aspect;
    const lineGap = 8.5, lines = Math.max(3, Math.floor((ih - 2) / lineGap));
    css = `@page { size: ${mm(paper.width)} ${mm(paper.height)}; margin: 0; }
      .page { width: ${mm(paper.width)}; height: ${mm(paper.height - 0.3)}; padding: ${mm(my)} ${mm(mx)}; overflow: hidden; break-after: page; }
      .page:last-child { break-after: auto; }
      .head { height: ${mm(headH)}; } .foot { height: ${mm(footH)}; display: flex; justify-content: flex-end; align-items: flex-end; font-size: 8.5pt; color: #666; }
      .grid { height: ${mm(h)}; display: grid; grid-template-columns: ${g.lines ? `${mm(cellW)} 1fr` : `repeat(${g.cols}, ${mm(cellW)})`}; grid-auto-rows: ${mm(cellH)}; gap: ${mm(gap)}; ${g.lines ? '' : 'justify-content: center;'} }
      .cell { display: flex; flex-direction: column; align-items: ${g.lines ? 'flex-start' : 'center'}; justify-content: center; }
      .cell img { display: block; width: ${mm(iw)}; height: ${mm(ih)}; border: 0.25mm solid #888; }
      .cell .n { width: ${mm(iw)}; height: ${mm(numH)}; font-size: 8pt; color: #666; padding-top: 0.8mm; }
      .lines { display: flex; flex-direction: column; justify-content: center; padding-bottom: ${mm(numH)}; }
      .lines i { display: block; height: ${mm(lineGap)}; border-bottom: 0.2mm solid #777; }`;
    const pages: string[] = [];
    const count = Math.max(1, Math.ceil(o.slides.length / o.per));
    for (let p = 0; p < count; p++) {
      const cells = o.slides.slice(p * o.per, (p + 1) * o.per).map(s =>
        `<div class="cell"><img src="${esc(s.src)}" alt="${esc(s.title || `Slide ${s.number}`)}"><div class="n">${s.number}</div></div>`
        + (g.lines ? `<div class="lines">${'<i></i>'.repeat(lines)}</div>` : '')).join('');
      pages.push(`<section class="page">${head('')}<div class="grid">${cells}</div><div class="foot">${p + 1} / ${count}</div></section>`);
    }
    body = pages.join('\n');
  }
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; color: #111; font: 10pt/1.4 ${FONT}; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .head { display: flex; justify-content: space-between; gap: 6mm; font-size: 8.5pt; color: #666; white-space: nowrap; overflow: hidden; }
  .head span:first-child { overflow: hidden; text-overflow: ellipsis; }
  ${css}
</style></head>
<body>
${body}
</body></html>
`;
}

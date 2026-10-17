/**
 * Posters 6–12: seven 2026 research-symposium poster layouts, each replicated from its PDF in inches
 * — page size, grid, bands, boxes, colours, type sizes and figure places — with every word lorem
 * ipsum, no people, no logos (outlined placeholders where the source had them) and placeholder
 * figures (lorem-charts.ts). The body face is the template's bundled font; the sources' serif titles
 * and monospaced labels are set in the reader's serif and monospace (no further font is bundled:
 * every template font ships inside every poster and the app).
 *
 *   symposium-steps      36 × 24 in: serif title, monospace numbered sections, a boxed four-step pipeline
 *   symposium-twin       24 × 36 in: two studies side by side, maroon bands, TL;DR boxes, A1… / B1… sections
 *   symposium-dark       36 × 24 in: white on black, three large numbered claims with their charts
 *   symposium-cards      60 × 36 in: rounded hand-drawn cards on a soft gradient, three columns
 *   symposium-banner     36 × 24 in: a full-width "two-minute" band of diagrams over four headed columns
 *   symposium-editorial  36 × 24 in: serif editorial, a main-result band, a game tree of cards, a verdict
 *   symposium-portrait   24 × 36 in: a callout band, two columns of numbered sections and figures
 */
import type { ScientificTemplate } from './scientific.ts';
import { loremChart, type LoremChartKind, type LoremChartOptions } from './lorem-charts.ts';

const px = (inch: number) => +(inch * 96).toFixed(2);
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const SERIF = "Georgia, 'Times New Roman', 'Liberation Serif', 'DejaVu Serif', serif";
export const MONO = "'DejaVu Sans Mono', Menlo, Consolas, 'Liberation Mono', monospace";

const WORDS = ('lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam ' +
  'quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat duis aute irure dolor in reprehenderit in voluptate velit esse cillum ' +
  'dolore eu fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt in culpa qui officia deserunt mollit anim id est laborum').split(' ');

/** `n` words of lorem ipsum from word `at`, as sentences: a capital, a comma now and then, a full stop every 8–12 words */
export function lorem(n: number, at = 0, end = '.'): string {
  const out: string[] = [];
  let run = 0;
  for (let i = 0; i < n; i++) {
    let w = WORDS[(at + i) % WORDS.length];
    if (run === 0) w = w[0].toUpperCase() + w.slice(1);
    run++;
    if (i === n - 1) w += end;
    else if (run >= 8 + ((at + i) % 5)) { w += '.'; run = 0; }
    else if ((at + i) % 11 === 6) w += ',';
    out.push(w);
  }
  return out.join(' ');
}
/** `n` lorem words in title case (a heading) */
export const loremTitle = (n: number, at = 0) => Array.from({ length: n }, (_, i) => WORDS[(at + i) % WORDS.length]).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
/** `n` lorem words, lower case (a label) */
export const loremWords = (n: number, at = 0) => Array.from({ length: n }, (_, i) => WORDS[(at + i) % WORDS.length]).join(' ');

interface TextStyle { lh?: number; weight?: number; color?: string; font?: string; align?: 'center' | 'right'; italic?: boolean; track?: number; upper?: boolean; extra?: string; tag?: 'p' | 'h1' | 'h2' | 'h3' }

/**
 * A text block whose first line's letters start at `top` (inches, as the source's PDF has them: the
 * line box begins half the extra leading above), `size` in points.
 */
function text(x: number, top: number, w: number, html: string, size: number, o: TextStyle = {}): string {
  const lh = o.lh ?? 1.3;
  const y = top - (lh - 1.15) * size / 144;
  const style = [
    'position: absolute', `left: ${px(x)}px`, `top: ${px(y)}px`, `width: ${px(w)}px`, `font-size: ${+(size * 4 / 3).toFixed(2)}px`, `line-height: ${lh}`,
    `font-weight: ${o.weight ?? 400}`, `letter-spacing: ${o.track ? o.track + 'em' : '0'}`, o.color ? `color: ${o.color}` : '', o.font ? `font-family: ${o.font}` : '',
    o.align ? `text-align: ${o.align}` : '', o.italic ? 'font-style: italic' : '', o.upper ? 'text-transform: uppercase' : '', o.extra ?? '',
  ].filter(Boolean).join('; ');
  const tag = o.tag ?? 'p';
  return `<${tag} style="${style}">${html}</${tag}>`;
}
/** a box: a band, a card, a rule */
const box = (x: number, y: number, w: number, h: number, style: string) =>
  `<div class="decoration" style="position: absolute; left: ${px(x)}px; top: ${px(y)}px; width: ${px(w)}px; height: ${px(h)}px; ${style}"></div>`;
/** an outlined place for a logo or a QR code (no one's emblem is copied) */
const placeholder = (x: number, y: number, w: number, h: number, label: string, colour: string, size = 18) =>
  box(x, y, w, h, `border: 3px dashed ${colour}; border-radius: 8px`) + text(x, y + h / 2 - size / 120, w, label, size, { color: colour, align: 'center', lh: 1.2 });
const fig = (kind: LoremChartKind, x: number, y: number, w: number, h: number, o: LoremChartOptions) => loremChart(kind, px(x), px(y), px(w), px(h), o);
/** bullets as the sources set them: "•" items, one paragraph with line breaks between them */
const bullets = (items: string[], gap = .35) => items.map(i => `• ${i}`).join(`<br><span style="display: block; height: ${gap}em"></span>`);

/* ---------------------------------------------------------------- 6 · symposium-steps (36 × 24 in) */

function steps(t: ScientificTemplate, title: string): string[] {
  const BG = '#fdf9f6', RED = '#7c1021', INK = '#1c1a19', FILL = '#f5efea', GREY = '#6b6460', RULE = '#d6cdc4';
  const o: string[] = [];
  const mono = (x: number, top: number, w: number, s: string, size = 18, colour = RED) => text(x, top, w, s, size, { font: MONO, color: colour, track: .18, lh: 1.15 });
  const body = (x: number, top: number, w: number, s: string, size = 23.5) => text(x, top, w, s, size, { color: INK, lh: 1.43 });
  const head = (x: number, top: number, n: string, s: string) => mono(x, top, 11, n ? `${n}&emsp;&nbsp;${s}` : s, 20);

  o.push(mono(1.04, .84, 12, 'LOREM IPSUM · DOLOR 2026'));
  o.push(text(1.04, 1.12, 22, esc(title || t.exampleTitle), 116, { font: SERIF, color: INK, lh: 1.0, tag: 'h1', extra: 'letter-spacing: -.015em' }));
  o.push(text(1.04, 3.01, 7.1, 'Lorem Ipsum<sup>1</sup>&emsp;Dolor Sit<sup>1</sup>&emsp;Amet Elit<sup>2</sup>', 26, { color: INK, weight: 700, lh: 1.2, extra: 'white-space: nowrap' }));
  o.push(mono(8.28, 3.13, 7, '1 Lorem&ensp;·&ensp;2 Ipsum Dolor', 17, GREY));
  o.push(placeholder(30.6, 1.75, 4.3, 1.65, 'Logo', RED, 22));
  o.push(box(1.04, 3.84, 33.92, .06, `background: ${RED}`));

  // column 1: the method as four boxed steps, arrows between them
  o.push(head(1.04, 4.44, '01', 'LOREM IPSUM'));
  o.push(body(1.04, 5.08, 10.2, lorem(22, 0)));
  const step = (y: number, h: number, n: number, name: string, fill: boolean) =>
    box(1.04, y, 10.33, h, `border: 2px solid ${INK}; background: ${fill ? FILL : '#ffffff'}`) + mono(1.32, y + .19, 9.6, `STEP ${n}&emsp;&nbsp;${name}`, 16);
  const arrow = (y: number) => `<svg class="decoration" viewBox="0 0 10 10" style="position: absolute; left: ${px(6.06)}px; top: ${px(y)}px; width: ${px(.22)}px; height: ${px(.22)}px"><polygon points="0,0 10,0 5,10" fill="${RED}"/></svg>`;
  o.push(step(6.59, 1.11, 1, 'LOREM IPSUM', false), text(1.32, 7.21, 9.6, 'Lorem-14B · Ipsum3.1-8B', 20.5, { color: INK }));
  o.push(arrow(7.74));
  o.push(step(7.99, 3.82, 2, 'DOLOR SIT (AMET)', true), body(1.32, 8.6, 9.7, lorem(21, 30), 20.5));
  ([['lorem', 'ipsum / dolor'], ['sit', 'amet / elit'], ['tempor', 'magna / aliqua'], ['—', 'enim / minim']] as const).forEach(([k, v], i) => {
    o.push(mono(1.32, 9.52 + i * .45, 1.1, k, 15, GREY), text(2.43, 9.53 + i * .45, 8, v, 19.5, { color: INK }));
  });
  o.push(text(1.32, 11.36, 9.7, `“${lorem(10, 60, '.')}”`, 18, { color: INK, italic: true }));
  o.push(arrow(11.86));
  o.push(step(12.1, 1.58, 3, 'LOREM DOLOR (SIT)', false), text(1.32, 12.72, 9.7, lorem(10, 70), 20.5, { color: INK }));
  o.push(text(1.32, 13.25, 9.7, `<span style="font-family: ${MONO}; font-size: .8em; color: ${GREY}">LOREM</span> ${lorem(6, 85, '?')} <span style="font-family: ${MONO}; font-size: .8em; color: ${GREY}">IPSUM</span> ${lorem(3, 95)}`, 17.5, { color: INK }));
  o.push(arrow(13.75));
  o.push(step(13.99, 2.3, 4, 'SIT AMET ELIT', true), body(1.32, 14.6, 9.7, lorem(16, 100, '?'), 20.5));
  o.push(text(1.32, 15.51, 9.7, lorem(18, 120, '?'), 17.5, { color: GREY, lh: 1.35 }));
  o.push(mono(1.04, 16.55, 10.5, 'Fig. 1&ensp; Lorem: Ipsum (DOL) -> Sit (AMT) -> Elit', 15, GREY));

  // column 2: a numbered list, then the effect with its scatter
  o.push(head(12.05, 4.44, '', 'LOREM IPSUM DOLOR SIT!'));
  o.push(body(12.05, 5.08, 11, 'Lorem ipsum:'));
  ([[5.72, 22, 5], [7.29, 13, 40], [8.4, 16, 60]] as const).forEach(([y, n, at], i) => {
    o.push(body(12.11, y, .4, `${i + 1}.`), body(12.46, y, 10.6, lorem(n, at)));
  });
  o.push(head(12.05, 9.68, '02', 'DOLOR'));
  o.push(fig('scatter', 12.74, 10.2, 10, 6, { colours: [INK, '#e69f00', '#0072b2', '#009e73', '#cc79a7'], ink: INK, text: 15, seed: 3, panel: '#ffffff' }));
  o.push(mono(12.05, 16.55, 11, 'Fig. 2&ensp; Δ lorem-ipsum dolor vs Δ sit amet across ELIT/SED. Lorem = 0.40, R² = 0.59.', 15, GREY));
  o.push(body(12.05, 17.38, 11, lorem(32, 140)));

  // column 3: four heat maps, their caption, two bullets
  [5.0, 8.15, 11.3, 14.45].forEach((y, i) => o.push(fig('heatmap', 25.77, y, 7.55, 2.85, { colours: ['#2f6db5', '#b2182b'], ink: INK, text: 9, seed: 11 + i, n: 6, series: 13, panel: '#ffffff' })));
  o.push(head(24.1, 4.44, '03', 'IPSUM DOLOR'));
  o.push(mono(24.1, 17.62, 11, 'Fig. 3&ensp; Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.', 15, GREY));
  o.push(body(24.35, 18.45, 10.6, bullets([lorem(14, 160), lorem(46, 180)], .3)));

  // the takeaways under a thin rule; the reference at the foot
  o.push(box(1.04, 19.15, 22.36, .02, `background: ${RULE}`));
  o.push(head(1.04, 19.75, '04', 'SIT AMET'));
  o.push(body(1.3, 20.15, 10.6, bullets([lorem(30, 210)])));
  o.push(body(12.5, 20.15, 10.6, bullets([lorem(15, 250), lorem(20, 270)], .3)));
  o.push(box(1.04, 22.73, 33.92, .02, `background: ${RULE}`));
  o.push(mono(1.04, 23.03, 30, 'Lorem, Ipsum, Dolor, Sitamet. Consectetur Adipiscing: Elit Sed Do Eiusmod Tempor. arxiv.org/abs/0000.00000', 15, GREY));
  return o;
}

/* ---------------------------------------------------------------- 7 · symposium-twin (24 × 36 in) */

function twin(t: ScientificTemplate, title: string): string[] {
  const RED = '#801323', CREAM = '#fbf4e1', INK = '#1f1f1f', GREY = '#555555';
  const o: string[] = [];
  const head = (x: number, top: number, s: string) =>
    text(x, top, 10.8, s, 16.5, { font: SERIF, color: RED, weight: 700, lh: 1.2, tag: 'h2' }) + box(x, top + .34, 10.86, .018, `background: ${RED}`);
  const body = (x: number, top: number, s: string, w = 10.86) => text(x, top, w, s, 15, { color: INK, lh: 1.22, extra: 'text-align: justify' });
  const cap = (x: number, top: number, s: string, w = 10.86) => text(x, top, w, `<b>Figure ${s}</b>`, 9.6, { color: GREY, italic: true, lh: 1.3 });
  const cs = (seed: number): LoremChartOptions => ({ colours: ['#9d9d9d', '#3c7ebf', '#a77fd0', '#d84141', '#3aa685', '#f39c34'], ink: INK, text: 10, seed });

  o.push(placeholder(.9, 1.1, 3.1, .85, 'Logo', RED, 16));
  o.push(text(4.75, .85, 15, esc(title || t.exampleTitle), 53, { font: SERIF, weight: 700, color: '#111111', lh: 1.1, tag: 'h1' }));
  o.push(text(4.75, 1.77, 13, 'Lorem Ipsum* · Dolor Sitamet* · Amet Elit · Sed Tempor · Magna Aliqua', 17.5, { color: RED, weight: 700, lh: 1.2 }));
  o.push(text(4.75, 2.09, 8, '*Lorem ipsum dolor, sit amet elit', 9.6, { color: GREY, lh: 1.2 }));
  o.push(placeholder(20.0, .72, 1.4, 1.4, 'QR', RED, 12), placeholder(21.7, .72, 1.4, 1.4, 'QR', RED, 12));
  o.push(text(19.85, 2.3, 1.7, 'Lorem ipsum', 8.5, { color: GREY, align: 'center' }), text(21.55, 2.3, 1.7, 'Dolor sit', 8.5, { color: GREY, align: 'center' }));
  o.push(box(.9, 2.55, 22.2, .03, `background: ${RED}`));
  o.push(box(11.985, 2.78, .02, 31.9, `background: ${RED}`));

  // each study: its band, its TL;DR box
  for (const [x, name, n, at] of [[.9, 'Lorem Ipsum Dolor Sit Amet', 50, 0], [12.24, 'Consectetur Adipiscing Elit Sed?', 88, 40]] as const) {
    o.push(box(x, 2.79, 10.86, .68, `background: ${RED}`));
    o.push(text(x + .19, 2.98, 10.4, name, 20.5, { font: SERIF, color: '#ffffff', lh: 1.15, tag: 'h2' }));
    o.push(box(x, 3.47, 10.86, 1.93, `background: ${CREAM}; border: 2px solid ${RED}; border-top: none`));
    o.push(text(x + .19, 3.6, 10.48, `<b>TL;DR:</b> ${lorem(n, at)}`, 16.5, { font: SERIF, color: INK, lh: 1.22, extra: 'text-align: justify' }));
  }

  // study A
  o.push(head(.9, 5.84, 'A1&ensp;Lorem ipsum: dolor sit amet consectetur'));
  o.push(body(.9, 6.33, lorem(56, 100)));
  o.push(fig('flow', .95, 7.55, 6.4, 4.2, { ...cs(1), colours: [RED], label: 'Lorem ipsum|Dolor sit|Amet elit|Sed tempor' }));
  o.push(text(7.63, 7.42, 4.1, lorem(26, 180), 10.5, { color: GREY, lh: 1.3 }));
  o.push(text(7.9, 8.6, 3.4, 'h̃ = h / ‖h‖<br>h<sub>A</sub> += α h̃<br>ℒ = −log p<sub>A</sub>(a | q, h)', 14, { font: SERIF, color: INK, lh: 1.5, align: 'center' }));
  o.push(fig('flow', 7.6, 10.3, 4.1, 1.85, { ...cs(2), colours: ['#c46b7a'], label: 'Lorem|Ipsum|Dolor|Sit' }));
  o.push(cap(.9, 12.35, `A1. ${lorem(12, 210)}</b> ${lorem(18, 230)}`));
  o.push(head(.9, 12.87, 'A2&ensp;Lorem ipsum dolor sit amet'));
  o.push(body(1.01, 13.41, bullets([`<b>Lorem ipsum:</b> ${lorem(10, 250)}`, `<b>Dolor sit:</b> ${lorem(14, 270)}`, `<b>Amet elit:</b> ${lorem(6, 300)}`, `<b>Sed tempor:</b> ${lorem(9, 320)}`], .1), 10.7));
  o.push(fig('bars', 2.6, 15.25, 6.6, 4.1, { ...cs(3), colours: ['#9d9d9d', '#3c7ebf', '#a77fd0', '#d84141', '#3aa685'], n: 5 }));
  o.push(cap(.9, 19.5, `A2. ${lorem(5, 340)}</b> ${lorem(16, 350)}`));
  o.push(head(.9, 20.17, 'A3&ensp;Lorem ipsum dolor sit amet elit'));
  o.push(body(.9, 20.59, lorem(80, 370)));
  o.push(fig('flow', 1.9, 22.55, 8.6, 3.7, { ...cs(4), colours: ['#a14bb5'], label: 'Lorem ipsum|Dolor|Sit amet|Elit sed' }));
  o.push(cap(.9, 26.52, `A3. ${lorem(7, 470)}</b> ${lorem(22, 480)}`));
  o.push(head(.9, 27.23, 'A4&ensp;Lorem ipsum dolor sit amet'));
  o.push(body(.9, 27.73, lorem(26, 500)));
  o.push(fig('bars', .95, 28.55, 5.6, 3.25, { ...cs(5), colours: ['#9d9d9d', '#3c7ebf', '#f39c34', '#a77fd0', '#d84141', '#3aa685'], n: 6 }));
  o.push(fig('lines', 6.9, 28.55, 4.8, 3.25, { ...cs(6), colours: ['#3c7ebf'], series: 1, n: 9 }));
  o.push(cap(.9, 31.85, `A4. ${lorem(3, 530)}</b> ${lorem(8, 540)}`, 5.5), cap(6.95, 31.85, `A5. ${lorem(3, 560)}</b> ${lorem(8, 570)}`, 4.8));
  o.push(head(.9, 32.49, 'A5&ensp;Lorem ipsum'));
  o.push(body(.9, 32.91, lorem(14, 590)));
  o.push(body(1.01, 33.55, bullets([`<b>Lorem:</b> ${lorem(14, 610)}`, `<b>Ipsum dolor:</b> ${lorem(18, 630)}`], .1), 10.7));

  // study B
  o.push(head(12.24, 5.84, 'B1&ensp;Lorem ipsum: dolor sit amet elit'));
  o.push(body(12.24, 6.31, lorem(56, 660)));
  o.push(fig('flow', 12.3, 7.55, 6.2, 2.0, { ...cs(7), colours: ['#c0574f'], label: 'Lorem|Ipsum|Dolor|Sit' }));
  o.push(text(18.76, 7.72, 4.3, lorem(14, 750), 10, { color: GREY, lh: 1.3 }));
  o.push(text(19.9, 8.4, 3.2, 'S<sup>t+1</sup> = f(p, X<sup>t</sup>; S<sup>t</sup>)<br>X<sup>t+1</sup> = sample(S<sup>t+1</sup>)<br>t = 0, …, T − 1', 13.5, { font: SERIF, color: INK, lh: 1.5, align: 'center' }));
  o.push(cap(12.24, 9.6, `B1. ${lorem(6, 770)}</b> ${lorem(14, 780)}`));
  o.push(head(12.24, 10.14, 'B2&ensp;Lorem ipsum dolor sit amet consectetur elit'));
  o.push(body(12.24, 10.63, lorem(40, 800)));
  o.push(fig('grouped', 14.3, 11.7, 7.0, 4.6, { ...cs(8), colours: ['#8a5a2b', '#f2a316', '#e57fa6'], series: 2, n: 5 }));
  o.push(cap(12.24, 16.95, `B2. ${lorem(6, 860)}</b> ${lorem(26, 870)}`));
  o.push(head(12.24, 17.6, 'B3&ensp;Lorem ipsum dolor sit amet elit sed'));
  o.push(body(12.24, 18.09, lorem(54, 900)));
  o.push(fig('hbars', 12.3, 19.5, 5.5, 2.8, { ...cs(9), colours: ['#5b4fbd', '#7d9bd6'], n: 8 }));
  o.push(fig('heatmap', 18.4, 19.25, 4.7, 3.1, { ...cs(10), colours: ['#2f6db5', '#c0392b'], n: 10, series: 14 }));
  o.push(cap(12.24, 22.45, `B3. ${lorem(6, 980)}</b> ${lorem(9, 990)}`, 5.5), cap(18.4, 22.45, `B4. ${lorem(5, 1000)}</b> ${lorem(14, 1010)}`, 4.7));
  o.push(head(12.24, 23.41, 'B4&ensp;Lorem ipsum dolor'));
  o.push(body(12.24, 23.82, lorem(26, 1030)));
  o.push(fig('lines', 14.6, 24.55, 5.8, 1.5, { ...cs(11), colours: ['#111111', '#c47fd6'], series: 2, n: 10 }));
  o.push(fig('lines', 14.6, 26.15, 5.8, 1.5, { ...cs(12), colours: ['#a14bb5'], series: 1, n: 10, panel: '#fbecef' }));
  o.push(cap(12.24, 27.75, `B5. ${lorem(8, 1070)}</b> ${lorem(10, 1080)}`));
  o.push(head(12.24, 28.32, 'B5&ensp;Lorem ipsum dolor sit'));
  o.push(body(12.24, 28.82, lorem(52, 1100)));
  o.push(fig('heatmap', 13.6, 30.0, 8.4, 1.85, { ...cs(13), colours: ['#e8e8e8', '#e8792b'], n: 4, series: 12 }));
  o.push(cap(12.24, 32.0, `B6. ${lorem(8, 1170)}</b> ${lorem(8, 1180)}`));
  o.push(head(12.24, 32.49, 'B6&ensp;Lorem ipsum'));
  o.push(body(12.24, 32.92, lorem(50, 1200)));
  o.push(body(12.35, 33.98, bullets([`<b>Lorem:</b> ${lorem(18, 1270)}`, `<b>Ipsum dolor:</b> ${lorem(20, 1290)}`], .1), 10.7));
  return o;
}

/* ---------------------------------------------------------------- 8 · symposium-dark (36 × 24 in) */

function dark(t: ScientificTemplate, title: string): string[] {
  const BLUE = '#0076ba', GREEN = '#23b13e', ORANGE = '#e5532a', GREEN2 = '#2e9e6b', W = '#ffffff';
  const o: string[] = [];
  const claim = (cx: number, cy: number, n: number) =>
    box(cx - .48, cy - .48, .96, .96, `border-radius: 50%; background: ${W}`) + text(cx - .48, cy - .3, .96, String(n), 42, { color: '#000000', weight: 700, align: 'center', lh: 1 });
  const big = (x: number, top: number, w: number, s: string) => text(x, top, w, s, 50.5, { color: W, lh: 1.04, tag: 'h2' });
  const body = (x: number, top: number, w: number, s: string) => text(x, top, w, s, 29.6, { color: W, lh: 1.12 });
  const label = (x: number, top: number, w: number, s: string, size = 23.7) => text(x, top, w, s, size, { color: W, align: 'center', lh: 1.2 });
  const cs = (seed: number, colours = [BLUE]): LoremChartOptions => ({ colours, ink: W, text: 19, seed });
  const chip = (x: number, y: number, w: number, s: string, bg: string) =>
    box(x, y, w, .38, `background: ${bg}`) + text(x + .06, y + .07, w - .12, s, 17, { color: W, lh: 1.2, align: 'center' });

  o.push(text(.55, .82, 17, esc(title || t.exampleTitle), 87, { color: W, weight: 700, lh: 1.0, tag: 'h1' }));
  o.push(text(.55, 3.55, 9, 'Lorem I. Ipsum', 61, { color: W, weight: 700, lh: 1.1 }));
  o.push(text(.57, 4.83, 12, 'Lorem: Ipsum Dolor (Sit Amet Elit) • Lorem 21, 2026', 22.6, { color: W, weight: 700, lh: 1.2 }));
  o.push(body(.56, 5.3, 13.6, `Lorem ipsum: ${lorem(62, 0)}`));
  o.push(placeholder(31.9, .7, 3.5, .95, 'Logo', W, 20));

  // claim 1 and its three charts
  o.push(claim(1.0, 8.95, 1), big(1.91, 8.32, 12.4, lorem(13, 70, '')));
  o.push(label(2.27, 10.9, 7.4, lorem(17, 90, '?')));
  o.push(fig('bars', .55, 12.05, 9.5, 3.75, cs(1)));
  o.push(text(2.21, 15.96, 7.5, lorem(11, 110), 21.7, { color: W, lh: 1.2 }));
  o.push(label(2.2, 17.15, 5.5, lorem(15, 130)));
  o.push(fig('bars', .55, 18.4, 7.5, 3.75, { ...cs(2), n: 3 }));
  o.push(text(2.0, 22.28, 6, lorem(9, 150), 15.5, { color: W, lh: 1.2 }));
  o.push(label(10.07, 17.55, 6.8, lorem(11, 160)));
  o.push(fig('bars', 8.55, 18.5, 8.6, 3.65, { ...cs(3), n: 3 }));
  o.push(text(9.95, 22.18, 7, lorem(16, 180), 15.5, { color: W, lh: 1.2 }));

  // claim 2: the negotiation figure, its chips, the right-hand chart and table
  o.push(claim(17.95, 2.42, 2), big(18.76, 1.97, 15.2, lorem(11, 200, '')));
  o.push(body(18.77, 3.67, 13.4, lorem(38, 220)));
  o.push(fig('lines', 21.0, 5.9, 8.4, 8.6, { ...cs(4, ['#3f96ff', ORANGE, '#9a9a9a']), series: 3, n: 9, text: 15, legend: false }));
  o.push(text(15.74, 5.73, 6.2, `Lorem Ipsum: <span style="color: ${GREEN}">5 Dolor Sit</span><br>vs. <span style="color: ${GREEN}">5 Amet Elit</span>`, 22, { color: W, weight: 700, lh: 1.15 }));
  o.push(body(15.68, 8.1, 5.1, lorem(30, 280)));
  o.push(chip(23.4, 6.75, 2.4, 'Lorem Ipsum Dolor', '#2f6fd6'), chip(23.4, 10.6, 2.6, 'Dolor sit amet', ORANGE), chip(26.4, 11.6, 2.9, 'Sit Amet Elit Lorem', ORANGE));
  o.push(chip(22.6, 8.4, 3.0, 'Lorem-ipsum dolor', '#3b3b3b'), chip(21.9, 13.0, 2.6, 'Elit sed do tempor', GREEN2), chip(26.6, 6.9, 2.3, 'Sed tempor magna', GREEN2));
  o.push(label(31.28, 6.21, 4, 'Lorem ipsum by dolor sit'));
  o.push(fig('bars', 29.3, 6.75, 6.4, 4.1, { ...cs(5), n: 7 }));
  o.push(label(30.3, 11.08, 5.6, lorem(9, 320), 21));
  o.push(fig('heatmap', 29.85, 11.9, 5.65, 1.75, { ...cs(6, ['#1f4d7a', BLUE]), n: 4, series: 3, text: 14 }));
  o.push(text(29.85, 13.8, 5.7, lorem(22, 340), 12, { color: W, lh: 1.25 }));

  // claim 3 and its chart
  o.push(claim(17.98, 15.4, 3), big(18.84, 14.93, 14.6, lorem(10, 370, '')));
  o.push(body(18.89, 16.82, 12.6, lorem(34, 390)));
  o.push(label(18.98, 18.94, 6.6, 'Lorem ipsum dolor sit amet elit'));
  o.push(fig('grouped', 18.1, 19.45, 8.6, 4.15, { ...cs(7, [BLUE, GREEN]), n: 2, series: 2 }));
  o.push(text(28.52, 23.49, 7.36, 'Lorem I. Ipsum &lt;lorem@ipsum.edu&gt;', 22.6, { color: W, align: 'right', lh: 1.2 }));
  return o;
}

/* ---------------------------------------------------------------- 9 · symposium-cards (60 × 36 in) */

function cards(t: ScientificTemplate, title: string): string[] {
  const BLUE = '#1f56b3', INK = '#1a1a1a', LINE = '#1d1d1d', PINK = '#f6e6e4', CREAM = '#fbfde9', BLUSH = '#f2ebe8';
  const o: string[] = [box(0, 0, 60, 36, 'background: linear-gradient(90deg, #dcf3ee 0%, #eef1ea 45%, #f8e9e7 75%, #f7dedf 100%)')];
  const card = (x: number, y: number, w: number, h: number, fill: string) => box(x, y, w, h, `background: ${fill}; border: 9px solid ${LINE}; border-radius: 52px; box-shadow: 0 0 0 1.5px rgba(0,0,0,.25)`);
  const head = (x: number, top: number, w: number, s: string) => text(x, top, w, s, 62, { color: BLUE, weight: 700, align: 'center', lh: 1.15, tag: 'h2' });
  const body = (x: number, top: number, w: number, s: string, size = 45) => text(x, top, w, s, size, { color: INK, lh: 1.3 });

  o.push(card(.66, .75, 58.7, 5.55, '#ffffff'));
  o.push(text(2.3, 1.34, 42, esc(title || t.exampleTitle), 118, { color: BLUE, weight: 700, lh: 1.1, tag: 'h1' }));
  o.push(text(14, 4.0, 22, 'Lorem Ipsum&emsp;&emsp;Dolor Sitamet&emsp;&emsp;Amet Elit', 70, { color: INK, lh: 1.2, align: 'center' }));
  o.push(placeholder(46.2, 1.35, 11.4, 4.3, 'Logo', '#7f1b2b', 56));

  // left: Overview, Motivation
  o.push(card(.84, 7.5, 18, 7.35, BLUSH), head(.84, 8.08, 18, 'Lorem Ipsum'), body(1.93, 9.55, 15.9, lorem(42, 0)));
  o.push(card(.84, 16.05, 18, 18.8, CREAM), head(.84, 16.61, 18, 'Dolor Sit'));
  o.push(body(2.15, 18.62, 15.8, bullets([lorem(23, 50), lorem(27, 80), lorem(23, 110), lorem(22, 140, '?')], .55)));

  // middle: the setup (with its target of four levels), result 1
  o.push(card(20.55, 7.5, 18.06, 16.05, CREAM), head(20.55, 8.08, 18.06, 'Amet Consectetur'));
  o.push(body(21.42, 9.97, 10.3, bullets([lorem(18, 170), lorem(34, 190)], .5)));
  o.push(body(21.5, 20.93, 16.3, bullets([lorem(16, 230)], .4)));
  const rings = [['#7fb2f0', 2.35], ['#e8364d', 1.75], ['#fcb714', 1.18], ['#21918c', .62]] as const;
  o.push(`<svg class="decoration" role="img" aria-label="Placeholder diagram: four nested levels" viewBox="-2.6 -2.6 5.2 5.2" style="position: absolute; left: ${px(32.0)}px; top: ${px(10.6)}px; width: ${px(5.2)}px; height: ${px(5.2)}px">${rings.map(([c, r]) => `<circle r="${r}" fill="${c}"/>`).join('')}<text y=".3" text-anchor="middle" font-size=".85" fill="${INK}">L1</text></svg>`);
  o.push(text(32.3, 9.5, 1.2, 'L2', 62, { color: INK, lh: 1 }), text(36.0, 9.3, 1.2, 'L4', 62, { color: INK, lh: 1 }), text(37.3, 14.9, 1.2, 'L3', 62, { color: INK, lh: 1 }));
  o.push(text(31.2, 16.55, 5.2, '<u>Lorem of ipsum</u>', 44, { color: INK, lh: 1.25, align: 'center' }));
  o.push(card(20.55, 24.6, 18.06, 10.29, PINK), head(20.55, 24.91, 18.06, 'Lorem #1'));
  o.push(body(21.47, 26.31, 16.2, bullets([lorem(30, 260), lorem(30, 300)], .5)));

  // right: result 2 (a table), limitations, acknowledgments
  o.push(card(40.35, 7.35, 18.6, 10.8, CREAM), head(40.35, 7.66, 18.6, 'Lorem #2'));
  o.push(body(41.53, 9.22, 16.4, bullets([lorem(20, 340)])));
  const cols = ['', 'L1', 'L2', 'L3', 'L4'], rows = [['Lorem #1', '79', '80', '81', '85'], ['Lorem #2', '115', '115', '122', '127']];
  const cw = 2.85, ch = 1.1, tx = 43.3, ty = 13.3;
  o.push(box(tx, ty, cw * 5, ch * 3, 'background: #ffffff; border: 2px solid #333333'));
  for (let i = 1; i < 5; i++) o.push(box(tx + cw * i, ty, .02, ch * 3, 'background: #333333'));
  for (let j = 1; j < 3; j++) o.push(box(tx, ty + ch * j, cw * 5, j === 1 ? .05 : .02, 'background: #333333'));
  cols.forEach((c, i) => o.push(text(tx + cw * i, ty + .3, cw, c, 40, { color: INK, weight: 700, align: 'center', lh: 1 })));
  rows.forEach((r, j) => r.forEach((v, i) => o.push(text(tx + cw * i, ty + ch * (j + 1) + .3, cw, v, 40, { color: INK, align: 'center', lh: 1 }))));
  o.push(text(42.4, 17.0, 15.2, '<u>Lorem ipsum</u> = dolor sit amet consectetur where ≥50% of ipsum elit sed do.', 30, { color: INK, align: 'center', lh: 1.2 }));
  o.push(card(40.35, 18.96, 18.6, 9.24, PINK), head(40.35, 19.19, 18.6, 'Dolor Sit Amet'));
  o.push(body(41.18, 20.43, 16.9, bullets([lorem(12, 380), lorem(15, 400), lorem(15, 420)], .5)));
  o.push(card(40.35, 28.95, 18.6, 5.91, CREAM), head(40.35, 29.19, 18.6, 'Ipsum Dolorem'));
  o.push(text(41.28, 30.52, 16.9, `${lorem(28, 440)} <u>lorem@ipsum.com</u>`, 45, { color: INK, lh: 1.3, align: 'center' }));
  return o;
}

/* ---------------------------------------------------------------- 10 · symposium-banner (36 × 24 in) */

function banner(t: ScientificTemplate, title: string): string[] {
  const RED = '#80142a', BAND = '#a9384e', INK = '#141414', W = '#ffffff';
  const o: string[] = [];
  const name = esc(title || t.exampleTitle).replace(/\b(\w+)\?$/, `<span style="color: ${RED}">$1</span>?`);
  o.push(text(.7, .66, 25.4, name, 74, { color: INK, weight: 700, lh: 1.05, tag: 'h1', extra: 'white-space: nowrap' }));
  o.push(text(.7, 2.01, 14.5, '<b>Lorem Ipsum</b><sup>1,2*</sup>, Dolor Sitamet<sup>2*</sup>, Amet Elit<sup>3+</sup>, Sed Tempor<sup>3+</sup>', 28, { color: INK, lh: 1.2 }));
  o.push(text(15.32, 2.06, 10, '<sup>1</sup>Lorem Ipsum&emsp;&emsp;<sup>2</sup>Dolor Sitamet&emsp;&emsp;<sup>3</sup>Amet', 23.7, { color: INK, lh: 1.2 }));
  o.push(text(.7, 2.64, 12.5, `<b><i>Lorem ipsum dolor sit: <u style="color: #1f5fbf">lorem@ipsum.com</u>; @loremipsum on X</i></b>`, 21, { color: INK, lh: 1.2 }));
  o.push(text(15.29, 2.72, 6, '*Lorem-ipsum dolor +Sit amet elit sed', 14, { color: INK, lh: 1.2 }));
  o.push(box(.55, 3.06, 25.2, .03, `background: ${INK}`));
  o.push(box(26.4, .62, 9.15, .95, `background: ${RED}`), text(26.57, .82, 8.9, 'LOREM 10.0 Ipsum Dolorem', 32, { color: W, weight: 700, lh: 1.15 }));
  o.push(placeholder(26.6, 1.78, 4.2, 1.15, 'Logo', RED, 18), placeholder(31.1, 1.78, 4.4, 1.15, 'Logo', RED, 18));

  // the band: four panels of chips and arrows
  o.push(box(0, 3.24, 36, 6.08, `background: ${RED}`));
  o.push(text(9, 3.49, 18, 'Lorem ipsum 2 dolor? Sit amet elit!', 31, { color: W, weight: 700, align: 'center', lh: 1.2 }));
  ([[.54, 8.0], [9.71, 7.5], [19.36, 6.5], [27.52, 7.7]] as const).forEach(([x, w], i) =>
    o.push(text(x, 4.32, w, lorem(11 - i, 20 + i * 15, ''), 21.5, { color: W, weight: 700, align: 'center', lh: 1.15 })));
  const chip = (x: number, y: number, w: number, s: string, filled = false, size = 16, h = .44) =>
    box(x, y, w, h, `border: 2.5px solid ${W}; border-radius: 9px; background: ${filled ? W : 'transparent'}`) + text(x, y + .09, w, s, size, { color: filled ? RED : W, weight: 700, align: 'center', lh: 1.2 });
  const arrowR = (x: number, y: number, w: number) => `<svg class="decoration" viewBox="0 0 100 20" preserveAspectRatio="none" style="position: absolute; left: ${px(x)}px; top: ${px(y)}px; width: ${px(w)}px; height: ${px(.2)}px"><path d="M0 10H92" stroke="${W}" stroke-width="3"/><path d="M86 3L100 10L86 17z" fill="${W}"/></svg>`;
  const big = (x: number) => `<svg class="decoration" viewBox="0 0 30 24" style="position: absolute; left: ${px(x)}px; top: ${px(6.55)}px; width: ${px(.62)}px; height: ${px(.5)}px"><path d="M0 7H16V0L30 12L16 24V17H0z" fill="#f0c9cf"/></svg>`;
  // panel 1
  o.push(chip(2.0, 5.6, 1.85, 'lorem'), arrowR(3.95, 5.72, 1.0), chip(4.85, 5.6, 1.85, 'ipsum dol'), chip(2.0, 6.3, 1.85, 'sit'), arrowR(3.95, 6.42, 1.0), chip(4.85, 6.3, 1.85, 'amet elit'));
  o.push(text(4.7, 7.05, 2.8, 'lorem ipsum dolor', 15, { color: '#f5d7dc', lh: 1.2 }));
  o.push(chip(1.8, 7.38, 2.35, 'lorem ipsum'), chip(1.8, 8.03, 2.35, 'dolor sit'), chip(1.8, 8.68, 2.35, 'amet elit'), chip(4.85, 7.73, 2.25, 'LOREM IPSUM', true, 19));
  o.push(big(8.85), big(17.45), big(26.3));
  // panel 2
  o.push(text(10.4, 5.72, 7, 'the lorem is the only ipsum', 19.5, { color: '#f5d7dc', align: 'center', lh: 1.2 }));
  o.push(`<svg class="decoration" viewBox="0 0 100 30" preserveAspectRatio="none" style="position: absolute; left: ${px(11.3)}px; top: ${px(6.15)}px; width: ${px(5.2)}px; height: ${px(.7)}px"><path d="M100 30C80 0 20 0 2 28" fill="none" stroke="${W}" stroke-width="1.2"/></svg>`);
  ([[9.7, 'Lorem', 1.2], [11.45, 'Ipsum', 1.35], [13.3, 'Dolor', 1.55], [15.35, 'SIT AMET', 2.0]] as const).forEach(([x, s, w], i) => {
    o.push(chip(x, 6.95, w, s, i === 3, 20));
    if (i < 3) o.push(arrowR(x + w + .05, 7.07, .4));
  });
  o.push(box(11.3, 8.0, 5.2, 1.0, `border: 2px dashed ${W}; border-radius: 6px`), text(11.3, 8.12, 5.2, 'lorem-ipsum dolor<br><span style="font-size: .75em">sit amet: elit only, never sed</span>', 19, { color: W, align: 'center', lh: 1.2 }));
  // panel 3
  o.push(chip(18.8, 5.95, 1.6, 'one lorem<br>ipsum', false, 13, .8));
  [0, 1, 2, 3, 4].forEach(i => o.push(chip(20.9 + i * 1.08, 6.55 - i * .2, 1.0, 'lorem', true, 15), chip(20.9 + i * 1.08, 7.05 - i * .2 + i * .2, 1.0, 'ipsum', false, 15)));
  o.push(text(20.9, 7.75, 5.6, 'stronger and stronger lorem', 17.5, { color: '#f5d7dc', align: 'center', lh: 1.2 }));
  o.push(text(18.4, 8.44, 8.6, 'Lorem Ipsumization!', 34, { color: W, weight: 700, align: 'center', lh: 1.15 }));
  // panel 4 (its arcs first: the chips over them)
  const arc = (x: number, y: number, w: number, h: number, d: string) => `<svg class="decoration" viewBox="0 0 10 10" preserveAspectRatio="none" style="position: absolute; left: ${px(x)}px; top: ${px(y)}px; width: ${px(w)}px; height: ${px(h)}px"><path d="${d}" fill="none" stroke="${W}" stroke-width=".35" vector-effect="non-scaling-stroke"/></svg>`;
  o.push(arc(31.5, 5.7, 1.6, .5, 'M0 9C3 0 7 0 10 9'), arc(33.25, 6.75, 1.5, 1.6, 'M7 0C10 5 6 9 0 10'), arc(29.6, 6.75, 1.25, 1.6, 'M10 10C4 9 0 5 3 0'));
  o.push(chip(29.0, 5.95, 2.4, 'a lorem task:<br>no ipsum', false, 15, .75), chip(33.15, 5.95, 2.3, 'train against<br>an ipsum', false, 15, .75));
  o.push(chip(30.85, 7.95, 2.3, 'the ipsum<br>gets dolor', false, 15, .75));
  o.push(text(27.4, 7.4, 2.1, 'no real lorem', 23, { color: W, lh: 1.2 }));

  // the lighter band: three statements
  o.push(box(0, 9.32, 36, 1.41, `background: ${BAND}`));
  ([[.52, 'Lorem ipsum:', 30], [12.47, 'We dolor:', 50], [24.08, 'We sit:', 70]] as const).forEach(([x, k, at]) =>
    o.push(text(x, 9.7, 11.2, `<i>${k}</i> ${lorem(12, at, '!')}`, 23, { color: W, weight: 700, lh: 1.15 })));

  // the four columns
  const cols = [[.29, 8.19], [9.0, 8.19], [17.55, 8.19], [26.12, 9.61]] as const;
  ['Lorem Ipsum in Dolor', 'Lorem Ipsum in Sit Amet', 'What Dolors a Sit', 'Can lorem ipsum the dolor?'].forEach((s, i) => {
    const [x, w] = cols[i];
    o.push(box(x, 10.95, w, .87, `background: ${RED}`), text(x, 11.14, w, s, 31, { color: W, weight: 700, align: 'center', lh: 1.15 }));
  });
  const sub = (x: number, top: number, w: number, s: string) => text(x, top, w, s, 23, { color: RED, weight: 700, align: 'center', lh: 1.15 });
  const note = (x: number, top: number, w: number, s: string) => text(x, top, w, s, 14.5, { color: RED, align: 'center', lh: 1.3 });
  const cs = (seed: number, colours = [RED, '#111111', '#3b6db3', '#d38a1c']): LoremChartOptions => ({ colours, ink: INK, text: 11, seed });
  o.push(sub(.6, 12.04, 7.6, lorem(13, 100, '')), fig('lines', .35, 12.9, 6.9, 3.05, { ...cs(1), series: 4, n: 6 }));
  o.push(sub(.6, 16.11, 7.6, lorem(7, 120, '')), fig('lines', .35, 16.95, 6.3, 3.05, { ...cs(2), series: 4, n: 7 }));
  o.push(note(6.75, 17.5, 1.7, `<b>Lorem ipsum:</b> ${lorem(10, 140)}`), note(6.75, 19.9, 1.7, 'Lorem ipsum'));
  o.push(fig('bars', .3, 20.55, 3.25, 3.25, { ...cs(3, ['#3b6db3']), n: 8, text: 9 }), fig('bars', 3.6, 20.55, 3.25, 3.25, { ...cs(4, ['#3b6db3']), n: 8, text: 9 }));
  o.push(note(6.9, 22.45, 1.6, `<b style="font-size: 1.15em">${lorem(5, 160)}</b>`));
  o.push(sub(9.22, 12.04, 7.84, lorem(9, 170, '')), fig('lines', 9.0, 12.5, 7.6, 3.55, { ...cs(5, ['#c8c8c8', RED, '#3b6db3', '#d38a1c', '#111111']), series: 5, n: 14 }));
  o.push(sub(10.4, 16.21, 5.5, lorem(6, 190, '')), fig('hbars', 9.2, 17.05, 6.9, 2.9, { ...cs(6, [RED, '#c26b7a']), n: 9, text: 9 }));
  o.push(note(16.2, 17.5, 1.55, `<b>Lorem ipsum:</b> ${lorem(10, 200)}`));
  o.push(sub(9.5, 20.05, 7.2, lorem(14, 210, '')), fig('hbars', 9.3, 21.2, 7.0, 2.1, { ...cs(7, [RED, '#3b6db3']), n: 2 }));
  const code = (x: number, y: number, w: number, h: number, s: string) =>
    box(x, y, w, h, `border: 2px solid ${INK}; border-radius: 10px; background: #ffffff`) + text(x + .12, y + .1, w - .24, s, 11.5, { font: MONO, color: INK, lh: 1.3 });
  const quote = (x: number, y: number, w: number, h: number, s: string) => box(x, y, w, h, `background: ${RED}; border-radius: 8px`) + text(x + .14, y + .1, w - .28, s, 14, { color: W, lh: 1.3 });
  o.push(sub(17.7, 12.16, 7.9, lorem(6, 230, '')));
  o.push(text(17.8, 12.62, 3.8, 'lorem ipsum dolor sit 17:', 10.5, { color: INK, weight: 700 }), code(17.8, 12.85, 3.85, 2.25, lorem(30, 240)));
  o.push(text(21.85, 12.62, 3.8, 'amet elit sed do run:', 10.5, { color: INK, weight: 700 }), code(21.85, 12.85, 3.85, 2.25, lorem(30, 280)));
  o.push(sub(17.7, 15.68, 7.9, lorem(5, 320, '')), text(18.2, 16.06, 7, `${lorem(9, 330, '')}:`, 11, { color: INK, weight: 700 }), code(18.15, 16.3, 7.4, 2.25, lorem(42, 340)));
  o.push(text(19.2, 18.65, 5.6, `${lorem(6, 390, '')}:`, 12, { color: INK, weight: 700, align: 'center' }), quote(19.2, 18.95, 5.65, 1.1, `“${lorem(16, 400)}”`));
  o.push(sub(17.7, 20.42, 7.9, lorem(6, 420, '')), code(18.5, 20.8, 7.0, 1.25, lorem(26, 430)));
  o.push(text(19.4, 22.2, 5.8, `${lorem(7, 460, '')}:`, 12, { color: INK, weight: 700, align: 'center' }), quote(19.6, 22.45, 5.65, .95, `“${lorem(12, 470)}”`));
  o.push(sub(26.6, 12.07, 8.6, lorem(15, 490, '')), fig('scatter', 26.2, 12.95, 6.6, 3.2, { ...cs(8, [RED, RED, '#111111']), n: 12 }));
  o.push(fig('scatter', 26.3, 16.3, 9.3, 3.35, { ...cs(9, [RED, '#111111', RED]), n: 16 }));
  o.push(sub(26.9, 19.77, 8.3, lorem(8, 520, '')), fig('lines', 26.25, 20.25, 4.55, 3.5, { ...cs(10), series: 4, n: 4 }), fig('lines', 30.95, 20.25, 4.7, 3.5, { ...cs(11), series: 4, n: 4 }));
  return o;
}

/* ---------------------------------------------------------------- 11 · symposium-editorial (36 × 24 in) */

function editorial(t: ScientificTemplate, title: string): string[] {
  const BG = '#f7f5f2', RED = '#800020', CREAM = '#fff7df', INK = '#1c1c1c', GREY = '#61605f', PANEL = '#f1ede6', CARD = '#fdfcfa', BLUE = '#3d74c4', ORANGE = '#c9553c', EDGE = '#d9d3ca';
  const o: string[] = [];
  const r = (s: string) => `<span style="color: ${ORANGE}">${s}</span>`, b = (s: string) => `<span style="color: ${BLUE}">${s}</span>`;
  const head = (x: number, top: number, w: number, n: string, s: string) =>
    text(x, top + .3, w, `<span style="color: ${RED}">${n}</span> ${s}`, 45, { font: SERIF, weight: 700, color: INK, lh: 1.08, tag: 'h2' });
  const rule = (x: number, y: number, w: number) => box(x, y, w, .035, `background: ${RED}`);
  const body = (x: number, top: number, w: number, s: string, size = 23) => text(x, top, w, s, size, { color: INK, lh: 1.33 });
  const small = (x: number, top: number, w: number, s: string, size = 18.5) => text(x, top, w, s, size, { color: GREY, lh: 1.3 });

  o.push(placeholder(.55, 1.15, 3.6, 1.2, 'Logo', RED, 22));
  o.push(text(4.75, .55, 26.4, esc(title || t.exampleTitle), 80, { font: SERIF, weight: 700, color: INK, lh: .98, tag: 'h1' }));
  o.push(text(4.75, 2.97, 5.2, `Lorem Ipsum<sup>1</sup> · Dolor Sit<sup>2</sup>`, 26, { color: RED, weight: 700, lh: 1.15 }));
  o.push(small(10.11, 3.03, 6, '<sup>1</sup>Lorem Ipsum&emsp;<sup>2</sup>Dolor Sitamet', 21.5));
  o.push(box(.58, 3.38, 34.9, 1.62, `background: ${CREAM}`), rule(.58, 5.0, 34.9));
  o.push(text(.95, 3.78, 2.4, 'LOREM<br>IPSUM', 32, { font: SERIF, weight: 700, color: RED, lh: 1.15, track: .1 }));
  o.push(box(3.42, 3.75, .03, .95, `background: ${RED}`));
  o.push(text(3.75, 3.66, 31.2, `${r('Lorem ipsum')} dolor sit amet elit while ${b('ipsum')} trains sed: magna aliqua fails as it should, stronger lorem still win — but the <b>dose</b> of lorem ipsum and the <b>choice of sed</b> can change the dolor.`, 34, { font: SERIF, color: INK, lh: 1.2 }));

  // column 1
  o.push(head(.58, 5.05, 10, '01', 'Lorem ipsum dolor sit amet elit sed'), rule(.58, 6.84, 9.77));
  o.push(body(.58, 6.96, 9.7, `${lorem(14, 0)} <b>${lorem(5, 20, '')}</b>. ${lorem(18, 30)} <b>${lorem(3, 50, '')}</b> ${lorem(8, 60)}`));
  o.push(head(.58, 9.34, 10, '02', 'Lorem ipsum dolor sit'), rule(.58, 10.45, 9.77));
  o.push(body(.58, 10.63, 9.7, `${lorem(8, 80)} <i>${lorem(3, 95, '')}</i> ${lorem(8, 100)} <b>${lorem(6, 120)}</b>`));
  o.push(fig('flow', 1.6, 12.15, 7.6, 1.4, { colours: [GREY], ink: INK, text: 10, seed: 2, label: 'Lorem|Ipsum dolor|Sit amet|Elit' }));
  o.push(small(.58, 13.59, 9.7, lorem(6, 140)));
  o.push(head(.58, 13.8, 10, '03', 'Lorem ipsum dolor sit amet elit sed do'), rule(.58, 15.44, 9.77));
  o.push(fig('picture', 1.9, 15.75, 7.5, 2.65, { colours: [ORANGE], ink: GREY, text: 12, label: 'Lorem ipsum figure' }));
  o.push(body(.58, 18.63, 9.7, `${lorem(10, 160)} <b>${lorem(2, 175, '')}</b>. ${lorem(12, 180)} ${r('Lorem ipsum')} ${lorem(10, 200)} ${b('ipsum')} ${lorem(14, 215)}`));
  o.push(small(.58, 21.85, 9.7, lorem(30, 240)));

  // column 2: the game tree
  o.push(head(10.92, 5.05, 13, '04', 'The lorem ipsum: every dolor sit has an amet elit'), rule(10.92, 6.84, 13.1));
  const card = (x: number, y: number, w: number, h: number, name: string, top: string, lines: string[], rows: [string, string][] = []) => {
    o.push(box(x, y, w, h, `background: ${CARD}; border: 2px solid ${EDGE}; border-radius: 6px`));
    let cy = y + .2;
    if (name) { o.push(box(x, y, w, .58, `background: ${top}; border-radius: 6px 6px 0 0`), text(x + .18, y + .14, w - .3, name, 21, { color: INK, weight: 700, lh: 1.2 })); cy = y + .72; }
    if (lines.length) { o.push(text(x + .18, cy, w - .36, lines.join(' '), 18.5, { color: INK, lh: 1.3 })); cy += .32 * Math.ceil(lines.join(' ').length / (w * 7.4)) + .2; }
    if (rows.length) {
      o.push(box(x + .15, cy, w - .3, rows.length * .5 + .15, `background: ${PANEL}; border-radius: 6px`));
      rows.forEach(([k, v], i) => o.push(text(x + .3, cy + .14 + i * .5, 1.6, k, 18.5, { color: GREY, lh: 1.2 }), text(x + 1.68, cy + .1 + i * .5, 1.6, v, 24, { color: INK, weight: 700, lh: 1.2 })));
    }
  };
  card(11.0, 7.0, 4.25, 2.0, '', '', [`<b>lorem SFT</b> — ${lorem(5, 300)}<br><b>ipsum SFT</b> — ${lorem(6, 310)}`]);
  card(15.85, 6.95, 4.45, 2.68, 'lorem — no ipsum dolor', '#efebf0', [lorem(5, 320)], [['lorem', '0.72'], ['ipsum', '0.77']]);
  card(20.85, 6.95, 4.4, 1.92, '', '', [`<span style="font-size: 1.2em">lorem accuracy (↑ higher = better ${b('ipsum-dolor')} sit)</span>`]);
  card(15.85, 11.05, 4.45, 2.95, `${r('red')}: lorem ipsum dolor`, '#f7e4dc', [lorem(7, 330)], [['lorem', '0.05'], ['ipsum', '0.11']]);
  card(11.05, 15.6, 4.4, 3.4, `${b('blue')}: lorem dolor`, '#e4ecf7', [lorem(10, 340)], [['lorem', '—'], ['ipsum', '0.75']]);
  card(18.4, 15.6, 4.45, 3.05, `${b('blue')}: Lorem Ipsum`, '#e4ecf7', [lorem(7, 360)], [['lorem', '0.83'], ['ipsum', '0.62']]);
  card(11.05, 20.5, 4.4, 2.5, `${r('red')}: lorem-ipsum dolor`, '#f7e4dc', [lorem(6, 380)], [['ipsum', '0.05']]);
  card(15.95, 20.5, 4.45, 2.75, `${r('red')}: sit amet elit`, '#f7e4dc', [lorem(6, 390)], [['lorem', '—'], ['ipsum', '0.51']]);
  card(20.85, 20.5, 4.4, 2.75, `${r('red')}: elit-sed tempor`, '#f7e4dc', [lorem(5, 400)], [['lorem', '0.08'], ['ipsum', '0.77']]);
  // the tree's connectors: lines between the cards, an arrowhead into each (no drawing over the cards' words)
  const v = (x: number, y1: number, y2: number, c: string, head = true) => box(x - .014, y1, .028, y2 - y1, `background: ${c}`) +
    (head ? `<svg class="decoration" viewBox="0 0 10 10" style="position: absolute; left: ${px(x - .09)}px; top: ${px(y2 - .14)}px; width: ${px(.18)}px; height: ${px(.14)}px"><path d="M0 0L5 10L10 0z" fill="${c}"/></svg>` : '');
  const h = (x1: number, x2: number, y: number, c: string) => box(x1, y - .014, x2 - x1, .028, `background: ${c}`);
  o.push(v(18.07, 9.63, 11.03, ORANGE), v(18.07, 14.0, 14.33, BLUE, false), h(13.25, 20.62, 14.33, BLUE), v(13.25, 14.32, 15.58, BLUE), v(20.62, 14.32, 15.58, BLUE));
  o.push(v(13.25, 19.0, 20.48, ORANGE), v(20.62, 18.65, 19.0, ORANGE, false), h(18.17, 23.05, 19.0, ORANGE), v(18.17, 18.99, 20.48, ORANGE), v(23.05, 18.99, 20.48, ORANGE));

  // column 3
  o.push(head(25.8, 5.05, 9.8, '05', 'Is lorem ipsum a good dolor sit?'), rule(25.8, 6.84, 9.66));
  const problem = (top: number, s: string) => text(25.8, top + .33, 9.6, s, 34, { font: SERIF, weight: 700, color: RED, lh: 1.05 });
  const cs = (seed: number): LoremChartOptions => ({ colours: [ORANGE, BLUE], ink: INK, text: 10, seed, series: 2, n: 8 });
  o.push(problem(6.67, 'Lorem 1 — the dose of lorem ipsum changes the dolor'));
  o.push(text(25.8, 8.2, 9.6, 'The same ipsum dolor, under two lorem doses', 21, { color: INK, align: 'center', lh: 1.2 }));
  o.push(fig('lines', 26.3, 8.75, 4.6, 2.65, cs(1)), fig('lines', 30.85, 8.75, 4.6, 2.65, cs(2)));
  o.push(small(25.8, 12.35, 9.6, 'Same ipsum dolor: lorem at 16% sit amet, elit at 95%.'));
  o.push(problem(12.58, 'Lorem 2 — sit amet changes elit sed tempor'));
  o.push(text(25.8, 14.15, 9.6, 'Lorem choice flips which ipsum method wins', 21, { color: INK, align: 'center', lh: 1.2 }));
  o.push(fig('lines', 26.3, 14.75, 4.6, 2.75, cs(3)), fig('lines', 30.85, 14.75, 4.6, 2.75, cs(4)));
  o.push(small(25.8, 18.26, 9.6, `Salient ${b('ipsum')} flag: lorem beats dolor. Salient ${r('lorem')} flag: dolor wins.`), small(25.8, 18.72, 9.6, lorem(12, 420), 13.5));
  o.push(box(25.8, 18.95, 9.6, 3.3, `background: ${CREAM}`), box(25.8, 18.95, .1, 3.3, `background: ${RED}`));
  o.push(text(26.17, 19.4, 4, 'LOREM', 33, { font: SERIF, weight: 700, color: RED, lh: 1.1, track: .1 }));
  o.push(body(26.17, 20.0, 8.9, `${r('Lorem ipsum')} is kind of dolor — but the <b>sit amet elit</b> ${lorem(26, 440)}`));
  o.push(small(25.8, 22.95, 9.6, lorem(20, 480)));
  return o;
}

/* ---------------------------------------------------------------- 12 · symposium-portrait (24 × 36 in) */

function portrait(t: ScientificTemplate, title: string): string[] {
  const RED = '#97182e', INK = '#1a1a1a', GREY = '#555555', CALL = '#f8f1df', PINK = '#f5e6e7', SOFT = '#eef0f2';
  const o: string[] = [];
  const head = (x: number, top: number, w: number, s: string) =>
    text(x, top, w, s, 26.3, { color: RED, weight: 700, lh: 1.15, tag: 'h2' }) + box(x, top + .52, w, .03, `background: ${RED}`);
  const body = (x: number, top: number, w: number, s: string, size = 20.1) => text(x, top, w, s, size, { color: INK, lh: 1.24 });
  const cap = (x: number, top: number, w: number, s: string) => text(x, top, w, `<b>Figure ${s}`, 15, { color: GREY, lh: 1.25 });
  const cs = (seed: number, colours = [RED, '#2d7fb8', '#3a3a3a']): LoremChartOptions => ({ colours, ink: INK, text: 11, seed });
  const tile = (x: number, y: number, w: number, h: number, name: string, fill: string, dashed = false) =>
    box(x, y, w, h, `background: ${fill}; border-radius: 6px${dashed ? `; border: 2px dashed ${RED}` : ''}`) + text(x + .2, y + .2, w - .4, `<b style="color: ${dashed ? RED : INK}">${name}</b><br><br><span style="color: ${GREY}">${loremTitle(1, name.length)}<br>${loremTitle(2, name.length + 5)}</span>`, 13.5, { color: INK, lh: 1.4 });

  o.push(text(.85, .7, 11, esc(title || t.exampleTitle), 46.6, { color: INK, weight: 700, lh: 1.15, tag: 'h1' }));
  o.push(text(.85, 2.34, 11, 'Lorem Ipsum¹ · Dolor Sitamet² · Amet Elit Sed²', 20.3, { color: RED, weight: 700, lh: 1.2 }));
  o.push(text(.85, 2.75, 8, '¹Lorem Ipsum*&ensp;²Dolor Sitamet', 14.4, { color: GREY, lh: 1.2 }));
  o.push(placeholder(11.1, .85, 3.3, 1.25, 'Logo', RED, 20), placeholder(14.8, .85, 8.3, 1.25, 'Logo', RED, 20));
  o.push(box(.85, 3.27, 22.3, 1.75, `background: ${CALL}; border: 2.5px solid ${RED}; border-radius: 14px`));
  o.push(text(1.35, 3.51, 21.4, `<b>Lorem ipsum.</b>&ensp;${lorem(12, 0)}`, 33.3, { color: INK, lh: 1.15 }));
  o.push(text(1.35, 4.18, 21.4, lorem(19, 20), 19.6, { color: INK, lh: 1.2 }));

  // left column
  o.push(head(.85, 5.3, 10.6, '1&ensp;Lorem Ipsum'));
  o.push(body(.85, 5.97, 10.6, `${lorem(12, 40)} <b>${lorem(5, 60, '')}</b>, ${lorem(13, 70)}<br>${lorem(25, 90)}`));
  o.push(text(.6, 9.3, 2.5, 'Lorem ipsum', 13.5, { color: GREY, align: 'center' }), text(.6, 11.75, 2.5, 'Dolor sit', 13.5, { color: GREY, align: 'center' }));
  o.push(tile(3.25, 8.15, 3.75, 2.25, 'Lorem ipsum, dolor', SOFT), tile(7.25, 8.15, 3.75, 2.25, 'Lorem ipsum, sit', PINK, true));
  o.push(tile(3.25, 10.6, 3.75, 2.75, 'Amet elit, dolor', SOFT), tile(7.25, 10.6, 3.75, 2.75, 'Amet elit, sit', SOFT));
  o.push(text(3.25, 13.45, 3.75, 'Lorem ipsum', 13.5, { color: GREY, align: 'center' }), text(7.25, 13.45, 3.75, 'Dolor sit', 13.5, { color: GREY, align: 'center' }));
  o.push(cap(.85, 13.94, 10.6, `1.</b> ${lorem(28, 120)}`));
  o.push(head(.85, 14.53, 10.6, '2.a&ensp;Lorem ipsum'));
  o.push(body(.85, 15.06, 10.6, `${lorem(12, 150)} <b>${lorem(4, 165, '')}</b> ${lorem(22, 170)} <b>Lorem A</b> and <b>Lorem B</b>). ${lorem(26, 200)}`, 19.6));
  o.push(box(2.0, 17.65, 3.4, 3.2, `background: ${PINK}; border: 2px solid ${INK}; border-radius: 6px; box-shadow: 6px 6px 0 #e8dede, 12px 12px 0 #efe8e8`));
  o.push(text(2.1, 17.85, 3.2, `<b>Lorem Ipsum</b><br><span style="color: ${RED}">${lorem(6, 230)}</span><br>${['Lorem', 'Ipsum dolor', 'Sit amet', 'Elit sed', 'Tempor'].join('<br>')}`, 12.5, { color: INK, lh: 1.6, align: 'center' }));
  o.push(fig('flow', 5.6, 18.3, 1.6, 1.2, { colours: [GREY], ink: GREY, text: 9, label: ' | | | ' }));
  o.push(box(7.3, 17.65, 3.45, 3.2, `background: ${PINK}; border: 2px solid ${INK}; border-radius: 6px`));
  o.push(text(7.45, 17.95, 3.15, bullets([lorem(4, 250), lorem(4, 260), lorem(5, 270), lorem(4, 280)], .4), 12.5, { color: INK, lh: 1.3 }));
  o.push(box(7.6, 20.25, 2.85, .4, `background: ${RED}; border-radius: 4px`), text(7.6, 20.31, 2.85, 'Lorem ipsum dolor sit', 11.5, { color: '#ffffff', weight: 700, align: 'center' }));
  o.push(cap(.85, 21.05, 10.6, `2.</b> ${lorem(12, 300)}`));
  o.push(head(.75, 21.57, 10.7, '2.b&ensp;Lorem ipsum dolor sit amet'));
  o.push(text(.75, 22.21, 10.7, lorem(26, 320), 20.1, { font: SERIF, color: INK, lh: 1.15 }));
  ([[1.95, 'Lorem ipsum is dolor'], [4.85, 'You can sit without amet'], [7.75, 'Elit with no sed tempor']] as const).forEach(([x, s], i) =>
    o.push(box(x, 23.0, 2.7, 1.65, `background: ${PINK}; border-radius: 4px`), text(x + .1, 23.25, 2.5, `<b style="color: ${RED}">${s}</b><br><span style="color: ${GREY}; font-size: .85em">${lorem(9, 350 + i * 10)}</span>`, 12.5, { lh: 1.35, align: 'center' })));
  o.push(cap(.85, 24.95, 10.6, `3.</b> ${lorem(14, 390)}`));
  o.push(head(.75, 25.29, 10.7, '2.c&ensp;Lorem ipsum: the dolor sit'));
  o.push(body(.75, 25.95, 10.7, `${lorem(18, 410)} <b>LOREM-Ipsum</b>. ${lorem(24, 430)}`, 19.6));
  const step = (x: number, y: number, h: number, s: string, stat = '') => box(x, y, 2.85, h, `background: #ffffff; border: 2px solid ${RED}; border-radius: 4px`) +
    text(x + .1, y + .2, 2.65, `<b>${s}</b><br><span style="color: ${GREY}; font-size: .8em">${lorem(9, s.length * 7)}</span>`, 12.5, { color: INK, lh: 1.4, align: 'center' }) +
    (stat ? box(x + .3, y + h - 1.15, 2.25, .75, `background: ${PINK}`) + text(x + .3, y + h - 1.08, 2.25, `<b style="font-size: 1.4em; color: ${RED}">${stat}</b><br><span style="color: ${RED}; font-size: .8em">Lorem ipsum</span>`, 12.5, { lh: 1.2, align: 'center' }) : '');
  o.push(box(2.4, 27.55, 9.1, .03, `background: ${RED}`), text(4.0, 27.3, 6, 'Lorem Ipsum (Dolor Sit Amet)', 11, { color: RED, align: 'center' }));
  o.push(step(2.85, 27.75, 2.25, 'Lorem Ipsum &amp; Dolor'), step(5.6, 27.75, 2.25, 'Sit Amet &amp; Elit Sed'), step(8.35, 27.75, 2.25, 'Tempor Magna Aliqua'));
  o.push(text(4.5, 30.3, 6, 'Lorem Ipsum (Dolor-Sit Amet)', 11, { color: GREY, align: 'center' }));
  o.push(step(2.85, 30.65, 3.2, 'Lorem Ipsum Dolor', '~84%'), step(5.6, 30.65, 3.2, 'Sit Amet Elit', '~7%'), step(8.35, 30.65, 3.2, 'Tempor &amp; Magna', '0'));
  o.push(box(4.2, 34.15, 5.7, .75, `background: ${RED}`), text(4.2, 34.25, 5.7, '<b>Lorem Ipsum Dolor</b><br><span style="font-size: .75em">Sit amet elit sed do eiusmod tempor</span>', 13.5, { color: '#ffffff', align: 'center', lh: 1.25 }));
  o.push(cap(.85, 35.0, 10.6, `4.</b> ${lorem(18, 470)}`));

  // right column
  o.push(head(12.35, 5.3, 10.8, '2.d&ensp;Lorem Ipsum'));
  o.push(body(12.23, 6.02, 10.9, `${lorem(14, 500)} <b>${lorem(4, 515, '')}</b>. ${lorem(30, 520)}`, 19.6));
  o.push(box(15.6, 8.1, 5.3, 4.3, `border: 2px solid ${RED}; border-radius: 8px`), text(15.6, 8.25, 5.3, '<b>Lorem Ipsum Dolor</b><br><span style="font-size: .8em; color: ' + GREY + '">Sit amet, elit sed</span>', 12.5, { color: INK, align: 'center', lh: 1.3 }));
  o.push(box(16.0, 9.15, 4.5, .95, 'background: #2b2b2b; border-radius: 6px'), text(16.0, 9.33, 4.5, '<b>Lorem Ipsum</b><br><span style="font-size: .8em">Dolor sit amet</span>', 13, { color: '#ffffff', align: 'center', lh: 1.3 }));
  o.push(box(16.0, 11.0, 4.5, 1.1, `background: #ffffff; border: 2px solid ${RED}; border-radius: 6px`), text(16.0, 11.2, 4.5, '<b>Lorem Ipsum Dolor</b><br><span style="font-size: .8em; color: ' + GREY + '">Sit: amet, elit, sed</span>', 13, { color: INK, align: 'center', lh: 1.3 }));
  ([[12.3, 9.0, 'Lorem Ipsum'], [12.3, 11.05, 'Dolor Sit Amet'], [21.25, 9.0, 'Elit Sed'], [21.25, 11.05, 'Tempor Magna']] as const).forEach(([x, y, s]) =>
    o.push(box(x, y, 1.8, 1.05, `background: #ffffff; border: 2px solid ${RED}; border-radius: 4px`), text(x, y + .2, 1.8, `<b>${s}</b><br><span style="font-size: .8em; color: ${GREY}">lorem ipsum</span>`, 11.5, { color: INK, align: 'center', lh: 1.3 })));
  o.push(fig('flow', 14.1, 9.2, 1.4, .7, { colours: [GREY], ink: GREY, text: 8, label: ' | | | ' }), fig('flow', 20.6, 9.2, .6, .7, { colours: [GREY], ink: GREY, text: 8, label: ' | | | ' }));
  o.push(cap(12.44, 13.06, 10.6, `5.</b> ${lorem(12, 560)}`));
  o.push(head(12.44, 13.7, 10.7, '3&ensp;Lorem'));
  o.push(body(12.53, 14.3, 10.5, bullets([`<b>${lorem(4, 580)}</b> ${lorem(14, 590)}`, `<b>${lorem(4, 610)}</b> ${lorem(20, 620)}`, `<b>${lorem(4, 640)}</b> ${lorem(18, 650)}`, `<b>${lorem(3, 670)}</b> ${lorem(18, 680)}`], .25), 19.6));
  o.push(fig('grouped', 12.35, 18.15, 5.95, 3.55, cs(1, [RED, '#2d7fb8']))), o.push(fig('hbars', 18.6, 18.55, 4.55, 2.1, cs(2, [RED, '#c26070'])));
  o.push(cap(12.44, 21.9, 6, `6.</b> ${lorem(6, 700)}`), cap(18.4, 21.0, 4.8, `7.</b> ${lorem(9, 710)}`));
  o.push(fig('hbars', 12.35, 22.4, 5.8, 2.55, cs(3, [RED, '#b9b9b9'])), fig('grouped', 18.3, 22.25, 4.85, 2.8, { ...cs(4, [RED, '#2d7fb8', '#3a3a3a']), series: 3 }));
  o.push(cap(12.44, 25.55, 6, `8.</b> ${lorem(8, 730)}`), cap(18.4, 25.45, 4.8, `9.</b> ${lorem(8, 740)}`));
  o.push(head(12.35, 26.36, 10.8, '4&ensp;Lorem Ipsum'));
  o.push(body(12.44, 27.13, 10.6, bullets([`<b>${lorem(3, 760)}</b> ${lorem(30, 770)}`, `<b>${lorem(3, 800)}</b> ${lorem(28, 810)}`], .25), 19.6));
  o.push(head(12.23, 29.58, 10.9, '5&ensp;Lorem Ipsum'));
  o.push(body(12.44, 30.18, 10.6, bullets([`<b>${lorem(5, 840)}</b> ${lorem(27, 850)}`, `<b>${lorem(4, 880)}</b> ${lorem(26, 890)}`], .25), 19.6));
  o.push(body(12.44, 32.36, 10.6, `<b>Lorem ipsum.</b> ${lorem(44, 920)}`, 19.6));
  o.push(text(12.35, 34.08, 10.7, 'LOREM IPSUM', 17.8, { color: RED, weight: 700, lh: 1.2 }), box(12.35, 34.36, 10.7, .02, `background: ${RED}`));
  o.push(text(12.35, 34.42, 10.7, lorem(56, 970), 14, { color: GREY, lh: 1.25 }));
  return o;
}

/** The poster's objects for template `t` (one of the seven ids above). */
export function symposiumPosterObjects(t: ScientificTemplate, title: string): string[] {
  const make = { 'symposium-steps': steps, 'symposium-twin': twin, 'symposium-dark': dark, 'symposium-cards': cards, 'symposium-banner': banner, 'symposium-editorial': editorial, 'symposium-portrait': portrait }[t.id];
  if (!make) throw new Error(`Unknown symposium poster: ${t.id}`);
  return make(t, title);
}
export const SYMPOSIUM_POSTERS = ['symposium-steps', 'symposium-twin', 'symposium-dark', 'symposium-cards', 'symposium-banner', 'symposium-editorial', 'symposium-portrait'] as const;

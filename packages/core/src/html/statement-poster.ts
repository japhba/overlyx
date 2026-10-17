/** A 2026 project poster's layout (48 × 36 in landscape, after Mike Morrison's #betterposter):
 * the title and authors across the top, one large plain-language statement in a coloured box with
 * a QR code, a two-step explainer beneath it, and numbered evidence panels down both sides.
 * Measured from the source in inches; its research text, people, figures and logos are replaced by
 * editable analytical examples. Its Arial is Fira Sans (the template fonts), all bold as there.
 */
import type { ScientificTemplate } from './scientific.ts';
import type { Chart, ChartType } from './scientific-charts.ts';

const px = (n: number) => +(n * 96).toFixed(2);
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const PURPLE = '#6d28d9', HIGHLIGHT = '#5b21b6', INK = '#241a44', RED = '#c8372f', BLUE = '#0a86f0', GREY = '#7d7c7a', CREAM = '#fdfcf8';

/**
 * A text block whose first line's letters start at `top` (inches, as measured on the source: the
 * line box begins half the leading above them). Bold unless `extra` says otherwise.
 */
function text(x: number, top: number, w: number, value: string, pt: number, lh = 1.3, extra = '', tag = 'p'): string {
  const y = top - (lh - 1) * pt / 144;
  return `<${tag} style="position: absolute; left: ${px(x)}px; top: ${px(y)}px; width: ${px(w)}px; font-size: ${+(pt * 4 / 3).toFixed(2)}px; line-height: ${lh}; font-weight: 700; letter-spacing: 0; color: ${INK}${extra ? '; ' + extra : ''}">${value}</${tag}>`;
}
const shape = (x: number, y: number, w: number, h: number, style: string) =>
  `<div class="decoration" style="position: absolute; left: ${px(x)}px; top: ${px(y)}px; width: ${px(w)}px; height: ${px(h)}px; ${style}"></div>`;
/** words in the poster's highlight colour (its key phrases) */
const hl = (s: string) => `<span style="color: ${HIGHLIGHT}">${s}</span>`;
/** a panel's heading: "[n] …" in the accent colour */
const heading = (x: number, top: number, w: number, value: string, pt = 42) => text(x, top, w, value, pt, 1.2, `color: ${PURPLE}`, 'h2');
/** body copy as on the source: bold, 30 pt, about 0.6 in a line */
const body = (x: number, top: number, w: number, value: string) => text(x, top, w, value, 30, 1.43);
/** a filled number in a circle (the source's numbered steps) */
function bullet(cx: number, cy: number, n: number): string {
  return shape(cx - .4, cy - .4, .8, .8, `border-radius: 50%; background: ${PURPLE}`) + text(cx - .4, cy - .4 + (.8 - 34 * 1.2 / 72) / 2 + .03, .8, String(n), 34, 1.2, 'color: #ffffff; text-align: center');
}

export function statementPosterObjects(t: ScientificTemplate, title: string, chart: Chart): string[] {
  const name = esc(title || t.exampleTitle);
  const fig = (type: ChartType, x: number, y: number, w: number, h: number) => chart(type, px(x), px(y), px(w), px(h), { text: 30 });
  const o: string[] = [];

  // the top: title, authors and affiliations, centred over the whole width
  o.push(text(.5, .48, 47, name, 82, 1, `color: ${PURPLE}; text-align: center`, 'h1'));
  // (Fira's ascent and descent are taller than Arial's: the authors a little lower than the source's 1.71 in)
  o.push(text(.5, 1.8, 47, 'Your Name  ·  Alex Morgan  ·  Sam Rivera  ·  Jordan Lee', 44, 1.2, `color: ${PURPLE}; font-weight: 400; text-align: center`));
  o.push(text(.5, 2.58, 47, 'Centre for Applied Mathematics  ·  Institute for Quantitative Science  ·  Applied Physics Lab', 36, 1.2, `color: ${PURPLE}; font-weight: 400; text-align: center`));

  // the left column: [1] – [3]
  o.push(heading(.44, 2.4, 10.4, '[1] Fine structure fades first under diffusion'));
  o.push(fig('decay', .25, 3.9, 10.75, 4.48));
  o.push(body(.27, 9.19, 10.6, `${hl('A pattern twice as fine decays four times faster')}, from the same start and under the same diffusivity: ${hl('the broad mode outlives its harmonic')} by a factor of four.`));
  o.push(fig('profiles', .27, 11.9, 10.71, 4.31));
  o.push(heading(.27, 16.58, 10.6, '[2] Lifetimes follow a power law'));
  o.push(body(.27, 17.47, 10.6, `${hl('Every Fourier mode decays on its own')}, at the rate Dk². On logarithmic axes all lifetimes lie on one line of slope −2, whatever the initial profile.`));
  o.push(fig('lifetime', .44, 19.99, 9.91, 6.95));
  o.push(heading(.44, 27.15, 10.6, '[3] Spreading in space and time', 40));
  o.push(body(.27, 28.39, 11.4, `${hl('A point source spreads as a Gaussian')} whose width grows as √t, and its ${hl('mean squared displacement grows linearly')}, with slope 2D for every diffusivity.`));
  o.push(fig('kernel', .2, 30.75, 6, 5.1), fig('msd', 6.3, 30.75, 6, 5.1));

  // the centre: the statement, plain language, as large as the box allows; the QR code in its corner
  o.push(shape(11, 3.6, 26, 19.35, `background: ${PURPLE}`));
  o.push(text(12.78, 7.96, 23.4, 'Each doubling of spatial frequency makes a pattern fade four times faster', 140, 1.27, 'color: #ffffff', 'h2'));
  o.push(shape(32.07, 18.42, 3.69, 3.69, 'border: 5px dashed #ffffff; border-radius: 12px'));
  o.push(text(32.07, 20.05, 3.69, 'QR code', 30, 1.2, 'color: #ffffff; font-weight: 400; text-align: center'));
  o.push(text(32.07, 22.28, 3.69, 'Paper &amp; code', 24, 1.2, 'color: #ffffff; font-weight: 400; text-align: center'));

  // beneath it: two steps — a profile's two scales, and how long each survives
  for (const [n, cx, label] of [[1, 11.69, 'Take a profile with two spatial scales'], [2, 24.81, 'Ask how long each scale survives']] as const) {
    o.push(shape(cx - .54, 23.4, 1.08, 1.08, `border: 6px solid ${PURPLE}; border-radius: 50%; background: #ffffff`));
    o.push(text(cx - .54, 23.68, 1.08, String(n), 38, 1.2, 'color: #000000; text-align: center'));
    o.push(text(cx + .87, 23.68, 12, label, 40, 1.2, 'color: #000000'));
  }
  const rows = [
    { c: RED, dy: 0, title: 'Broad pattern', what: 'a wave as long as the domain: <i>cos x</i>', k: 'k = 1', tag: '⟨MODE k = 1⟩', q: 'How long does this scale last?', a: 'τ₁ = 1 / Dk²: the longest-lived scale' },
    { c: BLUE, dy: 5.19, title: 'Fine pattern', what: 'a ripple twice as fine: <i>0.45 cos 2x</i>', k: 'k = 2', tag: '⟨MODE k = 2⟩', q: 'And this finer one?', a: 'τ₂ = τ₁ / 4: gone four times sooner' },
  ];
  for (const r of rows) {
    const y = 25.02 + r.dy;
    // the scale (coloured), on the profile it is part of (grey), joined by a ⊕
    o.push(shape(13.83, y, 5.92, 3.23, `border: 6px solid ${r.c}; border-radius: 20px; background: ${CREAM}`));
    o.push(text(13.83, y + .3, 5.92, r.title, 46, 1.2, `color: ${r.c}; text-align: center; text-decoration: underline; text-underline-offset: .12em`));
    o.push(text(14.1, y + 1.18, 5.38, r.what, 36, 1.3, `color: ${r.c}; font-weight: 400; font-style: italic; text-align: center`));
    o.push(text(13.83, y + 2.5, 5.62, r.k, 40, 1.2, `color: ${r.c}; text-align: right`));
    o.push(shape(13.83, y + 3.25, 5.92, 1.42, `border: 6px solid ${GREY}; border-radius: 20px; background: ${CREAM}`));
    o.push(text(13.83, y + 3.72, 5.92, 'Initial profile', 40, 1.2, `color: ${GREY}; text-align: center`));
    o.push(shape(16.37, y + 2.83, .84, .84, `border: 6px solid ${PURPLE}; border-radius: 50%; background: #ffffff`));
    o.push(`<svg class="decoration" viewBox="0 0 10 10" style="position: absolute; left: ${px(16.55)}px; top: ${px(y + 3.01)}px; width: ${px(.48)}px; height: ${px(.48)}px"><path d="M5 0v10M0 5h10" stroke="${PURPLE}" stroke-width="1.6"/></svg>`);
    // the dashed line through the transform to the question
    o.push(shape(19.8, y + .87, 5.45, 0, `border-top: 7px dashed ${r.c}`));
    o.push(`<svg class="decoration" viewBox="0 0 10 10" style="position: absolute; left: ${px(25.12)}px; top: ${px(y + .72)}px; width: ${px(.32)}px; height: ${px(.32)}px"><polygon points="0,0 10,5 0,10" fill="${r.c}"/></svg>`);
    o.push(shape(21.98, y + .59, 1.21, .62, `border: 4px solid ${GREY}; border-radius: 6px; background: #ffffff`));
    o.push(text(21.98, y + .7, 1.21, 'FFT', 30, 1.2, `color: ${GREY}; text-align: center`));
    o.push(shape(25.38, y + .21, 8.81, 2.1, `border: 5px solid #595957; border-radius: 20px; background: ${CREAM}`));
    o.push(shape(25.72, y + .45, 3.95, .58, `border: 4px dashed ${r.c}; border-radius: 4px`));
    o.push(text(25.72, y + .56, 3.95, r.tag, 28, 1.2, `color: ${r.c}; text-align: center; font-family: 'DejaVu Sans Mono', Menlo, Consolas, monospace`));
    o.push(text(25.75, y + 1.32, 8.2, r.q, 38, 1.2, 'color: #131217; font-weight: 400'));
    // the answer, with its emblem
    o.push(shape(25.32, y + 2.95, 1.15, 1.15, `border: 5px solid ${PURPLE}; border-radius: 50%; background: #f3edff`));
    o.push(text(25.32, y + 3.17, 1.15, 'τ', 46, 1.2, `color: ${PURPLE}; text-align: center`));
    o.push(shape(26.79, y + 2.75, 8.54, 1.75, `border: 5px solid #7b3fa9; border-radius: 20px; background: #ffffff`));
    o.push(text(27.12, y + 2.95, 7.95, r.a, 38, 1.32, 'color: #131217'));
  }

  // the right column: [4] the method in three numbered steps, [5] two further results
  o.push(heading(37.99, 2.68, 9.6, '[4] Solving the model', 40));
  o.push(body(37.99, 3.72, 9.6, `${hl('The heat equation')} is linear, so each spatial scale evolves on its own and the exact solution is a sum of decaying modes. We solve it in three steps:`));
  const steps = [
    `Expand the initial profile in ${hl('Fourier modes')} cos kx and sin kx`,
    `Let each mode decay at ${hl('its own rate')} Dk², independently of the others`,
    `${hl('Sum the modes')} to get the profile at any later time — exact, with no fitted parameters`,
  ];
  [6.41, 7.9, 9.4].forEach((top, i) => { o.push(bullet(38.22, top + .37, i + 1), text(39, top, 8.7, steps[i], 28, 1.48)); });
  o.push(fig('spectrum', 37, 11.92, 10.7, 5.33));
  o.push(heading(37.28, 17.69, 10.2, '[5] Two modes measure the diffusivity', 38));
  o.push(body(37.4, 19.44, 10.3, `${hl('The ratio of two mode amplitudes')} decays exponentially. Its slope on a log axis ${hl('gives D without knowing the starting amplitudes')}.`));
  o.push(fig('ratio', 37.28, 22.11, 10.5, 5.9));
  o.push(body(37.49, 28.23, 10.3, `Summed over all modes, ${hl('the total variance falls fastest at first')}, then ${hl('at the rate of the slowest mode')}: the fine scales are already gone.`));
  o.push(fig('variance', 37, 30.95, 10.8, 4.85));
  return o;
}

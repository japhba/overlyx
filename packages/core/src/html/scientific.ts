/**
 * Editable adaptations of published BetterPoster layouts and open Beamer themes.
 * Source geometry, colours, attribution and license are recorded with each design.
 * Example figures are our own analytical illustrations, replacing third-party example artwork.
 */
import { projectPosterObjects } from './project-posters.ts';
import { mitPosterObjects } from './scientific-posters.ts';
import { TEMPLATE_FONTS, TEMPLATE_FONT_LICENSE } from './scientific-fonts.ts';
import { chart } from './scientific-charts.ts';
export type ScientificKind = 'deck' | 'poster';
export interface ScientificTemplate {
  id: string;
  kind: ScientificKind;
  name: string;
  description: string;
  size: string;
  width: number;
  height: number;
  exampleTitle: string;
  background: string;
  ink: string;
  accent: string;
  muted: string;
  source: string;
  author: string;
  license: string;
}

export const SCIENTIFIC_TEMPLATES: readonly ScientificTemplate[] = [
  { id: 'betterposter', kind: 'poster', name: 'MIT EvenBetter landscape', description: 'The published 48 × 36 in PowerPoint layout: graphical-abstract sidebar, take-home band and four figure panels.', size: '48 × 36 in · landscape', width: 1219.2, height: 914.4, exampleTitle: 'Diffusion erases small patterns first', background: '#ffffff', ink: '#111111', accent: '#317f59', muted: '#565656', source: 'https://mit-becl.github.io/Poster_Resources/PowerPoint_Templates/', author: 'MIT Biological Engineering Communication Lab', license: 'CC0-1.0' },
  { id: 'figure-first', kind: 'poster', name: 'MIT EvenBetter figure sketch', description: 'The published Illustrator landscape sketch, including its numbered figures, green graphical abstract and footer blocks.', size: '48 × 36 in · landscape', width: 1219.2, height: 914.4, exampleTitle: 'Damping stabilizes oscillations', background: '#ffffff', ink: '#111111', accent: '#317f59', muted: '#565656', source: 'https://mit-becl.github.io/Poster_Resources/Illustrator_Templates/', author: 'Charlie Hirst and the MIT BE Communication Lab', license: 'CC0-1.0' },
  { id: 'research-portrait', kind: 'poster', name: 'MIT EvenBetter portrait', description: 'The published 36 × 48 in PowerPoint layout: title, wide graphical abstract, takeaway band and a two-column evidence grid.', size: '36 × 48 in · portrait', width: 914.4, height: 1219.2, exampleTitle: 'Calibration is more than a single score', background: '#ffffff', ink: '#111111', accent: '#317f59', muted: '#565656', source: 'https://mit-becl.github.io/Poster_Resources/PowerPoint_Templates/', author: 'MIT Biological Engineering Communication Lab', license: 'CC0-1.0' },
  {"id": "bernstein-2026", "kind": "poster", "name": "Bernstein 2026 \u00b7 two columns", "description": "A0 portrait: split abstract band, two unequal columns, blue equation cards, red takeaway and conclusion footer.", "size": "841 \u00d7 1189 mm \u00b7 portrait", "width": 841, "height": 1189, "exampleTitle": "Diffusion reveals the timescales of spatial structure", "background": "#ffffff", "ink": "#1c2026", "accent": "#023d6b", "muted": "#565656", "source": "/#/jan/recurrent_feature/poster_bernstein26/poster_bernstein26_layout.tex", "author": "Project layout adapted with permission", "license": "GPL-3.0-or-later"},
  {"id": "icml-2026", "kind": "poster", "name": "ICML 2026 \u00b7 three columns", "description": "Landscape: wide title, blue takeaway band, three columns with a wider middle column and a narrow final figure.", "size": "1210 \u00d7 910 mm \u00b7 landscape", "width": 1210, "height": 910, "exampleTitle": "Diffusion reveals the timescales of spatial structure", "background": "#ffffff", "ink": "#1c2026", "accent": "#023d6b", "muted": "#565656", "source": "/#/jan/recurrent_feature/poster_icml26.tex", "author": "Project layout adapted with permission", "license": "GPL-3.0-or-later"},
  { id: 'research', kind: 'deck', name: 'Metropolis', description: 'Fira Sans, dark-teal frame titles, an orange title separator and light slides.', size: '16:9 · 5 slides', width: 1280, height: 720, exampleTitle: 'Diffusion across spatial scales', background: '#fafafa', ink: '#23373b', accent: '#eb811b', muted: '#55676a', source: 'https://github.com/matze/mtheme', author: 'Matthias Vogelgesang and contributors', license: 'CC-BY-SA-4.0' },
  { id: 'dark-seminar', kind: 'deck', name: 'Focus', description: 'The original charcoal-and-grey theme: split title page, small caps and a numbered progress bar.', size: '16:9 · 5 slides', width: 1280, height: 720, exampleTitle: 'Stability in two dimensions', background: '#efefef', ink: '#404040', accent: '#404040', muted: '#666666', source: 'https://github.com/pcafrica/focus-beamertheme', author: 'Pasquale Claudio Africa and contributors', license: 'GPL-3.0-or-later' },
  { id: 'serif-colloquium', kind: 'deck', name: 'CambridgeUS', description: 'Classic Beamer: Computer Modern Sans, red-and-grey navigation bands and a three-part footer.', size: '4:3 · 5 slides', width: 1200, height: 900, exampleTitle: 'What a calibrated forecast tells us', background: '#ffffff', ink: '#000000', accent: '#cc0000', muted: '#595959', source: 'https://github.com/josephwright/beamer/blob/main/base/themes/theme/beamerthemeCambridgeUS.sty', author: 'Madhusudan Singh and the Beamer contributors', license: 'GPL-3.0-or-later' },
];

export function scientificTemplate(kind: ScientificKind, id?: string): ScientificTemplate {
  const t = id === undefined ? SCIENTIFIC_TEMPLATES.find(t => t.kind === kind) : SCIENTIFIC_TEMPLATES.find(t => t.kind === kind && t.id === id);
  if (!t) throw new Error(`Unknown ${kind} template: ${id}`);
  return t;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Every text block and figure is a direct, freely editable child of the slide. */
function object(tag: string, x: number, y: number, w: number, content: string, extra = '', cls = ''): string {
  return `  <${tag}${cls ? ` class="${cls}"` : ''} style="position: absolute; left: ${x}px; top: ${y}px; width: ${w}px${extra ? '; ' + extra : ''}">${content}</${tag}>`;
}
const p = (x: number, y: number, w: number, text: string, cls = '', extra = '') => object('p', x, y, w, text, extra, cls);
const heading = (x: number, y: number, w: number, text: string) => object('h2', x, y, w, text);
const rule = (x: number, y: number, w: number, colour = 'var(--accent)', h = 2) => object('div', x, y, w, '', `height: ${h}px; background: ${colour}`, 'decoration');
const equation = (x: number, y: number, w: number, tex: string) => p(x, y, w, `\\[${tex}\\]`, 'equation');

function document(t: ScientificTemplate, title: string, pages: string[], css = ''): string {
  const poster = t.kind === 'poster';
  const font = poster ? 'Carlito' : t.id === 'serif-colloquium' ? 'CMU Sans' : 'Fira Sans';
  return `<!doctype html>
<!--
Design: ${t.name}
Original authors: ${t.author}
Source: ${t.source}
Template license: ${t.license}
Editable HTML adaptation by OverLyX contributors, 2026.
Changes: replaced placeholder content with analytical examples; retained the source layout,
panel proportions and hierarchy; the MIT posters' colours are adjusted for contrast and their logo
and QR areas are outlined placeholders. MIT's Calibri is replaced by its metric-compatible open Carlito.
No MIT logos, identities, or third-party example artwork are included.
Metropolis: copyright 2014-2017 Matthias Vogelgesang and contributors, CC BY-SA 4.0,
https://creativecommons.org/licenses/by-sa/4.0/ (applies to the Metropolis adaptation).
Focus: copyright 2018-2024 Pasquale Claudio Africa and contributors, GPL v3 or later,
https://www.gnu.org/licenses/gpl-3.0.html (applies to the Focus adaptation).
CambridgeUS: copyright 2004 Madhusudan Singh and the Beamer contributors, GPL v3 or later
(upstream GPL/LPPL dual license; applies to the CambridgeUS adaptation).
MIT poster templates: CC0 1.0, https://github.com/MIT-BECL/Poster_Resources/blob/master/License-Templates
Carlito, Fira Sans and CMU Sans fonts: SIL Open Font License 1.1, https://openfontlicense.org/
All plots are generated from the analytical functions described in the captions.
These are teaching examples, not experimental measurements or published research results.

${TEMPLATE_FONT_LICENSE}
-->
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="overlyx" content="${t.kind}">
<meta name="overlyx-template" content="${t.id}">
<meta name="license" content="${t.license}">
<title>${esc(title)}</title>
<style>
  ${TEMPLATE_FONTS[font]}
  :root { --paper: ${t.background}; --ink: ${t.ink}; --accent: ${t.accent}; --muted: ${t.muted}; --secondary: ${t.id === 'dark-seminar' ? '#f1be75' : '#bc6747'}; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #dce0e4; color: var(--ink); font-family: "${font}", Arial, Helvetica, sans-serif; }
  .slide { width: ${t.width}${poster ? 'mm' : 'px'}; height: ${t.height}${poster ? 'mm' : 'px'}; position: relative; overflow: hidden; background: var(--paper); margin: 0 auto ${poster ? '0' : '40px'}; }
  h1, h2, h3, p { margin: 0; }
  h1, h2 { font-family: inherit; font-weight: 700; }
  h1 { font-size: ${poster ? '142' : '64'}px; line-height: 1.08; letter-spacing: -.025em; overflow-wrap: anywhere; }
  h2 { font-size: ${poster ? '70' : '42'}px; line-height: 1.14; letter-spacing: -.015em; }
  p { font-size: ${poster ? '42' : '26'}px; line-height: 1.45; }
  .kicker { font-size: ${poster ? '30' : '20'}px; line-height: 1.3; text-transform: uppercase; letter-spacing: .13em; font-weight: 600; color: var(--accent); }
  .muted, .caption, .footer { color: var(--muted); }
  .caption { font-size: ${poster ? '36' : '20'}px; line-height: 1.45; }
  .footer { font-size: ${poster ? '30' : '20'}px; line-height: 1.4; }
  .equation { font-size: ${poster ? '54' : '32'}px; }
  .notes { display: none; }
  a { color: inherit; text-underline-offset: .18em; }
  @media print { @page { size: ${t.width}${poster ? 'mm' : 'px'} ${t.height}${poster ? 'mm' : 'px'}; margin: 0; } body { background: none; } .slide { margin: 0; break-after: page; break-inside: avoid; print-color-adjust: exact; -webkit-print-color-adjust: exact; } .slide:last-of-type { break-after: auto; } }
${css}
</style>
</head>
<body data-ol-layout-margins="${poster ? t.id === 'research-portrait' ? '1in' : '0.5in' : t.id === 'research' ? '84px 80px 48px' : t.id === 'dark-seminar' ? '84px 60px 36px' : '128px 36px 40px'}">
${pages.map(page => `<section class="slide">\n${page}\n</section>`).join('\n\n')}
</body>
</html>
`;
}

const diffusionReference = '<a href="https://doi.org/10.1017/CBO9781139086967">J. R. Cannon, The One-Dimensional Heat Equation (1984)</a>';
const calibrationReference = '<a href="https://doi.org/10.1175/1520-0493(1950)078%3C0001:VOFEIT%3E2.0.CO;2">G. W. Brier, Verification of forecasts expressed in terms of probability (1950)</a>';

export function scientificPoster(title = '', id?: string): string {
  const t = scientificTemplate('poster', id);
  return document(t, title || t.exampleTitle, [(t.id === 'bernstein-2026' || t.id === 'icml-2026' ? projectPosterObjects(t, title, chart) : mitPosterObjects(t, title, chart)).join('\n')]);
}

export function scientificDeck(title = '', id?: string): string {
  const t = scientificTemplate('deck', id);
  const name = esc(title || t.exampleTitle);
  const serif = t.id === 'serif-colloquium';
  const dark = t.id === 'dark-seminar';
  const wide = t.width - 192;
  const kicker = (x: number, y: number, w: number, text: string) => p(x, y, w, text, 'kicker');
  // Metropolis: the frame number bottom right and its frametitle progress bar; Focus: its numbered
  // progress bar along the bottom; CambridgeUS: the three-part footer.
  const foot = (n: number): string => serif ? [
    rule(0, 870, 400, '#a30000', 30), rule(400, 870, 400, '#ececec', 30), rule(800, 870, 400, '#d9d9d9', 30),
    p(18, 874, 370, 'Your Name (Institution)', 'footer', 'color: #ffffff; text-align: center; font-size: 20px'),
    p(414, 874, 370, 'Scientific presentation', 'footer', 'color: #8f0000; text-align: center; font-size: 20px'),
    p(818, 874, 365, `Conference / Date <span style="float: right">${n} / 5</span>`, 'footer', 'color: #7a0000; font-size: 20px'),
  ].join('\n') : dark ? n === 1 ? '' : [
    rule(0, 700, 1280, '#d6d6d6', 20),
    rule(0, 700, 1280 * (n - 1) / 4, '#404040', 20),
    p(1180, 698, 76, `${n - 1} / 4`, 'footer', `color: ${n === 5 ? '#efefef' : '#404040'}; text-align: right; font-size: 17px; line-height: 24px`),
  ].join('\n') : [
    ...(n > 1 ? [rule(0, 84, 1280 * n / 5, t.accent, 4)] : []),
    p(1160, 668, 80, String(n), 'footer', 'text-align: right'),
  ].join('\n');
  const navigation = (label: string) => [rule(0, 0, 600, '#a30000', 36), rule(600, 0, 600, '#d9d9d9', 36), p(30, 4, 540, 'Research', 'footer', 'color: white; text-align: right; font-size: 22px'), p(620, 4, 540, esc(label.replace(/^.*?\/ /, '')), 'footer', 'color: #7a0000; font-size: 22px')];
  const section = (n: number, label: string, head: string, objects: string[], notes: string) => [
    ...(serif ? [...navigation(label), rule(0, 36, 1200, '#f2f2f2', 92), object('h2', 30, 60, 1140, head, 'color: #cc0000; font-size: 44px; font-weight: 400')]
      : [rule(0, 0, 1280, dark ? '#404040' : '#23373b', 84), object('h2', dark ? 60 : 40, dark ? 18 : 21, dark ? 1160 : 1200, head, `color: ${dark ? '#efefef' : '#fafafa'}; font-size: ${dark ? 38 : 36}px; font-weight: 400; line-height: 1.2${dark ? '; font-variant-caps: small-caps' : ''}`)]),
    ...objects, foot(n), `<aside class="notes">${notes}</aside>`,
  ].join('\n');
  const titleObjects = serif ? [
    ...navigation(''),
    object('div', 36, 228, 1128, '', 'height: 170px; background: white; border-radius: 0 0 16px 16px; box-shadow: 6px 8px 6px #0006', 'decoration'),
    object('h1', 60, 260, 1080, name, 'font-size: 46px; font-weight: 400; color: #cc0000; text-align: center'),
    p(60, 340, 1080, 'A scientific colloquium', '', 'font-size: 34px; color: #cc0000; text-align: center'),
    p(60, 470, 1080, 'Your Name', '', 'font-size: 36px; text-align: center'),
    p(60, 540, 1080, 'Department / Institution', '', 'font-size: 28px; text-align: center; color: var(--muted)'),
    p(60, 620, 1080, 'Conference / Date', '', 'font-size: 32px; text-align: center'), foot(1),
  ] : dark ? [
    rule(0, 0, 1280, '#404040', 360),
    object('h1', 80, 170, 1120, name, 'font-size: 60px; line-height: 1.1; color: #efefef; font-variant-caps: small-caps'),
    p(80, 262, 1120, 'A research seminar', '', 'font-size: 36px; color: #c8c8c8; font-variant-caps: small-caps'),
    p(80, 420, 1120, 'Your Name', '', 'font-size: 40px; font-variant-caps: small-caps'),
    p(80, 488, 1120, 'Department / Institution', '', 'font-size: 30px; font-variant-caps: small-caps; color: var(--muted)'),
    p(80, 540, 1120, 'Conference / Date', '', 'font-size: 30px; font-variant-caps: small-caps; color: var(--muted)'),
  ] : [
    object('h1', 96, 178, 1088, name, 'font-size: 52px; font-weight: 400; line-height: 1.12'),
    p(96, 300, 1088, 'A scientific research talk', '', 'font-size: 32px; color: var(--muted)'),
    rule(96, 370, 1088, '#eb811b', 2),
    p(96, 404, 1088, 'Your Name', '', 'font-size: 30px; font-weight: 400'),
    p(96, 452, 1088, 'Conference / Date', '', 'font-size: 26px'),
    p(96, 494, 1088, 'Department / Institution', '', 'font-size: 26px; color: var(--muted)'), foot(1),
  ];
  const pages = [titleObjects.join('\n')];
  if (dark) {
    pages.push(section(2, '01 / Model', 'Rotation and damping are separate ingredients', [
      p(96, 180, 500, 'A two-dimensional state evolves under a constant linear operator. Damping α controls the envelope; ω sets the rotation rate.'),
      p(96, 380, 500, 'The eigenvalues pair the two: the real part decides growth or decay, the imaginary part the rotation.'),
      equation(660, 170, 524, String.raw`\dot{\mathbf{x}}=\begin{pmatrix}-\alpha&-\omega\\\omega&-\alpha\end{pmatrix}\mathbf{x}`),
      equation(660, 375, 524, String.raw`\lambda_\pm=-\alpha\pm i\omega`),
      p(96, 600, wide, 'Assumptions: linear, autonomous, deterministic.', 'caption'),
    ], 'Define the state variables. This system is exactly solvable; a linearization of a nonlinear model needs a local validity check.'));
    pages.push(section(3, '02 / Phase space', 'Different initial states converge to the same point', [
      chart('phase', 96, 120, 700, 560),
      p(850, 230, 334, 'Positive damping makes the origin stable.'),
      p(850, 400, 334, 'α = 1, ω = 17/3<br>0 ≤ t ≤ 3<br>Three initial phases', 'caption'),
    ], 'The curves are exact solutions, not fitted trajectories or recordings. Describe the inward spiral and the fixed point.'));
    pages.push(section(4, '03 / Interpretation', 'The real part of the eigenvalue decides stability', [
      heading(96, 200, 320, 'α &gt; 0'), p(96, 280, 320, 'Decay toward the fixed point. Perturbations shrink.'),
      heading(480, 200, 320, 'α = 0'), p(480, 280, 320, 'Neutral cycles. The initial amplitude persists.'),
      heading(864, 200, 320, 'α &lt; 0'), p(864, 280, 320, 'Growth away from the origin. The fixed point is unstable.'),
      rule(96, 500, wide, '#404040', 1), p(96, 528, wide, 'Local linear stability alone does not prove global nonlinear stability.', 'caption'),
    ], 'Compare signs of the real eigenvalue component. Do not extrapolate the local conclusion to a global nonlinear system.'));
    pages.push(section(5, '04 / Discussion', 'What changes beyond a linear model?', [
      heading(96, 170, 60, '1'), p(170, 178, 1014, 'How do nonlinear terms reshape the basin of attraction?'),
      heading(96, 290, 60, '2'), p(170, 298, 1014, 'Does stochastic forcing sustain fluctuations near the fixed point?'),
      heading(96, 410, 60, '3'), p(170, 418, 1014, 'Which observable would distinguish damping from dephasing?'),
      p(96, 590, wide, 'Reproduce: x₁ = exp(−t) cos(17t/3 + φ), x₂ = exp(−t) sin(17t/3 + φ); φ ∈ {0, 2.1, 4.2}.', 'caption'),
    ], 'Invite discussion around model assumptions. The explicit solution generates every curve in the phase portrait.'));
  } else if (serif) {
    pages.push(section(2, 'I / The question', 'Does a 70% forecast mean what it says?', [
      p(96, 230, wide, 'Across cases assigned probability 0.7, a calibrated forecast predicts an event frequency of 0.7.'),
      equation(96, 390, wide, String.raw`\mathbb{E}[Y\mid P=p]=p`),
      p(96, 610, wide, 'Calibration is a conditional agreement statement. It does not tell us whether individual cases can be distinguished.', 'caption'),
    ], 'Define P as the forecast and Y as the binary outcome. Calibration is a property of a collection of predictions.'));
    pages.push(section(3, 'II / The evidence', 'A reliability diagram reveals the mismatch', [
      chart('calibration', 96, 160, wide, 560),
      p(96, 736, wide, 'Analytical curves. Dashed: y = p. Solid: y = p² / [p² + (1 − p)²], an underconfident forecast. No empirical samples or confidence intervals are implied.', 'caption'),
    ], 'Read probability on the horizontal axis and event frequency on the vertical axis. Underconfident probabilities lie closer to 0.5 than the observed frequencies, on both sides of 0.5.'));
    pages.push(section(4, 'III / A counterexample', 'Perfect calibration can carry little information', [
      p(96, 230, wide, 'Suppose the event rate is 20%. Predicting 0.2 for every case is calibrated in a population with that rate.'),
      equation(96, 380, wide, String.raw`P\equiv 0.2,\qquad \mathbb{E}[Y]=0.2`),
      p(96, 560, wide, 'The forecast cannot rank cases by risk. Evaluate resolution or discrimination alongside calibration.', '', 'color: var(--accent)'),
    ], 'Use the constant base-rate predictor to distinguish reliability from resolution.'));
    pages.push(section(5, 'IV / Reporting', 'Show reliability, sharpness and uncertainty', [
      p(96, 210, wide, '1. Show a reliability curve with bin counts and intervals.'),
      p(96, 290, wide, '2. Report a proper score and how it was evaluated.'),
      p(96, 370, wide, '3. Check shifts across populations and time.'),
      equation(96, 480, wide, String.raw`\mathrm{BS}=\frac{1}{N}\sum_{i=1}^{N}(p_i-y_i)^2`),
      p(96, 730, wide, calibrationReference, 'caption'),
    ], 'The Brier score is a proper scoring rule for binary outcomes. Replace these analytical examples with a held-out evaluation and uncertainty estimates.'));
  } else {
    pages.push(section(2, '01 / Question and model', 'How long does a spatial pattern survive?', [
      p(96, 168, 500, 'A field diffuses on a periodic one-dimensional domain. Follow one Fourier component at a time.'),
      p(96, 352, 500, 'Each mode keeps its shape and only shrinks, at a rate set by its spatial frequency k.'),
      kicker(680, 172, 504, 'Model'), equation(680, 210, 504, String.raw`\partial_t u=D\,\partial_{xx}u`),
      kicker(680, 356, 504, 'One Fourier mode'), equation(680, 394, 504, String.raw`A_k(t)=A_k(0)\,e^{-Dk^2t}`),
      rule(96, 560, wide, 'var(--muted)', 1),
      p(96, 580, wide, 'Assumptions: constant D · no sources · no advection', 'caption'),
    ], 'Substitute one Fourier mode into the heat equation. The example is analytical rather than experimental.'));
    pages.push(section(3, '02 / Result', 'Double the frequency. Four times faster decay.', [
      chart('decay', 96, 128, 720, 520),
      kicker(870, 196, 314, 'Lifetime'),
      equation(870, 232, 314, String.raw`\tau_k=\frac{1}{Dk^2}`),
      p(870, 400, 314, 'Small-scale structure disappears first.'),
      p(870, 540, 314, 'Curves: e<sup>−s</sup> and e<sup>−4s</sup>, s = t / τ₁.', 'caption'),
    ], 'The curves show exp(−s) and exp(−4s), with s = t/τ₁. Both modes start at unit amplitude.'));
    pages.push(section(4, '03 / Scope', 'The conclusion depends on the model assumptions', [
      kicker(96, 210, 490, 'What follows'),
      p(96, 256, 490, 'For constant diffusivity, the mode lifetime falls as the inverse square of spatial frequency.'),
      kicker(690, 210, 494, 'What to check'),
      p(690, 256, 494, 'Boundary conditions, spatially varying diffusivity and nonlinear coupling may change the mode dynamics.'),
      rule(96, 480, wide, 'var(--muted)', 1),
      p(96, 500, wide, 'In measured data, estimate lifetimes with uncertainty and inspect residuals.', 'caption'),
    ], 'Separate the exact mathematical statement from its application to a real system.'));
    pages.push(section(5, '04 / Takeaway and reproducibility', 'Spatial scale predicts the lifetime of a pattern', [
      kicker(96, 168, wide, 'Takeaway'),
      p(96, 208, wide, 'Higher-frequency modes decay sooner under diffusion.', '', 'font-size: 44px; font-weight: 400; line-height: 1.2'),
      p(96, 352, wide, String.raw`The prediction is quantitative: \(\tau_2=\tau_1/4\) when \(k_2=2k_1\).`),
      rule(96, 500, wide, 'var(--muted)', 1),
      p(96, 520, wide, 'Reproduce the plot: evaluate exp(−s) and exp(−4s) at 101 equally spaced values of s from 0 to 3.', 'caption'),
      p(96, 580, wide, diffusionReference, 'caption'),
    ], 'Close with the single result. The plot has no fitted parameters; all functions and the sampling grid are given on the slide.'));
  }
  return document(t, title || t.exampleTitle, pages, t.id === 'research'
    ? '.slide p { font-size: 28px; font-weight: 300; } .slide h2 { font-weight: 400; } .slide .caption { font-size: 21px; font-weight: 400; } .slide .footer { font-size: 20px; } .slide .kicker { font-size: 18px; color: var(--muted); } .slide .equation { font-size: 34px; }'
    : serif ? '.slide p { font-size: 32px; } .slide .caption, .slide .footer { font-size: 22px; } .slide h2 { font-weight: 400; }'
      : '.slide p { font-size: 28px; } .slide .caption { font-size: 21px; } .slide .footer { font-size: 20px; } .slide h2 { font-size: 40px; }');
}

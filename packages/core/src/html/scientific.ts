/**
 * Original, self-contained scientific HTML templates. MIT licensed (see the generated source).
 * BetterPoster follows Mike Morrison's finding-first communication idea; no third-party theme
 * code, logos, figures, fonts or research results are bundled. All plotted data are analytical.
 */
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
}

export const SCIENTIFIC_TEMPLATES: readonly ScientificTemplate[] = [
  { id: 'betterposter', kind: 'poster', name: 'BetterPoster', description: 'One large takeaway, with methods and evidence at the sides.', size: 'A0 landscape', width: 1189, height: 841, exampleTitle: 'Diffusion erases small patterns first', background: '#ffffff', ink: '#153735', accent: '#126b60', muted: '#50645f' },
  { id: 'figure-first', kind: 'poster', name: 'Figure first', description: 'A large phase portrait, short captions and a clear reading path.', size: 'A0 landscape', width: 1189, height: 841, exampleTitle: 'Damping turns cycles into stable states', background: '#faf8f2', ink: '#302f39', accent: '#9d4935', muted: '#66616a' },
  { id: 'research-portrait', kind: 'poster', name: 'Research portrait', description: 'Two columns for a question, model, results and limitations.', size: 'A0 portrait', width: 841, height: 1189, exampleTitle: 'Calibration is more than a single score', background: '#ffffff', ink: '#242e47', accent: '#4355a0', muted: '#596278' },
  { id: 'research', kind: 'deck', name: 'Minimal research', description: 'Light, spacious slides with a large plot and one claim per slide.', size: '16:9 · 5 slides', width: 1280, height: 720, exampleTitle: 'Diffusion across spatial scales', background: '#ffffff', ink: '#193833', accent: '#126b60', muted: '#526861' },
  { id: 'dark-seminar', kind: 'deck', name: 'Dark seminar', description: 'A dark canvas, bright trajectories and a technical model walkthrough.', size: '16:9 · 5 slides', width: 1280, height: 720, exampleTitle: 'Stability in two dimensions', background: '#14232e', ink: '#f3f5f4', accent: '#7de2cf', muted: '#b4c7cf' },
  { id: 'serif-colloquium', kind: 'deck', name: 'Serif colloquium', description: 'Warm paper, serif titles, an analytical argument and discussion.', size: '4:3 · 5 slides', width: 1200, height: 900, exampleTitle: 'What a calibrated forecast tells us', background: '#faf7ef', ink: '#342e28', accent: '#9a4434', muted: '#6a6055' },
];

export function scientificTemplate(kind: ScientificKind, id?: string): ScientificTemplate {
  const t = id === undefined ? SCIENTIFIC_TEMPLATES.find(t => t.kind === kind) : SCIENTIFIC_TEMPLATES.find(t => t.kind === kind && t.id === id);
  if (!t) throw new Error(`Unknown ${kind} template: ${id}`);
  return t;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const license = `MIT License

Copyright (c) 2026 OverLyX contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

/** Every text block and figure is a direct, freely editable child of the slide. */
function object(tag: string, x: number, y: number, w: number, content: string, extra = '', cls = ''): string {
  return `  <${tag}${cls ? ` class="${cls}"` : ''} style="position: absolute; left: ${x}px; top: ${y}px; width: ${w}px${extra ? '; ' + extra : ''}">${content}</${tag}>`;
}
const p = (x: number, y: number, w: number, text: string, cls = '', extra = '') => object('p', x, y, w, text, extra, cls);
const heading = (x: number, y: number, w: number, text: string) => object('h2', x, y, w, text);
const rule = (x: number, y: number, w: number, colour = 'var(--accent)', h = 2) => object('div', x, y, w, '', `height: ${h}px; background: ${colour}`, 'decoration');
const equation = (x: number, y: number, w: number, tex: string) => p(x, y, w, `\\[${tex}\\]`, 'equation');

function chart(type: 'decay' | 'phase' | 'calibration', x: number, y: number, w: number, h: number): string {
  const path = (f: (t: number) => [number, number], n = 100) => Array.from({ length: n + 1 }, (_, i) => f(i / n).map(v => v.toFixed(2)).join(',')).join(' ');
  const line = (points: string, colour: string, dash = '') => `<polyline points="${points}" fill="none" stroke="${colour}" stroke-width="3"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
  let content = '';
  let label = '';
  const labelText = (tx: number, ty: number, s: string, anchor = 'start') => `<text x="${tx}" y="${ty}" text-anchor="${anchor}" fill="currentColor" font-family="Arial, sans-serif" font-size="18">${s}</text>`;
  if (type === 'decay') {
    label = 'Analytical diffusion: normalized amplitude against dimensionless time. The second spatial mode decays four times faster.';
    content = [0, .5, 1].map(v => `<line x1="65" x2="570" y1="${310 - v * 260}" y2="${310 - v * 260}" stroke="currentColor" opacity=".15"/>${labelText(53, 316 - v * 260, String(v), 'end')}`).join('');
    content += [0, 1, 2, 3].map(v => labelText(65 + v * 505 / 3, 338, String(v), 'middle')).join('');
    content += line(path(t => [65 + 505 * t, 310 - 260 * Math.exp(-3 * t)]), 'var(--accent)');
    content += line(path(t => [65 + 505 * t, 310 - 260 * Math.exp(-12 * t)]), 'var(--secondary)', '8 5');
    content += labelText(80, 28, 'Normalized amplitude') + labelText(320, 375, 'Time / τ₁', 'middle');
    content += `<line x1="350" y1="72" x2="385" y2="72" stroke="var(--accent)" stroke-width="3"/>${labelText(398, 78, 'mode 1')}<line x1="350" y1="104" x2="385" y2="104" stroke="var(--secondary)" stroke-width="3" stroke-dasharray="8 5"/>${labelText(398, 110, 'mode 2')}`;
  } else if (type === 'phase') {
    label = 'Analytical phase portrait for a damped two-dimensional linear system, with three trajectories converging to the origin.';
    content = `<line x1="65" x2="570" y1="180" y2="180" stroke="currentColor" opacity=".25"/><line x1="315" x2="315" y1="30" y2="315" stroke="currentColor" opacity=".25"/>`;
    for (const [i, a] of [0, 2.1, 4.2].entries()) {
      content += line(path(t => { const r = Math.exp(-3 * t); return [315 + 225 * r * Math.cos(17 * t + a), 180 - 130 * r * Math.sin(17 * t + a)]; }, 240), ['var(--accent)', 'var(--secondary)', 'var(--muted)'][i]);
    }
    content += `<circle cx="315" cy="180" r="5" fill="currentColor"/>` + labelText(320, 375, 'State x₁', 'middle') + labelText(80, 28, 'State x₂') + labelText(335, 170, 'stable fixed point');
    content += labelText(65, 340, '−1') + labelText(560, 340, '1', 'end');
  } else {
    label = 'Analytical reliability diagram: the identity line is perfectly calibrated; a square-root curve is underconfident.';
    content = [0, .5, 1].map(v => `<line x1="65" x2="570" y1="${310 - v * 260}" y2="${310 - v * 260}" stroke="currentColor" opacity=".15"/>${labelText(53, 316 - v * 260, String(v), 'end')}${labelText(65 + v * 505, 338, String(v), 'middle')}`).join('');
    content += line('65,310 570,50', 'var(--muted)', '7 6');
    content += line(path(t => [65 + 505 * t, 310 - 260 * Math.sqrt(t)]), 'var(--accent)');
    content += labelText(80, 28, 'Event frequency') + labelText(320, 375, 'Predicted probability', 'middle') + labelText(295, 285, 'perfect calibration') + labelText(95, 100, 'underconfident');
  }
  return `  <svg role="img" aria-label="${label}" viewBox="0 0 600 400" style="position: absolute; left: ${x}px; top: ${y}px; width: ${w}px; height: ${h}px">${content}</svg>`;
}

function document(t: ScientificTemplate, title: string, pages: string[]): string {
  const poster = t.kind === 'poster';
  const serif = t.id === 'serif-colloquium' || t.id === 'figure-first';
  return `<!doctype html>
<!--
${license}

Design: ${t.name}. ${t.id === 'betterposter' ? 'Inspired by Mike Morrison’s BetterPoster project: https://osf.io/6ua4k/ (independent HTML implementation).' : 'Original OverLyX scientific template.'}
All plots are generated from the analytical functions described in the captions.
These are teaching examples, not experimental measurements or published research results.
-->
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="overlyx" content="${t.kind}">
<meta name="overlyx-template" content="${t.id}">
<meta name="license" content="MIT">
<title>${esc(title)}</title>
<style>
  :root { --paper: ${t.background}; --ink: ${t.ink}; --accent: ${t.accent}; --muted: ${t.muted}; --secondary: ${t.id === 'dark-seminar' ? '#f1be75' : '#bc6747'}; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #dce0e4; color: var(--ink); font-family: Arial, Helvetica, sans-serif; }
  .slide { width: ${t.width}${poster ? 'mm' : 'px'}; height: ${t.height}${poster ? 'mm' : 'px'}; position: relative; overflow: hidden; background: var(--paper); margin: 0 auto ${poster ? '0' : '40px'}; }
  h1, h2, h3, p { margin: 0; }
  h1, h2 { font-family: ${serif ? 'Georgia, "Times New Roman", serif' : 'Arial, Helvetica, sans-serif'}; font-weight: ${serif ? '400' : '600'}; }
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
</style>
</head>
<body data-ol-layout-margins="${poster ? '40mm' : '72px 96px'}">
${pages.map(page => `<section class="slide">\n${page}\n</section>`).join('\n\n')}
</body>
</html>
`;
}

const diffusionReference = '<a href="https://doi.org/10.1017/CBO9781139086967">J. R. Cannon, The One-Dimensional Heat Equation (1984)</a>';
const calibrationReference = '<a href="https://doi.org/10.1175/1520-0493(1950)078%3C0001:VOFEIT%3E2.0.CO;2">G. W. Brier, Verification of forecasts expressed in terms of probability (1950)</a>';

export function scientificPoster(title = '', id?: string): string {
  const t = scientificTemplate('poster', id);
  const name = esc(title || t.exampleTitle);
  const byline = 'Your Name · Department / Institution · Conference / Year';
  let objects: string[];
  if (t.id === 'betterposter') {
    // A0 landscape, three zones: a deliberately dominant finding and two supporting sidebars.
    objects = [
      rule(1250, 151, 1730, 'var(--accent)', 2700),
      object('h1', 1370, 480, 1490, name, 'color: #ffffff; font-size: 162px'),
      p(151, 160, 1010, 'Analytical model · Open methods', 'kicker'),
      heading(151, 250, 1000, 'The question'),
      p(151, 370, 970, 'How quickly does a spatial pattern disappear when its components diffuse?'),
      heading(151, 720, 980, 'The model'),
      p(151, 840, 970, 'A one-dimensional field on a periodic domain. Constant diffusivity D; no forcing or advection.'),
      equation(151, 1170, 970, String.raw`\partial_t u = D\,\partial_{xx}u`),
      p(151, 1490, 970, 'Each Fourier mode evolves independently. Its spatial frequency sets its decay rate.'),
      equation(151, 1810, 970, String.raw`A_k(t)=A_k(0)e^{-Dk^2t}`),
      p(151, 2190, 970, 'Reproduce the figure', 'kicker'),
      p(151, 2270, 970, 'Plot exp(−s) and exp(−4s) for s from 0 to 3. Both start at unit amplitude. No fitted parameters.'),
      p(1370, 290, 1490, 'The main finding', 'kicker', 'color: #d8f0e8'),
      p(1370, 1300, 1490, 'Double the spatial frequency.<br>Four times faster decay.', '', 'color: #ffffff; font-size: 90px; line-height: 1.2'),
      p(1370, 1970, 1490, 'Small-scale structure smooths out before large-scale structure.', '', 'color: #e2f1ec; font-size: 60px'),
      p(1370, 2540, 1490, 'Analytical teaching example · not measured data', 'caption', 'color: #e2f1ec'),
      p(3090, 160, 1250, '01 / Evidence', 'kicker'),
      heading(3090, 250, 1250, 'Same start, different lifetimes'),
      chart('decay', 3060, 510, 1250, 850),
      p(3090, 1400, 1200, 'Normalized mode amplitudes. Time is measured in the lifetime of the first mode, τ₁ = 1/(Dk₁²).', 'caption'),
      heading(3090, 1820, 1200, 'What this does not show'),
      p(3090, 1950, 1200, 'Variable diffusivity, boundaries and nonlinear coupling can change this picture. Test those assumptions before interpreting measured data.'),
      p(3090, 2430, 1200, 'Background', 'kicker'),
      p(3090, 2510, 1200, diffusionReference, 'footer'),
      rule(151, 2960, 4190),
      p(151, 3010, 4190, byline, 'footer'),
    ];
  } else if (t.id === 'figure-first') {
    objects = [
      p(151, 151, 4100, 'Dynamics / An analytical study', 'kicker'),
      object('h1', 151, 270, 4100, name),
      p(151, 650, 4100, byline, 'muted'),
      rule(151, 800, 4190),
      heading(151, 950, 2540, 'Three paths. One fixed point.'),
      chart('phase', 151, 1160, 2550, 1400),
      p(151, 2670, 2450, 'Exact trajectories: x₁ = e⁻ᵅᵗ cos(ωt + φ), x₂ = e⁻ᵅᵗ sin(ωt + φ). Three initial phases, identical damping; axes shown in arbitrary state units.', 'caption'),
      p(2940, 950, 1370, '01 / Question', 'kicker'),
      heading(2940, 1030, 1370, 'When do oscillations settle?'),
      p(2940, 1260, 1370, 'Consider a linear system with rotation rate ω and damping α. The origin is a stable fixed point when α is positive.'),
      equation(2940, 1600, 1370, String.raw`\dot{\mathbf{x}}=\begin{pmatrix}-\alpha&-\omega\\\omega&-\alpha\end{pmatrix}\mathbf{x}`),
      p(2940, 1980, 1370, '02 / Interpretation', 'kicker'),
      p(2940, 2070, 1370, 'The eigenvalues −α ± iω separate stability from oscillation. The envelope decays as e⁻ᵅᵗ; the angular frequency remains ω.'),
      p(2940, 2460, 1370, '03 / Limitations', 'kicker'),
      p(2940, 2550, 1370, 'A local linear model does not establish global stability in a nonlinear system.', 'caption'),
      rule(151, 2960, 4190),
      p(151, 3010, 4190, 'Analytical teaching example · Parameters: α = 1, ω = 17/3; 0 ≤ t ≤ 3 · No experimental data', 'footer'),
    ];
  } else {
    objects = [
      p(151, 151, 2850, 'Statistical methods / Analytical example', 'kicker'),
      object('h1', 151, 280, 2850, name),
      p(151, 800, 2850, byline, 'muted'),
      rule(151, 970, 2875),
      heading(151, 1110, 1320, '01 / The question'),
      p(151, 1250, 1320, 'When a forecast assigns probability p, does the event occur with frequency p? Reliability diagrams inspect this relationship directly.'),
      heading(1690, 1110, 1320, '02 / Definition'),
      equation(1690, 1310, 1320, String.raw`\mathbb{E}[Y\mid P=p]=p`),
      p(1690, 1580, 1320, 'Y is a binary outcome. P is its predicted probability. Calibration describes agreement, rather than how sharp the forecasts are.'),
      heading(151, 1930, 2850, '03 / Inspect the whole curve'),
      chart('calibration', 300, 2110, 2510, 1450),
      p(151, 3600, 2850, 'Analytical curves, not estimated data. The dashed identity is perfect calibration; the solid curve illustrates an underconfident forecast, with event frequency √p.', 'caption'),
      heading(151, 3900, 1320, '04 / Report uncertainty'),
      p(151, 4040, 1320, 'With measured data, show bin counts and uncertainty intervals. Sparse bins can make an apparently smooth curve misleading.'),
      heading(1690, 3900, 1320, '05 / Go beyond calibration'),
      p(1690, 4040, 1320, 'A constant forecast at the base rate can be calibrated. Report discrimination and a proper score alongside reliability.'),
      rule(151, 4330, 2875),
      p(151, 4370, 2875, calibrationReference, 'footer'),
    ];
  }
  return document(t, title || t.exampleTitle, [objects.join('\n')]);
}

export function scientificDeck(title = '', id?: string): string {
  const t = scientificTemplate('deck', id);
  const name = esc(title || t.exampleTitle);
  const serif = t.id === 'serif-colloquium';
  const dark = t.id === 'dark-seminar';
  const right = t.width - 96;
  const wide = t.width - 192;
  const footerY = t.height - 54;
  const foot = (n: number) => p(96, footerY, wide, `Analytical teaching example <span style="float: right">${String(n).padStart(2, '0')} / 05</span>`, 'footer');
  const section = (n: number, label: string, head: string, objects: string[], notes: string) => [p(96, 66, wide, label, 'kicker'), heading(96, 112, wide, head), ...objects, foot(n), `<aside class="notes">${notes}</aside>`].join('\n');
  const pages = [
    [
      rule(96, 155, 80, 'var(--accent)', 5),
      p(96, 200, wide, dark ? 'Dynamical systems / Research seminar' : serif ? 'Probability / Colloquium' : 'Transport / Research talk', 'kicker'),
      object('h1', 96, 270, wide, name),
      p(96, serif ? 565 : 500, wide, 'Your Name · Department / Institution', 'muted'),
      p(96, serif ? 620 : 545, wide, 'Conference / Seminar · Date', 'caption'),
      foot(1),
      '<aside class="notes">State the scientific question and define the scope. All plots in this deck are analytical illustrations. Replace the example with your own study, including evidence and uncertainty.</aside>',
    ].join('\n'),
  ];
  if (dark) {
    pages.push(section(2, '01 / Model', 'Rotation and damping are separate ingredients', [
      p(96, 230, 480, 'A two-dimensional state evolves under a constant linear operator. Damping α controls the envelope; ω sets the rotation rate.'),
      equation(640, 245, 530, String.raw`\dot{\mathbf{x}}=\begin{pmatrix}-\alpha&-\omega\\\omega&-\alpha\end{pmatrix}\mathbf{x}`),
      p(640, 450, 530, 'Eigenvalues: −α ± iω', '', 'color: var(--accent)'),
      p(96, 515, 480, 'Assumptions: linear, autonomous, deterministic.', 'caption'),
    ], 'Define the state variables. This system is exactly solvable; a linearization of a nonlinear model needs a local validity check.'));
    pages.push(section(3, '02 / Phase space', 'Different initial states converge to the same point', [
      chart('phase', 96, 220, 720, 400),
      p(870, 265, right - 870, 'Positive damping makes the origin stable.'),
      p(870, 410, right - 870, 'α = 1, ω = 17/3<br>0 ≤ t ≤ 3<br>Three initial phases', 'caption'),
    ], 'The curves are exact solutions, not fitted trajectories or recordings. Describe the inward spiral and the fixed point.'));
    pages.push(section(4, '03 / Interpretation', 'The real part of the eigenvalue decides stability', [
      heading(96, 250, 320, 'α &gt; 0'), p(96, 335, 320, 'Decay toward the fixed point. Perturbations shrink.'),
      heading(472, 250, 320, 'α = 0'), p(472, 335, 320, 'Neutral cycles. The initial amplitude persists.'),
      heading(848, 250, 320, 'α &lt; 0'), p(848, 335, 320, 'Growth away from the origin. The fixed point is unstable.'),
      rule(96, 505, wide), p(96, 545, wide, 'Local linear stability alone does not prove global nonlinear stability.', 'caption'),
    ], 'Compare signs of the real eigenvalue component. Do not extrapolate the local conclusion to a global nonlinear system.'));
    pages.push(section(5, '04 / Discussion', 'What changes beyond a linear model?', [
      p(96, 235, wide, 'How do nonlinear terms reshape the basin of attraction?'),
      p(96, 330, wide, 'Does stochastic forcing sustain fluctuations near the fixed point?'),
      p(96, 425, wide, 'Which observable would distinguish damping from dephasing?'),
      p(96, 560, wide, 'Reproduce: x₁ = exp(−t) cos(17t/3 + φ), x₂ = exp(−t) sin(17t/3 + φ); φ ∈ {0, 2.1, 4.2}.', 'caption'),
    ], 'Invite discussion around model assumptions. The explicit solution generates every curve in the phase portrait.'));
  } else if (serif) {
    pages.push(section(2, 'I / The question', 'Does a 70% forecast mean what it says?', [
      p(96, 260, wide, 'Across cases assigned probability 0.7, a calibrated forecast predicts an event frequency of 0.7.'),
      equation(96, 400, wide, String.raw`\mathbb{E}[Y\mid P=p]=p`),
      p(96, 600, wide, 'Calibration is a conditional agreement statement. It does not tell us whether individual cases can be distinguished.', 'caption'),
    ], 'Define P as the forecast and Y as the binary outcome. Calibration is a property of a collection of predictions.'));
    pages.push(section(3, 'II / The evidence', 'A reliability diagram reveals the mismatch', [
      chart('calibration', 96, 230, wide, 470),
      p(96, 720, wide, 'Illustrative analytical curves. Dashed: y = p. Solid: y = √p, an underconfident forecast. No empirical samples or confidence intervals are implied.', 'caption'),
    ], 'Read probability on the horizontal axis and event frequency on the vertical axis. Explain why the curve above the identity is underconfident.'));
    pages.push(section(4, 'III / A counterexample', 'Perfect calibration can carry little information', [
      p(96, 260, wide, 'Suppose the event rate is 20%. Predicting 0.2 for every case is calibrated in a population with that rate.'),
      equation(96, 425, wide, String.raw`P\equiv 0.2,\qquad \mathbb{E}[Y]=0.2`),
      p(96, 610, wide, 'The forecast cannot rank cases by risk. Evaluate resolution or discrimination alongside calibration.', '', 'color: var(--accent)'),
    ], 'Use the constant base-rate predictor to distinguish reliability from resolution.'));
    pages.push(section(5, 'IV / Reporting', 'Show reliability, sharpness and uncertainty', [
      p(96, 250, wide, '1. Show a reliability curve with bin counts and intervals.'),
      p(96, 335, wide, '2. Report a proper score and how it was evaluated.'),
      p(96, 420, wide, '3. Check shifts across populations and time.'),
      equation(96, 515, wide, String.raw`\mathrm{BS}=\frac{1}{N}\sum_{i=1}^{N}(p_i-y_i)^2`),
      p(96, 715, wide, calibrationReference, 'caption'),
    ], 'The Brier score is a proper scoring rule for binary outcomes. Replace these analytical examples with a held-out evaluation and uncertainty estimates.'));
  } else {
    pages.push(section(2, '01 / Question and model', 'How long does a spatial pattern survive?', [
      p(96, 230, 490, 'A field diffuses on a periodic one-dimensional domain. Follow one Fourier component at a time.'),
      equation(650, 245, 520, String.raw`\partial_t u=D\,\partial_{xx}u`),
      equation(650, 415, 520, String.raw`A_k(t)=A_k(0)e^{-Dk^2t}`),
      p(96, 495, 490, 'Constant D · no sources · no advection', 'caption'),
    ], 'Substitute one Fourier mode into the heat equation. The example is analytical rather than experimental.'));
    pages.push(section(3, '02 / Result', 'Double the frequency. Four times faster decay.', [
      chart('decay', 96, 215, 720, 415),
      equation(850, 265, 335, String.raw`\tau_k=\frac{1}{Dk^2}`),
      p(850, 425, 335, 'Small-scale structure disappears first.', '', 'color: var(--accent)'),
    ], 'The curves show exp(−s) and exp(−4s), with s = t/τ₁. Both modes start at unit amplitude.'));
    pages.push(section(4, '03 / Scope', 'The conclusion depends on the model assumptions', [
      heading(96, 245, 490, 'What follows'),
      p(96, 325, 490, 'For constant diffusivity, the mode lifetime falls as the inverse square of spatial frequency.'),
      heading(690, 245, 490, 'What to check'),
      p(690, 325, 490, 'Boundary conditions, spatially varying diffusivity and nonlinear coupling may change the mode dynamics.'),
      rule(96, 540, wide),
      p(96, 575, wide, 'In measured data, estimate lifetimes with uncertainty and inspect residuals.', 'caption'),
    ], 'Separate the exact mathematical statement from its application to a real system.'));
    pages.push(section(5, '04 / Takeaway and reproducibility', 'Spatial scale predicts the lifetime of a pattern', [
      p(96, 240, wide, 'Higher-frequency modes decay sooner under diffusion.'),
      p(96, 330, wide, 'The prediction is quantitative: τ₂ = τ₁ / 4 when k₂ = 2k₁.'),
      p(96, 445, wide, 'Reproduce the plot: evaluate exp(−s) and exp(−4s) at 101 equally spaced values of s from 0 to 3.', 'caption'),
      p(96, 555, wide, diffusionReference, 'caption'),
    ], 'Close with the single result. The plot has no fitted parameters; all functions and the sampling grid are given on the slide.'));
  }
  return document(t, title || t.exampleTitle, pages);
}

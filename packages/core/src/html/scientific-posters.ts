/** MIT BE Communication Lab's CC0 EvenBetterPoster templates, measured in source-file inches.
 * PowerPoint: 48x36 landscape and 36x48 portrait; Illustrator: 48x36 landscape sketch.
 * https://github.com/MIT-BECL/Poster_Resources (License-Templates: CC0-1.0).
 * The source's bands and panels are kept; their colours are set for contrast (dark text on light
 * bands, white on the coloured sidebar). Placeholder text/artwork is replaced by clearly labelled
 * analytical examples; no MIT identity.
 */
import type { ScientificTemplate } from './scientific.ts';
import type { Chart, ChartType } from './scientific-charts.ts';

const px = (n: number) => +(n * 96).toFixed(3);
const text = (x: number, y: number, w: number, value: string, size = 60, extra = '', tag = 'p') =>
  `<${tag} style="position: absolute; left: ${px(x)}px; top: ${px(y)}px; width: ${px(w)}px; font-size: ${size * 4 / 3}px; line-height: 1.15; font-weight: 400${extra ? '; ' + extra : ''}">${value}</${tag}>`;
const rect = (x: number, y: number, w: number, h: number, fill: string, extra = '') =>
  `<div class="decoration" style="position: absolute; left: ${px(x)}px; top: ${px(y)}px; width: ${px(w)}px; height: ${px(h)}px; background: ${fill}${extra ? '; ' + extra : ''}"></div>`;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** a small uppercase label above a block */
const label = (x: number, y: number, w: number, value: string, colour: string) => text(x, y, w, value, 30, `color: ${colour}; font-weight: 700; letter-spacing: .12em; text-transform: uppercase`);
/** where a logo or a QR code goes: an outline the author replaces */
const placeholder = (x: number, y: number, w: number, h: number, value: string, colour = '#66706a') =>
  rect(x, y, w, h, 'transparent', `border: 4px dashed ${colour}; border-radius: 12px`) + text(x, y + h / 2 - .3, w, value, 32, `color: ${colour}; text-align: center`);

/** An editable vector graphical abstract: analytical spatial profiles at three times. */
function profiles(x: number, y: number, w: number, h: number, horizontal = false, type = 'decay', tile = '#ffffff', ink = '#317f59'): string {
  const panels = [0, 0.25, 1].map((time, i) => {
    const xx = horizontal ? i * 210 : 0, yy = horizontal ? 0 : i * 210;
    const points = Array.from({ length: 81 }, (_, j) => {
      const u = j / 80, a = Math.exp(-time), b = .45 * Math.exp(-4 * time);
      if (type === 'phase') return `${(xx + 100 + 72 * Math.exp(-3 * u) * Math.cos(17 * u + i)).toFixed(2)},${(yy + 76 - 56 * Math.exp(-3 * u) * Math.sin(17 * u + i)).toFixed(2)}`;
      if (type === 'calibration') {
        const power = [2, 1.5, 1][i], a = u ** power, b = (1 - u) ** power;
        return `${(xx + 15 + 170 * u).toFixed(2)},${(yy + 130 - 105 * a / (a + b)).toFixed(2)}`;
      }
      return `${(xx + 15 + u * 170).toFixed(2)},${(yy + 82 - 46 * (a * Math.cos(u * Math.PI * 2) + b * Math.cos(u * Math.PI * 4))).toFixed(2)}`;
    }).join(' ');
    const label = type === 'phase' ? `Initial phase ${i + 1}` : type === 'calibration' ? ['Underconfident', 'Intermediate', 'Calibrated'][i] : `t / τ₁ = ${time}`;
    return `<rect x="${xx}" y="${yy}" width="200" height="180" rx="10" fill="${tile}"/><line x1="${xx + 15}" x2="${xx + 185}" y1="${yy + (type === 'calibration' ? 130 : 82)}" y2="${yy + (type === 'calibration' ? 130 : 82)}" stroke="${ink}" stroke-opacity=".25"/><polyline points="${points}" fill="none" stroke="${ink}" stroke-width="4" stroke-linecap="round"/><text x="${xx + 15}" y="${yy + 164}" font-size="17" fill="${ink}">${label}</text>`;
  }).join('');
  const label = type === 'phase' ? 'Analytical damped trajectories from three initial phases' : type === 'calibration' ? 'Analytical reliability curves from underconfident to calibrated' : 'Analytical diffusion profiles at three dimensionless times';
  return `<svg role="img" aria-label="${label}" viewBox="0 0 ${horizontal ? 620 : 200} ${horizontal ? 180 : 620}" style="position: absolute; left: ${px(x)}px; top: ${px(y)}px; width: ${px(w)}px; height: ${px(h)}px">${panels}</svg>`;
}

/** a panel's number: a solid numeral in the accent colour */
function mark(x: number, y: number, n: number, colour: string): string {
  return text(x, y, 1, String(n), 64, `color: ${colour}; font-weight: 700; line-height: 1`);
}

export function mitPosterObjects(t: ScientificTemplate, title: string, chart: Chart): string[] {
  const portrait = t.id === 'research-portrait';
  const sketch = t.id === 'figure-first';
  const name = esc(title || t.exampleTitle);
  const green = t.accent, band = '#f1f3f2', ink = t.ink;
  // the sidebar (title band in the portrait): the lab's green; the sketch's charcoal with green tiles
  const side = sketch ? '#28302c' : green;
  const objects: string[] = [];
  const fig = (type: ChartType, x: number, y: number, w: number, h: number) => chart(type, px(x), px(y), px(w), px(h), { text: 34 });
  if (portrait) {
    // The master bands of evenbetterposter_template_36x48_vertical.pptx.
    objects.push(rect(0, 0, 36, 14, side), rect(0, 14, 36, 6, band), rect(0, 42, 36, 6, band));
    objects.push(text(1, 1, 26, name, 100, 'color: #ffffff; font-weight: 700; line-height: 1.05', 'h1'), text(1, 4.9, 26, 'Your Name · Institution', 56, 'color: #ffffff; opacity: .85'));
    objects.push(label(1, 7.35, 20, 'Graphical abstract', '#ffffff'));
    objects.push(profiles(1, 8.2, 34, 4.9, true, 'calibration', '#ffffff', green));
    objects.push(placeholder(31.2, 1, 3.8, 3.8, 'QR code', '#ffffff'));
    objects.push(text(1, 15.7, 16, 'Check the whole curve, not a single score', 80, `color: ${ink}; font-weight: 700; line-height: 1.08`, 'h2'));
    objects.push(rect(18.25, 15, .04, 4, '#b9c2bd'));
    objects.push(text(19.25, 15.05, 15.75, '• Show reliability<br>• Report uncertainty<br>• Assess discrimination', 60, 'line-height: 1.5'));
    const titles = ['A curve can expose miscalibration', 'A proper score uses every forecast', 'Calibration does not imply resolution', 'Counts make uncertainty visible'];
    const xy = [[2.25, 21.2], [19.25, 21.2], [2.25, 31.6], [19.25, 31.6]];
    for (let i = 0; i < 4; i++) {
      const [x, y] = xy[i]; objects.push(mark(x - 1.25, y - .12, i + 1, green), text(x, y, 14.75, titles[i], 56, 'font-weight: 700', 'h3'));
      if (i === 0) objects.push(fig('calibration', x, y + 1.5, 14.75, 8));
      else if (i === 2) objects.push(fig('sharpness', x, y + 1.5, 14.75, 8));
      else if (i === 1) objects.push(text(x, y + 3, 14.75, String.raw`\[\mathrm{BS}=\frac1N\sum_i(p_i-y_i)^2\]`, 54), text(x, y + 6.2, 14.75, 'A proper score rewards honest probabilities. Combine it with reliability and discrimination.', 40, `color: ${t.muted}; line-height: 1.3`));
      else objects.push(text(x, y + 2.2, 14.75, 'With measured data, add bin counts and uncertainty intervals to every point of the curve.', 44, 'line-height: 1.3'), text(x, y + 5.6, 14.75, 'The curves on this poster are analytical illustrations, not measurements.', 36, `color: ${t.muted}; line-height: 1.3`));
    }
    objects.push(label(1, 42.7, 11, 'Abstract', green));
    objects.push(text(1, 43.55, 11.75, 'Calibration tests agreement between predicted probabilities and event frequencies. A calibrated forecast can still fail to distinguish individual cases.', 32, 'line-height: 1.3'));
    objects.push(placeholder(13.5, 43.2, 3.4, 3.4, 'Logo'), placeholder(17.4, 43.2, 3.4, 3.4, 'Logo'));
    objects.push(label(22.25, 42.7, 12.75, 'References', green));
    objects.push(text(22.25, 43.55, 12.75, 'G. W. Brier (1950). Verification of forecasts expressed in terms of probability.<br>Analytical teaching example; layout after the <a href="https://mit-becl.github.io/Poster_Resources/">MIT EvenBetterPoster</a> (CC0).', 28, `color: ${t.muted}; line-height: 1.35`));
  } else {
    // Both landscape originals have a 16-inch sidebar, 9-inch header and 6-inch footer.
    objects.push(rect(0, 0, 16, 36, side), rect(16, 0, 32, 9, band), rect(16, 30, 32, 6, band));
    objects.push(text(.75, .75, 14.5, name, 92, 'color: #ffffff; font-weight: 700; line-height: 1.05', 'h1'), text(.75, 5.7, 14.5, 'Your Name · Institution', 54, 'color: #ffffff; opacity: .85'));
    objects.push(label(.75, 8.6, 14.5, 'Graphical abstract', '#ffffff'));
    objects.push(profiles(4.25, 9.6, 7.5, 16.5, false, sketch ? 'phase' : 'decay', sketch ? green : '#ffffff', sketch ? '#ffffff' : green));
    objects.push(label(.75, 27.9, 14.5, 'Abstract', '#ffffff'));
    objects.push(text(.75, 28.75, 14.5, sketch ? 'A damped linear model separates oscillation from stability. The real part of each eigenvalue determines whether perturbations shrink or grow.' : 'For constant diffusivity on a periodic domain, each Fourier mode decays independently. Its lifetime is inversely proportional to the square of its spatial frequency.', 36, 'color: #ffffff; line-height: 1.3'));
    objects.push(text(17, 2.6, 14.5, sketch ? 'Damping, not rotation, decides stability' : 'Fine scales fade first: twice the frequency, a quarter of the lifetime', 72, `color: ${ink}; font-weight: 700; line-height: 1.08`, 'h2'));
    objects.push(rect(32.25, 1.5, .04, 6, '#b9c2bd'));
    objects.push(text(33.25, 1.85, 14, sketch ? '• Damping and rotation<br>• Inspect phase space<br>• Check assumptions' : '• Double the frequency<br>• Four times faster decay<br>• Check assumptions', 60, 'line-height: 1.5'));
    const captions = sketch ? ['Trajectories approach a fixed point', 'Damping sets the envelope', 'One coordinate rings down inside it', 'Eigenvalues determine stability'] : ['High frequencies decay first', 'Mode lifetime scales as k⁻²', 'Fine structure smooths away', 'State the assumptions'];
    const xy = [[17.5, 10.1], [33.25, 10.1], [17.5, 20.25], [33.25, 20.25]];
    for (let i = 0; i < 4; i++) {
      const [x, y] = xy[i]; objects.push(mark(x - 1.25, y - .12, i + 1, green), text(x, y, 13.75, captions[i], 52, 'font-weight: 700', 'h3'));
      if (i === 0) objects.push(fig(sketch ? 'phase' : 'decay', x, y + 1.3, 13.75, 7.9));
      else if (i === 2) objects.push(fig(sketch ? 'envelope' : 'profiles', x, y + 1.3, 13.75, 7.9));
      else if (i === 1) {
        objects.push(text(x, y + 2.7, 13.75, sketch ? String.raw`\[\|\mathbf{x}(t)\|=e^{-\alpha t}\|\mathbf{x}(0)\|\]` : String.raw`\[\tau_k=\frac{1}{Dk^2}\]`, 60));
        objects.push(text(x, y + 6.1, 13.75, sketch ? 'Exact linear solution for α > 0: the norm shrinks at the rate α, whatever the rotation ω.' : 'Exact periodic heat-equation solution: doubling k shortens the lifetime fourfold.', 38, `color: ${t.muted}; line-height: 1.3`));
      } else objects.push(text(x, y + 2.2, 13.75, sketch ? 'Linear, autonomous and deterministic.' : 'Constant diffusivity. Periodic boundaries. No forcing or advection.', 44, 'line-height: 1.3'), text(x, y + 4.9, 13.75, sketch ? 'Local stability does not establish global nonlinear stability.' : 'Measured data need lifetimes with uncertainty estimates.', 38, `color: ${t.muted}; line-height: 1.3`));
    }
    objects.push(placeholder(17.5, 31.1, 3.8, 3.8, 'Logo'), placeholder(22.1, 31.1, 3.8, 3.8, 'Logo'), placeholder(26.7, 31.1, 3.8, 3.8, 'QR code'));
    objects.push(label(32.25, 31.1, 14.75, 'References', green));
    objects.push(text(32.25, 32, 14.75, 'Analytical teaching example. Replace with your study’s sources.<br>Layout after the <a href="https://mit-becl.github.io/Poster_Resources/">MIT EvenBetterPoster</a> (CC0).', 32, `color: ${t.muted}; line-height: 1.35`));
  }
  return objects;
}

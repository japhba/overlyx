/** MIT BE Communication Lab's CC0 EvenBetterPoster templates, measured in source-file inches.
 * PowerPoint: 48x36 landscape and 36x48 portrait; Illustrator: 48x36 landscape sketch.
 * https://github.com/MIT-BECL/Poster_Resources (License-Templates: CC0-1.0).
 * Placeholder text/artwork is replaced by clearly labelled analytical examples; no MIT identity.
 */
import type { ScientificTemplate } from './scientific.ts';

type Chart = (type: 'decay' | 'phase' | 'calibration', x: number, y: number, w: number, h: number) => string;
const px = (n: number) => +(n * 96).toFixed(3);
const text = (x: number, y: number, w: number, value: string, size = 60, extra = '', tag = 'p') =>
  `<${tag} style="position: absolute; left: ${px(x)}px; top: ${px(y)}px; width: ${px(w)}px; font-size: ${size * 4 / 3}px; line-height: 1.15; font-weight: 400${extra ? '; ' + extra : ''}">${value}</${tag}>`;
const rect = (x: number, y: number, w: number, h: number, fill: string, extra = '') =>
  `<div class="decoration" style="position: absolute; left: ${px(x)}px; top: ${px(y)}px; width: ${px(w)}px; height: ${px(h)}px; background: ${fill}${extra ? '; ' + extra : ''}"></div>`;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** An editable vector graphical abstract: analytical spatial profiles at three times. */
function profiles(x: number, y: number, w: number, h: number, horizontal = false, type = 'decay'): string {
  const panels = [0, 0.25, 1].map((time, i) => {
    const xx = horizontal ? i * 205 : 0, yy = horizontal ? 0 : i * 205;
    const points = Array.from({ length: 81 }, (_, j) => {
      const u = j / 80, a = Math.exp(-time), b = .45 * Math.exp(-4 * time);
      if (type === 'phase') return `${(xx + 100 + 72 * Math.exp(-3 * u) * Math.cos(17 * u + i)).toFixed(2)},${(yy + 80 - 60 * Math.exp(-3 * u) * Math.sin(17 * u + i)).toFixed(2)}`;
      if (type === 'calibration') {
        const power = [2, 1.5, 1][i], a = u ** power, b = (1 - u) ** power;
        return `${(xx + 15 + 175 * u).toFixed(2)},${(yy + 125 - 100 * a / (a + b)).toFixed(2)}`;
      }
      return `${(xx + 15 + u * 175).toFixed(2)},${(yy + 94 - 48 * (a * Math.cos(u * Math.PI * 2) + b * Math.cos(u * Math.PI * 4))).toFixed(2)}`;
    }).join(' ');
    const label = type === 'phase' ? `Initial phase ${i + 1}` : type === 'calibration' ? ['Underconfident', 'Intermediate', 'Calibrated'][i] : `t / τ₁ = ${time}`;
    return `<rect x="${xx}" y="${yy}" width="200" height="170" fill="#317f59"/><line x1="${xx + 15}" x2="${xx + 190}" y1="${yy + 94}" y2="${yy + 94}" stroke="#b5d7c1"/><polyline points="${points}" fill="none" stroke="white" stroke-width="3"/><text x="${xx + 15}" y="${yy + 155}" font-size="17" font-family="Carlito, sans-serif" fill="white">${label}</text>`;
  }).join('');
  const label = type === 'phase' ? 'Analytical damped trajectories from three initial phases' : type === 'calibration' ? 'Analytical reliability curves from underconfident to calibrated' : 'Analytical diffusion profiles at three dimensionless times';
  return `<svg role="img" aria-label="${label}" viewBox="0 0 ${horizontal ? 615 : 200} ${horizontal ? 170 : 615}" style="position: absolute; left: ${px(x)}px; top: ${px(y)}px; width: ${px(w)}px; height: ${px(h)}px">${panels}</svg>`;
}

function mark(x: number, y: number, n: number): string {
  return text(x, y, 1.2, String(n), 120, 'color: #f2f2f2; -webkit-text-stroke: 1px #bfbfbf; font-weight: 700');
}

export function mitPosterObjects(t: ScientificTemplate, title: string, chart: Chart): string[] {
  const portrait = t.id === 'research-portrait';
  const sketch = t.id === 'figure-first';
  const name = esc(title || t.exampleTitle);
  const objects: string[] = [];
  const fig = (type: Parameters<Chart>[0], x: number, y: number, w: number, h: number) => chart(type, px(x), px(y), px(w), px(h));
  if (portrait) {
    // Exact master bands of evenbetterposter_template_36x48_vertical.pptx.
    objects.push(rect(0, 0, 36, 14, '#bfbfbf'), rect(0, 14, 36, 6, '#f2f2f2'), rect(0, 42, 36, 6, '#f2f2f2'));
    objects.push(text(1, 1, 23.14, name, 95, '', 'h1'), text(1, 5.25, 22.158, 'Your Name · Institution', 80));
    objects.push(text(1, 7.5, 32, 'Graphical Abstract', 72, 'color: #ffffff'));
    objects.push(profiles(2.5, 8.97, 31, 4, true, 'calibration'));
    objects.push(text(1, 16.14, 16, 'Check the whole curve', 80, '', 'h2'));
    objects.push(rect(18, 15, .025, 4, '#a6a6a6'));
    objects.push(text(20, 14.72, 15, '• Show reliability<br>• Report uncertainty<br>• Assess discrimination', 80, 'line-height: 1.65'));
    const titles = ['A curve can expose miscalibration', 'A proper score uses every forecast', 'Calibration does not imply resolution', 'Counts make uncertainty visible'];
    const xy = [[1.75, 21.22], [19.036, 21.22], [1.75, 31.75], [19.036, 31.75]];
    for (let i = 0; i < 4; i++) {
      const [x, y] = xy[i]; objects.push(mark(x - .9, y - .6, i + 1), text(x, y, 15, titles[i], 60));
      if (i === 0 || i === 2) objects.push(fig('calibration', x, y + 2.05, 15, 7.27));
      else if (i === 1) objects.push(text(x + .5, y + 3.5, 14, String.raw`\[\mathrm{BS}=\frac1N\sum_i(p_i-y_i)^2\]`, 48), text(x + .5, y + 7, 14, 'Combine a proper score with reliability and discrimination.', 32));
      else objects.push(text(x + .5, y + 3.5, 14, 'With measured data, add bin counts and uncertainty intervals. These curves are analytical illustrations.', 40));
    }
    objects.push(text(1, 42.6, 11, 'Abstract', 72, 'color: #a6a6a6'));
    objects.push(text(1, 44.13, 11.25, 'Calibration tests agreement between predicted probabilities and event frequencies. A calibrated forecast can still fail to distinguish individual cases.', 34));
    objects.push(rect(12.75, 43.468, 3, 3, '#317f59'), rect(16.5, 43.468, 3, 3, '#317f59'), rect(20.25, 43.468, 3, 3, '#317f59'));
    objects.push(text(12.95, 44.3, 2.6, 'Logo 1', 32, 'color: white; text-align: center'), text(16.7, 44, 2.6, 'Contact<br>details', 28, 'color: white; text-align: center'), text(20.45, 44.3, 2.6, 'Logo 2', 32, 'color: white; text-align: center'));
    objects.push(text(24.125, 43.055, 10.875, 'References / acknowledgements<br><br>G. W. Brier (1950)<br>Analytical teaching example', 32));
  } else {
    // Both landscape originals have a 16-inch sidebar, 9-inch header and 6-inch footer.
    objects.push(rect(0, 0, 16, 36, sketch ? '#b3b3b3' : '#bfbfbf'), rect(16, 0, 32, 9, '#f2f2f2'), rect(16, 30, 32, 6, '#f2f2f2'));
    objects.push(text(.5, .5, 15, name, 95, '', 'h1'), text(.5, 5.64, 15, 'Your Name · Institution', 80));
    objects.push(text(.5, 9, 15, 'Graphical Abstract', 72, 'color: #ffffff'));
    objects.push(profiles(sketch ? 4.5 : 2.2, sketch ? 12.3 : 11, sketch ? 7 : 11.1, sketch ? 15.2 : 15, false, sketch ? 'phase' : 'decay'));
    objects.push(text(.5, 29.39, 15, 'Abstract', 72, 'color: #ffffff'));
    objects.push(text(.5, 30.7, 15, sketch ? 'A damped linear model separates oscillation from stability. The real part of each eigenvalue determines whether perturbations shrink or grow.' : 'For constant diffusivity on a periodic domain, each Fourier mode decays independently. Its lifetime is inversely proportional to the square of its spatial frequency.', 38));
    objects.push(text(17, 3.78, 14, sketch ? 'Damping stabilizes motion' : 'Fine scales fade first', 80, '', 'h2'));
    objects.push(rect(32, 1.5, .025, 6, '#a6a6a6'));
    objects.push(text(33, 1.08, 14, sketch ? '• Damping and rotation<br>• Inspect phase space<br>• Check assumptions' : '• Double the frequency<br>• Four times faster decay<br>• Check assumptions', 80, 'line-height: 1.65'));
    const captions = sketch ? ['Trajectories approach a fixed point', 'Damping sets the envelope', 'The model is locally linear', 'Eigenvalues determine stability'] : ['High frequencies decay first', 'Mode lifetime scales as k⁻²', 'Fine structure smooths away', 'State the assumptions'];
    const xy = [[17, 10], [33, 10], [17, 20.5], [33, 20.5]];
    for (let i = 0; i < 4; i++) {
      const [x, y] = xy[i]; objects.push(mark(x - .9, y - 1, i + 1), text(x, y, 14, captions[i], 60));
      if (i === 0 || i === 2) objects.push(fig(sketch ? 'phase' : 'decay', x, y + 2.067, 14, 6.533));
      else if (i === 1) {
        objects.push(text(x, y + 3, 14, sketch ? String.raw`\[\|\mathbf{x}(t)\|=e^{-\alpha t}\|\mathbf{x}(0)\|\]` : String.raw`\[\tau_k=\frac{1}{Dk^2}\]`, 56));
        objects.push(text(x + .25, y + 6.25, 13.5, sketch ? 'Exact linear solution, α > 0.' : 'Exact periodic heat-equation solution.', 32));
      } else objects.push(text(x + .25, y + 2.8, 13.5, sketch ? 'Linear, autonomous and deterministic. Local stability does not establish global nonlinear stability.' : 'Constant diffusivity. Periodic boundaries. No forcing or advection. Measured data need uncertainty estimates.', 42));
    }
    objects.push(rect(17, 31, 4, 4, '#317f59'), rect(22, 31, 4, 4, '#317f59'), rect(27, 31, 4, 4, '#317f59'));
    objects.push(text(17.2, 32.3, 3.6, 'Logo 1', 40, 'color: white; text-align: center'), text(22.2, 31.9, 3.6, 'Contact<br>details', 36, 'color: white; text-align: center'), text(27.2, 32.3, 3.6, 'Logo 2', 40, 'color: white; text-align: center'));
    objects.push(text(32.5, 31.7, 15, 'References / acknowledgements<br><br>Analytical teaching example.<br>Replace with your study’s sources.', 38));
  }
  // The source QR placeholder is an actual, editable link block rather than a fake scannable code.
  objects.push(rect(portrait ? 32 : 12.5, portrait ? 1 : 27, 3, 3, '#317f59'));
  objects.push(text(portrait ? 32.15 : 12.65, portrait ? 1.6 : 27.6, 2.7, '<a href="https://mit-becl.github.io/Poster_Resources/">Poster<br>source</a>', 30, 'color: white; text-align: center'));
  return objects;
}

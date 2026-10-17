/**
 * The templates' example figures: small analytical plots drawn as editable inline SVG.
 * Each figure fills the box it is given (its viewBox follows the box's aspect) and sets its
 * labels in the page's own typeface, at a size that stays legible whatever the box's size.
 * Every curve is an exact function stated in the figure's aria-label; none is data.
 */
export type ChartType = 'decay' | 'phase' | 'calibration' | 'lifetime' | 'profiles' | 'ratio' | 'envelope' | 'sharpness' | 'spectrum' | 'kernel' | 'msd' | 'variance';
export type Chart = (type: ChartType, x: number, y: number, w: number, h: number, opts?: ChartOptions) => string;
export interface ChartOptions {
  /** the labels' size on the page, px (within what keeps the plot readable: 12–30 units of the 600-unit viewBox) */
  text?: number;
}

interface Axis { min: number; max: number; ticks: [number, string][]; title: string; log?: boolean }
interface Series { pts: [number, number][]; colour: string; dash?: string; width?: number; label?: string; dots?: boolean; /** shown as a filled square in the legend (bars) */ box?: boolean }
interface Bar { x: number; w: number; v: number; colour: string; opacity?: number }

const f = (n: number) => +n.toFixed(2);
const sample = (n: number, fn: (t: number) => [number, number]) => Array.from({ length: n + 1 }, (_, i) => fn(i / n));

function plot(W: number, H: number, fs: number, ax: { x: Axis; y: Axis; cross?: boolean }, series: Series[], o: { bars?: Bar[]; legend?: 'tl' | 'tc' | 'tr'; extra?: (px: (x: number, y: number) => [number, number]) => string } = {}): string {
  const left = ax.cross ? fs * 1.2 : fs * 3.1, right = W - fs * 1.1, top = fs * 2.2, bottom = H - fs * (ax.cross ? 2.4 : 3.3);
  const tx = (v: number) => ax.x.log ? Math.log(v) : v, ty = (v: number) => ax.y.log ? Math.log(v) : v;
  const px = (x: number, y: number): [number, number] => [
    left + (tx(x) - tx(ax.x.min)) / (tx(ax.x.max) - tx(ax.x.min)) * (right - left),
    bottom - (ty(y) - ty(ax.y.min)) / (ty(ax.y.max) - ty(ax.y.min)) * (bottom - top),
  ];
  const label = (x: number, y: number, s: string, anchor = 'start', extra = '') => `<text x="${f(x)}" y="${f(y)}" text-anchor="${anchor}" font-size="${f(fs)}" fill="currentColor"${extra}>${s}</text>`;
  let s = '';
  if (ax.cross) {
    const [ox, oy] = px(0, 0);
    s += `<line x1="${f(left)}" x2="${f(right)}" y1="${f(oy)}" y2="${f(oy)}" stroke="currentColor" stroke-opacity=".35"/>`;
    s += `<line x1="${f(ox)}" x2="${f(ox)}" y1="${f(top)}" y2="${f(bottom)}" stroke="currentColor" stroke-opacity=".35"/>`;
    s += label(right, oy + fs * 1.3, ax.x.title, 'end') + label(ox + fs * .5, top + fs * .2, ax.y.title);
  } else {
    for (const [v, t] of ax.y.ticks) {
      const [, yy] = px(ax.x.min, v);
      s += `<line x1="${f(left)}" x2="${f(right)}" y1="${f(yy)}" y2="${f(yy)}" stroke="currentColor" stroke-opacity=".12"/>`;
      s += label(left - fs * .5, yy + fs * .35, t, 'end', ' fill-opacity=".75"');
    }
    for (const [v, t] of ax.x.ticks) {
      const [xx] = px(v, ax.y.min);
      s += `<line x1="${f(xx)}" x2="${f(xx)}" y1="${f(bottom)}" y2="${f(bottom + fs * .35)}" stroke="currentColor" stroke-opacity=".5"/>`;
      s += label(xx, bottom + fs * 1.45, t, 'middle', ' fill-opacity=".75"');
    }
    s += `<line x1="${f(left)}" x2="${f(right)}" y1="${f(bottom)}" y2="${f(bottom)}" stroke="currentColor" stroke-opacity=".5"/>`;
    s += label((left + right) / 2, H - fs * .45, ax.x.title, 'middle');
    s += label(left - fs * 2.6, top - fs * .9, ax.y.title);
  }
  for (const b of o.bars ?? []) {
    const [x0, y0] = px(b.x - b.w / 2, b.v), [x1, y1] = px(b.x + b.w / 2, ax.y.min);
    s += `<rect x="${f(x0)}" y="${f(y0)}" width="${f(x1 - x0)}" height="${f(y1 - y0)}" fill="${b.colour}"${b.opacity ? ` fill-opacity="${b.opacity}"` : ''}/>`;
  }
  const sw = Math.max(2.5, fs * .17);
  for (const se of series) {
    const pts = se.pts.map(([x, y]) => px(x, y).map(f).join(',')).join(' ');
    s += `<polyline points="${pts}" fill="none" stroke="${se.colour}" stroke-width="${f((se.width ?? 1) * sw)}" stroke-linecap="round" stroke-linejoin="round"${se.dash ? ` stroke-dasharray="${se.dash.split(' ').map(d => f(Number(d) * sw / 3)).join(' ')}"` : ''}/>`;
    if (se.dots) for (const [x, y] of se.pts) { const [a, b] = px(x, y); s += `<circle cx="${f(a)}" cy="${f(b)}" r="${f(sw * 1.9)}" fill="${se.colour}"/>`; }
  }
  if (o.extra) s += o.extra(px);
  const legend = series.filter(se => se.label);
  if (legend.length) {
    const lw = fs * 1.9, width = Math.max(...legend.map(se => se.label!.length)) * fs * .52 + lw + fs * .6;
    const lx = o.legend === 'tl' ? left + fs * .8 : o.legend === 'tc' ? (left + right - width) / 2 : right - width;
    legend.forEach((se, i) => {
      const ly = top + fs * (.4 + 1.35 * i);
      s += se.box ? `<rect x="${f(lx + lw - fs * .8)}" y="${f(ly - fs * .4)}" width="${f(fs * .8)}" height="${f(fs * .8)}" fill="${se.colour}"/>`
        : `<line x1="${f(lx)}" x2="${f(lx + lw)}" y1="${f(ly)}" y2="${f(ly)}" stroke="${se.colour}" stroke-width="${f((se.width ?? 1) * sw)}" stroke-linecap="round"${se.dash ? ` stroke-dasharray="${se.dash.split(' ').map(d => f(Number(d) * sw / 3)).join(' ')}"` : ''}/>`;
      s += label(lx + lw + fs * .5, ly + fs * .35, se.label!);
    });
  }
  return s;
}

const CAPTIONS: Record<ChartType, string> = {
  decay: 'Analytical diffusion: normalized amplitude against dimensionless time. The second spatial mode decays four times faster.',
  phase: 'Analytical phase portrait for a damped two-dimensional linear system, with three trajectories converging to the origin.',
  calibration: 'Analytical reliability diagram: the identity line is perfectly calibrated; an odds-squared curve depicts underconfident forecasts.',
  lifetime: 'Analytical mode lifetimes on logarithmic axes: the lifetime falls as the inverse square of spatial frequency (slope −2).',
  profiles: 'Analytical diffusion profiles u(x, t) = e^(−t) cos x + 0.45 e^(−4t) cos 2x at three dimensionless times.',
  ratio: 'Analytical amplitude ratio of the second to the first mode on a logarithmic axis: a straight line of slope −3.',
  envelope: 'Analytical damped oscillation x₁(t) = e^(−t) cos(17t/3) inside its envelope ±e^(−t).',
  spectrum: 'Analytical mode amplitudes aₖ(0) = 1/k and aₖ(t) = e^(−k²t/τ₁)/k at t = τ₁/4: diffusion empties the high frequencies first.',
  sharpness: 'Analytical forecast distributions of two calibrated forecasters: a constant base rate and a sharp, discriminating forecast.',
  kernel: 'Analytical heat kernel G(x, t) = e^(−x²/4Dt) / √(4πDt) at t = 0.25, 1 and 4 (D = 1): a point source spreads as √t.',
  msd: 'Analytical mean squared displacement ⟨x²⟩ = 2Dt for D = 0.5, 1 and 2: straight lines whose slope is 2D.',
  variance: 'Analytical total variance Σ aₖ² e^(−2k²t/τ₁) with aₖ = 1/k (k = 1…20), normalized, against the slowest mode alone e^(−2t/τ₁) / Σ aₖ².',
};

/** An example figure as an absolutely positioned inline SVG the size of its box (px). */
export function chart(type: ChartType, x: number, y: number, w: number, h: number, opts: ChartOptions = {}): string {
  const W = 600, H = Math.round(Math.max(.2, Math.min(3, h / w)) * W);
  const fs = f(Math.max(12, Math.min(30, (opts.text ?? 22) * W / w)));
  const accent = 'var(--accent)', second = 'var(--secondary)', muted = 'var(--muted)';
  const unit: Axis = { min: 0, max: 1, ticks: [[0, '0'], [.5, '0.5'], [1, '1']], title: '' };
  let content: string;
  if (type === 'decay') {
    content = plot(W, H, fs, { x: { min: 0, max: 3, ticks: [[0, '0'], [1, '1'], [2, '2'], [3, '3']], title: 'Time  t / τ₁' }, y: { ...unit, title: 'Normalized amplitude' } }, [
      { pts: sample(100, t => [3 * t, Math.exp(-3 * t)]), colour: accent, label: 'mode k' },
      { pts: sample(100, t => [3 * t, Math.exp(-12 * t)]), colour: second, dash: '8 6', label: 'mode 2k' },
    ]);
  } else if (type === 'phase') {
    const traj = (a: number) => sample(240, t => { const r = Math.exp(-3 * t); return [r * Math.cos(17 * t + a), r * Math.sin(17 * t + a)]; });
    content = plot(W, H, fs, { cross: true, x: { min: -1.08, max: 1.08, ticks: [], title: 'x₁' }, y: { min: -1.08, max: 1.08, ticks: [], title: 'x₂' } },
      [traj(0), traj(2.1), traj(4.2)].map((pts, i) => ({ pts, colour: [accent, second, muted][i], width: .8 })),
      { extra: px => { const [a, b] = px(0, 0); return `<circle cx="${f(a)}" cy="${f(b)}" r="${f(fs * .32)}" fill="currentColor"/>`; } });
  } else if (type === 'calibration') {
    content = plot(W, H, fs, { x: { ...unit, title: 'Predicted probability' }, y: { ...unit, title: 'Observed frequency' } }, [
      { pts: [[0, 0], [1, 1]], colour: muted, dash: '7 6', label: 'calibrated' },
      { pts: sample(100, t => [t, t * t / (t * t + (1 - t) * (1 - t))]), colour: accent, label: 'underconfident' },
    ], { legend: 'tl' });
  } else if (type === 'lifetime') {
    const ks = [1, 2, 4, 8];
    content = plot(W, H, fs, { x: { min: .8, max: 10, log: true, ticks: ks.map(k => [k, String(k)]), title: 'Spatial frequency  k / k₁' },
      y: { min: 1 / 100, max: 1.3, log: true, ticks: [[1, '1'], [1 / 4, '1/4'], [1 / 16, '1/16'], [1 / 64, '1/64']], title: 'Lifetime  τₖ / τ₁' } }, [
      { pts: sample(40, t => { const k = .8 * Math.pow(10 / .8, t); return [k, 1 / (k * k)]; }).filter(([, v]) => v >= 1 / 100), colour: muted, width: .7 },
      { pts: ks.map(k => [k, 1 / (k * k)] as [number, number]), colour: accent, width: 0, dots: true },
    ], { extra: px => { const [a, b] = px(3.2, 1 / 6); return `<text x="${f(a)}" y="${f(b)}" font-size="${fs}" fill="currentColor">slope −2</text>`; } });
  } else if (type === 'profiles') {
    const u = (x: number, t: number) => Math.exp(-t) * Math.cos(x) + .45 * Math.exp(-4 * t) * Math.cos(2 * x);
    content = plot(W, H, fs, { x: { min: 0, max: 2 * Math.PI, ticks: [[0, '0'], [Math.PI, 'π'], [2 * Math.PI, '2π']], title: 'Position  x' },
      y: { min: -1.1, max: 1.5, ticks: [[-1, '−1'], [0, '0'], [1, '1']], title: 'Profile  u(x, t)' } },
      [0, .25, 1].map((t, i) => ({ pts: sample(120, s => [2 * Math.PI * s, u(2 * Math.PI * s, t)]), colour: [muted, second, accent][i], dash: i === 0 ? '6 5' : undefined, label: `t / τ₁ = ${t}` })), { legend: 'tc' });
  } else if (type === 'ratio') {
    content = plot(W, H, fs, { x: { min: 0, max: 3, ticks: [[0, '0'], [1, '1'], [2, '2'], [3, '3']], title: 'Time  t / τ₁' },
      y: { min: 1e-4, max: 1.5, log: true, ticks: [[1, '1'], [1e-2, '10⁻²'], [1e-4, '10⁻⁴']], title: 'Amplitude ratio  a₂ₖ / aₖ' } },
      [{ pts: sample(60, t => [3 * t, Math.exp(-9 * t)]), colour: accent }],
      { extra: px => { const [a, b] = px(1.6, .03); return `<text x="${f(a)}" y="${f(b)}" font-size="${fs}" fill="currentColor">slope −3</text>`; } });
  } else if (type === 'envelope') {
    content = plot(W, H, fs, { x: { min: 0, max: 3, ticks: [[0, '0'], [1, '1'], [2, '2'], [3, '3']], title: 'Time  t' },
      y: { min: -1.1, max: 1.45, ticks: [[-1, '−1'], [0, '0'], [1, '1']], title: 'State  x₁(t)' } }, [
      { pts: sample(240, t => [3 * t, Math.exp(-3 * t) * Math.cos(17 * t)]), colour: accent, label: 'x₁(t)' },
      { pts: sample(60, t => [3 * t, Math.exp(-3 * t)]), colour: muted, dash: '7 6', label: 'envelope' },
      { pts: sample(60, t => [3 * t, -Math.exp(-3 * t)]), colour: muted, dash: '7 6' },
    ]);
  } else if (type === 'spectrum') {
    const ks = [1, 2, 3, 4, 5, 6];
    content = plot(W, H, fs, { x: { min: .4, max: 6.6, ticks: ks.map(k => [k, String(k)]), title: 'Mode  k / k₁' },
      y: { min: 0, max: 1.25, ticks: [[0, '0'], [.5, '0.5'], [1, '1']], title: 'Amplitude  |aₖ|' } },
      [{ pts: [], colour: muted, label: 't = 0', box: true }, { pts: [], colour: accent, label: 't = τ₁ / 4', box: true }],
      { bars: ks.flatMap(k => [{ x: k - .17, w: .3, v: 1 / k, colour: muted, opacity: .55 }, { x: k + .17, w: .3, v: Math.exp(-k * k / 4) / k, colour: accent }]) });
  } else if (type === 'kernel') {
    const g = (x: number, t: number) => Math.exp(-x * x / (4 * t)) / Math.sqrt(4 * Math.PI * t);
    content = plot(W, H, fs, { x: { min: -6, max: 6, ticks: [[-6, '−6'], [-3, '−3'], [0, '0'], [3, '3'], [6, '6']], title: 'Position  x' },
      y: { min: 0, max: .7, ticks: [[0, '0'], [.25, '0.25'], [.5, '0.5']], title: 'Density  G(x, t)' } },
      [.25, 1, 4].map((t, i) => ({ pts: sample(160, s => [-6 + 12 * s, g(-6 + 12 * s, t)]), colour: [accent, second, muted][i], dash: i === 2 ? '7 6' : undefined, label: `t = ${t}` })), { legend: 'tr' });
  } else if (type === 'msd') {
    content = plot(W, H, fs, { x: { min: 0, max: 3, ticks: [[0, '0'], [1, '1'], [2, '2'], [3, '3']], title: 'Time  t' },
      y: { min: 0, max: 13, ticks: [[0, '0'], [4, '4'], [8, '8'], [12, '12']], title: 'Mean squared displacement' } },
      [2, 1, .5].map((d, i) => ({ pts: [[0, 0], [3, 6 * d]] as [number, number][], colour: [accent, second, muted][i], dash: i === 2 ? '7 6' : undefined, label: `D = ${d}` })), { legend: 'tl' });
  } else if (type === 'variance') {
    const ks = Array.from({ length: 20 }, (_, i) => i + 1), v0 = ks.reduce((a, k) => a + 1 / (k * k), 0);
    content = plot(W, H, fs, { x: { min: 0, max: 3, ticks: [[0, '0'], [1, '1'], [2, '2'], [3, '3']], title: 'Time  t / τ₁' },
      y: { min: 1e-3, max: 1.5, log: true, ticks: [[1, '1'], [1e-1, '10⁻¹'], [1e-2, '10⁻²'], [1e-3, '10⁻³']], title: 'Total variance  V(t) / V(0)' } }, [
      { pts: sample(120, s => [3 * s, ks.reduce((a, k) => a + Math.exp(-2 * k * k * 3 * s) / (k * k), 0) / v0]), colour: accent, label: 'all modes' },
      { pts: sample(60, s => [3 * s, Math.exp(-6 * s) / v0]), colour: muted, dash: '7 6', label: 'slowest mode' },
    ]);
  } else {
    // both calibrated for a base rate near 0.2: the constant forecast, and one that tells cases apart
    const sharp: [number, number][] = [[.05, .58], [.15, .2], [.25, .05], [.75, .04], [.85, .06], [.95, .07]];
    content = plot(W, H, fs, { x: { ...unit, title: 'Predicted probability' }, y: { min: 0, max: 1, ticks: [[0, '0'], [.5, '50%'], [1, '100%']], title: 'Share of forecasts' } }, [
      { pts: [], colour: muted, label: 'constant 0.2', box: true }, { pts: [], colour: accent, label: 'sharp', box: true },
    ], { bars: [{ x: .2, w: .05, v: 1, colour: muted, opacity: .55 }, ...sharp.map(([x, v]) => ({ x: x + .012, w: .05, v, colour: accent }))] });
  }
  return `  <svg role="img" aria-label="${CAPTIONS[type]}" viewBox="0 0 ${W} ${H}" style="position: absolute; left: ${f(x)}px; top: ${f(y)}px; width: ${f(w)}px; height: ${f(h)}px">${content}</svg>`;
}

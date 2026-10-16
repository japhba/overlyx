/** Layouts measured from the 2026 project posters. Coordinates remain in source millimetres.
 * Research text, author identities, institutional marks and data are replaced with editable examples.
 */
import type { ScientificTemplate } from './scientific.ts';
type Chart = (type: 'decay' | 'phase' | 'calibration', x: number, y: number, w: number, h: number) => string;
const px = (n: number) => +(n * 96 / 25.4).toFixed(3);
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const colors: Record<string, string> = { jblue: '#023d6b', jbluedark: '#012848', jbluemid: '#0070b4', paleblue: '#ecf2f8', accred: '#d62728', ink: '#1c2026', white: '#ffffff' };
function color(value: string): string {
  const [name, amount, base = 'white'] = value.split('!');
  const a = colors[name] || name;
  if (!amount) return a;
  const b = colors[base] || '#ffffff', weight = Number(amount) / 100;
  return '#' + [1, 3, 5].map(i => Math.round(parseInt(a.slice(i, i + 2), 16) * weight + parseInt(b.slice(i, i + 2), 16) * (1 - weight)).toString(16).padStart(2, '0')).join('');
}
const box = (x: number, y: number, w: number, h: number, fill: string, extra = '') => `<div class="decoration" style="position: absolute; left: ${px(x)}px; top: ${px(y)}px; width: ${px(w)}px; height: ${px(h)}px; background: ${fill}; ${extra}"></div>`;
const text = (x: number, y: number, w: number, value: string, size = 25, extra = '', tag = 'p') => `<${tag} style="position: absolute; left: ${px(x)}px; top: ${px(y)}px; width: ${px(w)}px; font-size: ${size * 96 / 72.27}px; line-height: 1.34; ${extra}">${value}</${tag}>`;
const copy: Record<string, string> = {
  Authors: 'Your Name¹ · Alex Morgan² · Sam Rivera¹',
  Affiliations: '¹ Centre for Applied Mathematics · ² Institute for Quantitative Science<br>research@example.org',
  Funding: 'Analytical teaching example · Replace with your acknowledgements and contact details.',
  'Paper & code': 'Project details',
  'TLDR heading': 'TL;DR', TLDR: 'Diffusion removes fine structure first. Doubling spatial frequency reduces a mode’s lifetime by a factor of four.',
  'Abstract heading': 'Abstract', Abstract: 'The heat equation describes how spatial variation relaxes over time. Fourier modes evolve independently on a periodic domain. Their decay rates grow quadratically with spatial frequency. We compare exact solutions across scales and show how the initial condition and diffusivity set the observed timescales.',
  'Section 1 title': '1 · Modes separate spatial scales',
  'Equation 1': String.raw`\[u(x,t)=\sum_k a_k(0)e^{-Dk^2t}\cos(kx)\]`,
  'Section 1 text': 'A periodic profile is a sum of Fourier modes. Each evolves independently under constant diffusivity. Fine patterns relax faster than broad ones.',
  'Figure 1 caption': 'Analytical solutions for two spatial frequencies. The second mode decays four times faster.',
  'Section 2 title': '2 · The heat equation',
  'Section 2 text': 'Conservation and a flux proportional to the local gradient yield the heat equation. Here the diffusivity is uniform and there is no external forcing.',
  'Equation 2': String.raw`\[\partial_t u=D\partial_x^2u\]`,
  'Section 2 scaling': 'Periodic boundaries preserve the spatial mean.',
  'Section 3 title': '3 · One timescale for each mode',
  'Section 3 text': 'Substitution of a Fourier mode gives an exact scalar evolution law.',
  'Equation 3': String.raw`\[\frac{d a_k}{dt}=-Dk^2a_k\]`,
  'Section 3 posterior': 'The solution is exponential at every frequency.',
  'Equation 4': String.raw`\[a_k(t)=a_k(0)e^{-t/\tau_k},\quad \tau_k=(Dk^2)^{-1}\]`,
  Punchline: 'Scale sets lifetime.', 'Punchline text': 'Doubling the spatial frequency produces four times faster relaxation.',
  'Punchline formula': String.raw`\[\tau_{2k}=\tau_k/4\]`,
  'Section 4 title': '4 · Exact decay curves', 'Section 4 text': 'Normalized amplitudes collapse when time is measured in units of each mode’s lifetime.',
  'Section 5 title': '5 · Fine structure fades first', 'Section 5 text': 'Compare exact mode amplitudes under the same diffusivity.',
  'Figure 5a caption': 'Analytical exponential decay; solid and dashed curves denote the first and second modes.',
  'Section 5 transition': 'The amplitude ratio isolates the additional decay of the higher-frequency mode.',
  'Equation 5': String.raw`\[\frac{a_{2k}(t)}{a_k(t)}=\frac{a_{2k}(0)}{a_k(0)}e^{-3Dk^2t}\]`,
  'Section 5 alignment': 'The long-time profile is dominated by the slowest nonconstant mode.',
  'Figure 5b caption': 'Analytical teaching illustration, rather than measured data.',
  'Section 6 title': '6 · Interpret with assumptions',
  'Section 6 text': 'Constant diffusivity and periodic boundaries make the solution exact.<br><br>With forcing, nonlinear transport, or heterogeneous materials, modes may couple.<br><br>For measured data, report spatial resolution, fit uncertainty, and boundary conditions.',
  'Conclusion heading': 'Conclusion', Conclusion: 'Spatial scale determines relaxation time. The exact heat-equation solution provides a baseline for separating diffusion from other transport mechanisms.',
  'Structure to function': 'Spatial scale<br>↓<br>Relaxation time',
};
const portraitGeometry = [
  {"kind": "olshape", "x": "0mm", "y": "0mm", "w": "841mm", "h": "11mm", "fill": "jblue", "name": "Top bar"},
  {"kind": "olshape", "x": "0mm", "y": "170mm", "w": "841mm", "h": "3.5mm", "fill": "jblue", "name": "Header rule"},
  {"kind": "olshape", "x": "0mm", "y": "173.5mm", "w": "841mm", "h": "2.5mm", "fill": "jbluemid", "name": "Header rule (light)"},
  {"kind": "olshape", "x": "0mm", "y": "1103mm", "w": "841mm", "h": "86mm", "fill": "paleblue", "name": "Footer band"},
  {"kind": "olshape", "x": "0mm", "y": "1100.5mm", "w": "841mm", "h": "2.5mm", "fill": "jblue", "name": "Footer rule"},
  {"kind": "olbox", "x": "30mm", "y": "25mm", "w": "499.84mm", "h": "72mm", "font": "94pt", "leading": "1.128", "color": "jblue", "name": "Title"},
  {"kind": "olbox", "x": "30mm", "y": "102mm", "w": "499.84mm", "h": "18mm", "font": "42pt", "leading": "1.238", "color": "ink", "name": "Authors"},
  {"kind": "olbox", "x": "30mm", "y": "124mm", "w": "499.84mm", "h": "26.77mm", "font": "27pt", "leading": "1.333", "color": "ink!70", "name": "Affiliations"},
  {"kind": "olimage", "x": "557.07mm", "y": "17mm", "w": "142mm", "h": "60.86mm", "name": "Gatsby / UCL"},
  {"kind": "olimage", "x": "564.47mm", "y": "88mm", "w": "127.1mm", "h": "36.93mm", "name": "J\u00fclich"},
  {"kind": "olshape", "x": "705.77mm", "y": "16mm", "w": "1.06mm", "h": "95mm", "fill": "jblue!20", "name": "Header divider"},
  {"kind": "olraw", "x": "723.37mm", "y": "25mm", "w": "87.6mm", "h": "87.6mm", "name": "QR code"},
  {"kind": "olbox", "x": "723.37mm", "y": "116.5mm", "w": "87.6mm", "h": "12mm", "font": "30pt", "color": "jblue", "align": "center", "name": "Paper & code"},
  {"kind": "olbox", "x": "553.27mm", "y": "139.5mm", "w": "257.73mm", "h": "15mm", "font": "16pt", "leading": "1.313", "color": "ink!55", "name": "Funding"},
  {"kind": "olbox", "x": "30mm", "y": "178mm", "w": "781mm", "h": "93mm", "fill": "paleblue", "radius": "4.94mm", "name": "Abstract card"},
  {"kind": "olshape", "x": "30mm", "y": "178mm", "w": "4.23mm", "h": "93mm", "fill": "jblue", "name": "Abstract bar"},
  {"kind": "olbox", "x": "43mm", "y": "185mm", "w": "210mm", "h": "15mm", "font": "34pt", "color": "jblue", "name": "TLDR heading"},
  {"kind": "olbox", "x": "43mm", "y": "203mm", "w": "210mm", "h": "61mm", "font": "27pt", "leading": "1.3", "color": "ink", "name": "TLDR"},
  {"kind": "olshape", "x": "271mm", "y": "187mm", "w": "1.06mm", "h": "75mm", "fill": "jblue!30", "name": "Abstract divider"},
  {"kind": "olbox", "x": "289mm", "y": "185mm", "w": "507mm", "h": "15mm", "font": "34pt", "color": "jblue", "name": "Abstract heading"},
  {"kind": "olbox", "x": "289mm", "y": "203mm", "w": "507mm", "h": "61mm", "font": "25pt", "leading": "1.32", "color": "ink", "align": "justify", "name": "Abstract"},
  {"kind": "olshape", "x": "428mm", "y": "291.8mm", "w": "1.06mm", "h": "796mm", "fill": "jblue!25", "name": "Column divider"},
  {"kind": "olbox", "x": "30mm", "y": "295.3mm", "w": "382.69mm", "h": "18mm", "font": "46pt", "leading": "1.174", "color": "jblue", "name": "Section 1 title"},
  {"kind": "olshape", "x": "30mm", "y": "315.3mm", "w": "382.69mm", "h": "1.06mm", "fill": "jblue!25", "name": "Section 1 rule"},
  {"kind": "olbox", "x": "30mm", "y": "320mm", "w": "382.69mm", "h": "48mm", "font": "25pt", "fill": "paleblue", "radius": "3.53mm", "color": "ink", "name": "Equation 1"},
  {"kind": "olshape", "x": "30mm", "y": "320mm", "w": "2.82mm", "h": "48mm", "fill": "jblue", "name": "Equation 1 bar"},
  {"kind": "olbox", "x": "30mm", "y": "390mm", "w": "149.25mm", "h": "90mm", "font": "25pt", "leading": "1.34", "color": "ink", "name": "Section 1 text"},
  {"kind": "olbox", "x": "30mm", "y": "478mm", "w": "149.25mm", "h": "42mm", "font": "23pt", "leading": "1.304", "color": "ink!70", "name": "Figure 1 caption"},
  {"kind": "olimage", "x": "186.9mm", "y": "364mm", "w": "225.79mm", "h": "181.32mm", "name": "Figure 1"},
  {"kind": "olbox", "x": "30mm", "y": "566.7mm", "w": "382.69mm", "h": "18mm", "font": "46pt", "leading": "1.174", "color": "jblue", "name": "Section 2 title"},
  {"kind": "olshape", "x": "30mm", "y": "586.7mm", "w": "382.69mm", "h": "1.06mm", "fill": "jblue!25", "name": "Section 2 rule"},
  {"kind": "olbox", "x": "30mm", "y": "592mm", "w": "382.69mm", "h": "69.2mm", "font": "25pt", "leading": "1.34", "color": "ink", "align": "justify", "name": "Section 2 text"},
  {"kind": "olbox", "x": "30mm", "y": "659mm", "w": "382.69mm", "h": "76mm", "font": "25pt", "fill": "paleblue", "radius": "3.53mm", "color": "ink", "name": "Equation 2"},
  {"kind": "olshape", "x": "30mm", "y": "659mm", "w": "2.82mm", "h": "76mm", "fill": "jblue", "name": "Equation 2 bar"},
  {"kind": "olbox", "x": "30mm", "y": "738mm", "w": "382.69mm", "h": "24mm", "font": "25pt", "leading": "1.34", "color": "ink", "align": "justify", "name": "Section 2 scaling"},
  {"kind": "olbox", "x": "30mm", "y": "780.1mm", "w": "382.69mm", "h": "18mm", "font": "46pt", "leading": "1.174", "color": "jblue", "name": "Section 3 title"},
  {"kind": "olshape", "x": "30mm", "y": "800.1mm", "w": "382.69mm", "h": "1.06mm", "fill": "jblue!25", "name": "Section 3 rule"},
  {"kind": "olbox", "x": "30mm", "y": "807.5mm", "w": "382.69mm", "h": "26.12mm", "font": "25pt", "leading": "1.34", "color": "ink", "align": "justify", "name": "Section 3 text"},
  {"kind": "olbox", "x": "30mm", "y": "833mm", "w": "382.69mm", "h": "58mm", "font": "25pt", "fill": "paleblue", "radius": "3.53mm", "color": "ink", "name": "Equation 3"},
  {"kind": "olshape", "x": "30mm", "y": "833mm", "w": "2.82mm", "h": "58mm", "fill": "jblue", "name": "Equation 3 bar"},
  {"kind": "olbox", "x": "30mm", "y": "898mm", "w": "382.69mm", "h": "24mm", "font": "25pt", "leading": "1.34", "color": "ink", "align": "justify", "name": "Section 3 posterior"},
  {"kind": "olbox", "x": "30mm", "y": "926mm", "w": "382.69mm", "h": "46mm", "font": "25pt", "fill": "paleblue", "radius": "3.53mm", "color": "ink", "name": "Equation 4"},
  {"kind": "olshape", "x": "30mm", "y": "926mm", "w": "2.82mm", "h": "46mm", "fill": "jblue", "name": "Equation 4 bar"},
  {"kind": "olbox", "x": "30mm", "y": "977mm", "w": "382.69mm", "h": "70mm", "fill": "accred!5!white", "draw": "accred", "radius": "3.53mm", "name": "Punchline card"},
  {"kind": "olbox", "x": "38.8mm", "y": "982mm", "w": "365.09mm", "h": "15.08mm", "font": "36pt", "color": "accred", "name": "Punchline"},
  {"kind": "olbox", "x": "38.8mm", "y": "995.5mm", "w": "249.95mm", "h": "48.24mm", "font": "25pt", "leading": "1.34", "color": "ink", "name": "Punchline text"},
  {"kind": "olbox", "x": "279.76mm", "y": "1001mm", "w": "124.13mm", "h": "34mm", "font": "25pt", "color": "ink", "name": "Punchline formula"},
  {"kind": "olbox", "x": "443.93mm", "y": "295.3mm", "w": "367.07mm", "h": "18mm", "font": "46pt", "leading": "1.174", "color": "jblue", "name": "Section 4 title"},
  {"kind": "olshape", "x": "443.93mm", "y": "315.3mm", "w": "247.64mm", "h": "1.06mm", "fill": "jblue!25", "name": "Section 4 rule"},
  {"kind": "olbox", "x": "443.93mm", "y": "342mm", "w": "255.14mm", "h": "38mm", "font": "25pt", "leading": "1.34", "color": "ink", "align": "justify", "name": "Section 4 text"},
  {"kind": "olimage", "x": "707.34mm", "y": "285.48mm", "w": "104.53mm", "h": "117.05mm", "name": "Figure 4"},
  {"kind": "olbox", "x": "443.93mm", "y": "411.9mm", "w": "367.07mm", "h": "18mm", "font": "46pt", "leading": "1.174", "color": "jblue", "name": "Section 5 title"},
  {"kind": "olshape", "x": "443.93mm", "y": "431.9mm", "w": "367.07mm", "h": "1.06mm", "fill": "jblue!25", "name": "Section 5 rule"},
  {"kind": "olbox", "x": "443.93mm", "y": "439.5mm", "w": "367.07mm", "h": "24mm", "font": "25pt", "leading": "1.34", "color": "ink", "align": "justify", "name": "Section 5 text"},
  {"kind": "olimage", "x": "465.95mm", "y": "467mm", "w": "323.02mm", "h": "107.46mm", "name": "Figure 5a"},
  {"kind": "olbox", "x": "443.93mm", "y": "578.5mm", "w": "367.07mm", "h": "20mm", "font": "23pt", "leading": "1.304", "color": "ink!70", "align": "justify", "name": "Figure 5a caption"},
  {"kind": "olbox", "x": "443.93mm", "y": "602mm", "w": "367.07mm", "h": "36mm", "font": "25pt", "leading": "1.34", "color": "ink", "align": "justify", "name": "Section 5 transition"},
  {"kind": "olbox", "x": "443.93mm", "y": "641mm", "w": "367.07mm", "h": "80mm", "font": "25pt", "fill": "paleblue", "radius": "3.53mm", "color": "ink", "name": "Equation 5"},
  {"kind": "olshape", "x": "443.93mm", "y": "641mm", "w": "2.82mm", "h": "80mm", "fill": "jblue", "name": "Equation 5 bar"},
  {"kind": "olbox", "x": "443.93mm", "y": "722.5mm", "w": "367.07mm", "h": "26mm", "font": "25pt", "leading": "1.34", "color": "ink", "align": "justify", "name": "Section 5 alignment"},
  {"kind": "olimage", "x": "495.32mm", "y": "749mm", "w": "264.29mm", "h": "79.92mm", "name": "Figure 5b"},
  {"kind": "olbox", "x": "443.93mm", "y": "836mm", "w": "367.07mm", "h": "20mm", "font": "23pt", "leading": "1.304", "color": "ink!70", "align": "justify", "name": "Figure 5b caption"},
  {"kind": "olbox", "x": "443.93mm", "y": "866.3mm", "w": "367.07mm", "h": "18mm", "font": "46pt", "leading": "1.174", "color": "jblue", "name": "Section 6 title"},
  {"kind": "olshape", "x": "443.93mm", "y": "886.3mm", "w": "367.07mm", "h": "1.06mm", "fill": "jblue!25", "name": "Section 6 rule"},
  {"kind": "olbox", "x": "443.93mm", "y": "892.5mm", "w": "234.92mm", "h": "140mm", "font": "25pt", "leading": "1.34", "color": "ink", "name": "Section 6 text"},
  {"kind": "olimage", "x": "689.87mm", "y": "899mm", "w": "121.13mm", "h": "196.8mm", "name": "Figure 6"},
  {"kind": "olbox", "x": "30mm", "y": "1112mm", "w": "117.15mm", "h": "62mm", "font": "48pt", "color": "jblue", "name": "Conclusion heading"},
  {"kind": "olshape", "x": "158mm", "y": "1115mm", "w": "1.06mm", "h": "56mm", "fill": "jblue!30", "name": "Footer divider"},
  {"kind": "olbox", "x": "173.5mm", "y": "1112mm", "w": "437.36mm", "h": "62mm", "font": "29pt", "leading": "1.345", "color": "ink", "name": "Conclusion"},
  {"kind": "olbox", "x": "623.56mm", "y": "1118mm", "w": "187.44mm", "h": "62mm", "font": "42pt", "leading": "1.143", "fill": "jblue", "radius": "4.94mm", "color": "white", "align": "center", "name": "Structure to function"},
] as const;

export function projectPosterObjects(t: ScientificTemplate, title: string, chart: Chart): string[] {
  const name = esc(title || t.exampleTitle);
  const fig = (type: Parameters<Chart>[0], x: number, y: number, w: number, h: number) => chart(type, px(x), px(y), px(w), px(h));
  if (t.id === 'bernstein-2026') return portraitGeometry.map(raw => {
    const o: Record<string, string> = raw;
    const n = (key: string) => parseFloat(o[key] || '0');
    const x = n('x'), y = n('y'), w = n('w'), h = n('h');
    if (o.kind === 'olshape' || !copy[o.name] && o.fill) return box(x, y, w, h, color(o.fill || 'white'), `border-radius: ${px(n('radius'))}px; ${o.draw ? `border: 3px solid ${color(o.draw)};` : ''}`);
    if (o.kind === 'olimage') {
      if (o.name.startsWith('Figure')) return fig('decay', x, y, w, h);
      return text(x, y + h / 4, w, o.name.includes('Gatsby') ? 'RESEARCH<br>INSTITUTE' : 'UNIVERSITY', o.name.includes('Gatsby') ? 42 : 36, 'font-weight: 700; color: #023d6b; text-align: center');
    }
    if (o.kind === 'olraw') return box(x, y, w, h, '#ecf2f8') + text(x + 5, y + 25, w - 10, 'Project<br>website', 30, 'text-align: center; color: #023d6b');
    const content = o.name === 'Title' ? name : copy[o.name] || '';
    return (o.fill ? box(x, y, w, h, color(o.fill), `border-radius: ${px(n('radius'))}px;`) : '') + text(x, y + (o.name === 'Punchline text' ? 4 : 0), w, content, o.name === 'Funding' ? 19 : n('font') || 25, `color: ${color(o.color || 'ink')}; line-height: ${o.leading || '1.2'}; text-align: ${o.align || 'left'}; ${/title|heading|Punchline$|Title/.test(o.name) ? 'font-weight: 700;' : ''}`, o.name === 'Title' ? 'h1' : /title/.test(o.name) ? 'h2' : 'p');
  });
  // ICML source: 1210 × 910 mm; 24 mm margins, columns .305/.35/.305 of 1162 mm.
  const out: string[] = [text(24, 4, 866, title ? name : 'Diffusion reveals the timescales <br>of spatial structure', 90, 'font-weight: 700; color: #023d6b; line-height: 1.02', 'h1'), text(24, 75, 866, copy.Authors, 42, 'line-height: 1.1'), text(24, 94, 866, 'Centre for Applied Mathematics · Institute for Quantitative Science · research@example.org', 27), text(918, 25, 268, 'RESEARCH INSTITUTE<br>UNIVERSITY', 42, 'font-weight: 700; text-align: center; color: #023d6b'), box(24, 108, 1162, 35, '#023d6b'), text(29, 111, 1152, '<b>TL;DR:</b> ' + copy.TLDR, 33, 'color: white; line-height: 1.27')];
  const head = (x: number, y: number, w: number, label: string) => { out.push(text(x, y, w, label, 44, 'font-weight: 700; line-height: 1.14; color: #023d6b', 'h2'), box(x, y + (label.length > 46 ? 47 : 29), w, .7, '#023d6b')); };
  const para = (x: number, y: number, w: number, value: string, size = 30) => out.push(text(x, y, w, value, size));
  const eq = (x: number, y: number, w: number, h: number, value: string) => out.push(box(x, y, w, h, '#eef3f8', 'border: 2px solid #023d6b'), text(x + 5, y + 5, w - 10, value, 30));
  head(24, 166, 354.41, '1 · Modes separate spatial scales'); para(24, 203, 354.41, copy['Section 1 text']); para(24, 250, 354.41, copy['Equation 1']); out.push(fig('decay', 77, 307, 248, 183)); para(24, 505, 354.41, copy['Figure 1 caption'], 25);
  head(24, 540, 354.41, '2 · The heat equation'); para(24, 578, 354.41, copy['Section 2 text']); para(24, 627, 354.41, copy['Equation 2']); para(24, 667, 354.41, copy['Section 2 scaling']);
  head(24, 697, 354.41, '3 · One timescale for each mode'); para(24, 735, 354.41, copy['Section 3 text']); eq(24, 771, 354.41, 57, copy['Equation 4']); out.push(box(24, 834, 354.41, 64, '#fff5f5', 'border: 2px solid #d62728')); para(29, 839, 344, '<b>Frequency sets the lifetime.</b><br>' + copy['Punchline text'], 27);
  head(401.65, 166, 406.7, '4 · Exact decay curves'); para(401.65, 245, 244, copy['Section 4 text']); out.push(fig('decay', 675, 200, 130, 135));
  head(401.65, 347, 406.7, '5 · Fine structure fades first'); para(401.65, 398, 406.7, copy['Section 5 text']); out.push(fig('decay', 448, 437, 313, 100)); para(401.65, 540, 406.7, copy['Figure 5a caption'], 25); para(401.65, 580, 406.7, copy['Section 5 transition']); eq(401.65, 625, 406.7, 92, copy['Equation 5']); para(401.65, 724, 406.7, copy['Section 5 alignment']); out.push(fig('decay', 450, 760, 308, 82)); para(401.65, 849, 406.7, copy['Figure 5b caption'], 25); out.push(box(401.65, 876, 406.7, .35, '#023d6b')); para(401.65, 882, 406.7, copy.Funding, 20);
  head(831.59, 166, 354.41, '6 · Interpret the model’s assumptions'); para(831.59, 220, 354.41, 'The exact solution provides a baseline for testing transport mechanisms.'); out.push(fig('decay', 920, 266, 177, 270)); para(831.59, 545, 354.41, copy['Section 6 text'], 25); head(831.59, 680, 354.41, '7 · Takeaways'); para(831.59, 720, 354.41, '• Fourier modes evolve independently.<br><br>• Fine patterns relax faster.<br><br>• State boundary conditions and uncertainty.', 28); out.push(box(979, 838, 65, 57, '#ecf2f8')); para(983, 849, 57, 'Project<br>website', 25);
  return out;
}

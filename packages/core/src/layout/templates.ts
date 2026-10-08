/**
 * Starting points for new layout documents: slides (beamer's aspect ratios), posters and single
 * pages. Each is the source of an ordinary beamer file — a user preamble and pages of objects —
 * plus the document settings it needs (a custom paper size for posters and pages); the server
 * writes it through the normal .tex writer, so the managed block with the layout macros is there
 * from the start and the file compiles before it was ever edited.
 */
import { PAGE_PRESETS, writeBoxKeys, writeShapeKeys, parseBoxKeys, parseShapeKeys, type BoxProps, type ShapeProps } from './model.ts';

const PREAMBLE = '\\usepackage[T1]{fontenc}\n\\usepackage{lmodern}\n\\setbeamertemplate{navigation symbols}{}\n';

function box(p: Partial<BoxProps>, body: string): string {
  return `\\begin{olbox}{${writeBoxKeys({ ...parseBoxKeys(''), ...p })}}\n${body}\n\\end{olbox}`;
}
function rect(p: Partial<ShapeProps>): string {
  return `\\olshape{${writeShapeKeys({ ...parseShapeKeys(''), vb: '0 0 100 100', ...p })}}{M 0 0 L 100 0 L 100 100 L 0 100 Z}`;
}
function page(objects: string[]): string {
  return `\\begin{frame}[plain]\n${objects.join('\n')}\n\\end{frame}`;
}

export interface LayoutTemplate {
  /** the file: \documentclass line, user preamble, body */
  text: string;
  /** document settings (header keys) to apply: the page size */
  settings: Record<string, string>;
}

export function layoutTemplate(presetId: string, opts: { title?: string; author?: string } = {}): LayoutTemplate {
  const preset = PAGE_PRESETS.find(p => p.id === presetId) ?? PAGE_PRESETS[0];
  const { w, h } = preset;
  const title = texEscape(opts.title || (preset.kind === 'poster' ? 'Title of the poster' : preset.kind === 'slides' ? 'Title of the talk' : 'Title'));
  const author = texEscape(opts.author || 'Author');
  const pages: string[] = [];
  let cls = '\\documentclass{beamer}';
  const settings: Record<string, string> = {};
  if (preset.kind === 'slides') {
    cls = `\\documentclass[aspectratio=${preset.aspect ?? '169'}]{beamer}`;
    const u = w / 160;   // proportions for the 4:3 and 16:10 sizes
    pages.push(page([
      box({ x: 12 * u, y: h * 0.3, w: w - 24 * u, h: 16, font: 26, valign: 'c', grow: true }, `\\textbf{${title}}`),
      box({ x: 12 * u, y: h * 0.3 + 20, w: w - 24 * u, h: 8, font: 13, color: 'darkgray', grow: true }, author),
      rect({ x: 12 * u, y: h * 0.3 + 17.5, w: 30, h: 0.8, fill: 'structure' }),
    ]));
    pages.push(page([
      box({ x: 10 * u, y: 7, w: w - 20 * u, h: 10, font: 20, grow: true }, '\\textbf{First point}'),
      box({ x: 10 * u, y: 22, w: (w - 20 * u) * 0.55, h: 30, font: 12, grow: true }, 'Double-click to edit the text; formulas as in documents: $e^{i\\pi}+1=0$.\n\\begin{itemize}\n\\item A list item\n\\item Another one\n\\end{itemize}'),
    ]));
  } else if (preset.kind === 'poster') {
    Object.assign(settings, { papersize: 'custom', paperwidth: `${w}mm`, paperheight: `${h}mm` });
    const m = w * 0.035, band = h * 0.12, colW = (w - 2 * m - 2 * m * 0.8) / 3;
    const objs = [
      rect({ x: 0, y: 0, w, h: band, fill: 'structure!80!black', lock: true, name: 'Header' }),
      box({ x: m, y: band * 0.18, w: w - 2 * m, h: band * 0.4, font: Math.round(w / 12), color: 'white', valign: 'c', grow: true }, `\\textbf{${title}}`),
      box({ x: m, y: band * 0.62, w: w - 2 * m, h: band * 0.2, font: Math.round(w / 30), color: 'white!85!structure', grow: true }, author),
    ];
    for (let i = 0; i < 3; i++) {
      const x = m + i * (colW + m * 0.8);
      objs.push(box({ x, y: band + m, w: colW, h: 20, font: Math.round(w / 24), color: 'structure!80!black', grow: true }, `\\textbf{${['Introduction', 'Results', 'Conclusion'][i]}}`));
      objs.push(box({ x, y: band + m + w / 24 * 0.6, w: colW, h: 60, font: Math.round(w / 34), grow: true }, 'Text of this section, with formulas like $\\nabla\\cdot\\mathbf{E}=\\rho/\\varepsilon_0$.'));
    }
    objs.push(rect({ x: 0, y: h - band * 0.45, w, h: band * 0.45, fill: 'structure!10', lock: true, name: 'Footer' }));
    pages.push(page(objs));
  } else {
    Object.assign(settings, { papersize: 'custom', paperwidth: `${w}mm`, paperheight: `${h}mm` });
    pages.push(page([
      box({ x: 20, y: 25, w: w - 40, h: 14, font: 24, grow: true }, `\\textbf{${title}}`),
      box({ x: 20, y: 45, w: w - 40, h: 40, font: 11, grow: true }, 'Text boxes, shapes and images can go anywhere on the page.'),
    ]));
  }
  const text = `${cls}\n${PREAMBLE}\\begin{document}\n${pages.join('\n\n')}\n\\end{document}\n`;
  return { text, settings };
}

/** Escape text for use in a LaTeX argument (titles, names). */
export function texEscape(s: string): string {
  return s.replace(/\\/g, '\\textbackslash{}').replace(/([#$%&_{}])/g, '\\$1').replace(/~/g, '\\textasciitilde{}').replace(/\^/g, '\\textasciicircum{}');
}

/**
 * Writing layout pages (layout/model.ts): a paragraph of layout OLPage becomes a plain beamer frame
 * whose object insets are written with the macro package of layout/latex.ts, in drawing order.
 */
import type { Item, Paragraph } from '../lyx/ast.ts';
import { paramMap } from '../lyx/ast.ts';
import type { ExportContext, RunParams } from './context.ts';
import type { TexStream } from './stream.ts';
import { insetTextLatex } from './insets.ts';
import { PAGE_PROPS_INSET, NOTES_INSET, parseShapeKeys, writeShapeKeys, shapeInBoxUnits } from '../layout/model.ts';

/** `keys …` / `path …` parameter lines of an object inset (the rest of the line, verbatim). */
function param(params: string[], key: string): string | undefined {
  for (const l of params) {
    if (l === key) return '';
    if (l.startsWith(key + ' ')) return l.slice(key.length + 1);
  }
  return undefined;
}

export function isLayoutPage(par: Paragraph): boolean { return par.layout === 'OLPage'; }

export function latexLayoutPage(ctx: ExportContext, os: TexStream, rp: RunParams, par: Paragraph): void {
  ctx.features.require('olayout');
  ctx.features.require('graphicx');
  const props = par.items.find(it => it.kind === 'inset' && it.inset.type === 'Leaf' && it.inset.name === PAGE_PROPS_INSET);
  const pp = props && props.kind === 'inset' && props.inset.type === 'Leaf' ? props.inset.params : [];
  const frame = param(pp, 'frame') ?? 'plain';
  os.breakln();
  os.write(`\\begin{frame}${frame ? `[${frame}]` : ''}\n`);
  const keys = param(pp, 'keys') ?? '';
  if (keys.trim()) os.write(`\\olpage{${keys}}\n`);
  for (const it of par.items) if (it !== props) latexLayoutObject(ctx, os, rp, it);
  os.breakln();
  os.write('\\end{frame}');
}

function latexLayoutObject(ctx: ExportContext, os: TexStream, rp: RunParams, it: Item): void {
  if (it.kind !== 'inset') return;
  const ins = it.inset;
  const keys = ins.type === 'Leaf' || ins.type === 'Text' ? param(ins.params, 'keys') ?? '' : '';
  os.breakln();
  if (ins.type === 'Text') {
    if (ins.name === 'OLBox') {
      os.write(`\\begin{olbox}{${keys}}\n`);
      insetTextLatex(ctx, os, rp, ins.paragraphs, undefined);
      os.breakln();
      os.write('\\end{olbox}\n');
    } else if (ins.name === 'OLGroup') {
      os.write(`\\begin{olgroup}{${keys}}\n`);
      for (const p of ins.paragraphs) for (const child of p.items) latexLayoutObject(ctx, os, rp, child);
      os.breakln();
      os.write('\\end{olgroup}\n');
    } else if (ins.name === NOTES_INSET) {
      os.write('\\note{');
      insetTextLatex(ctx, os, rp, ins.paragraphs, undefined);
      os.write('}\n');
    }
    return;
  }
  if (ins.type !== 'Leaf') return;
  const p = paramMap(ins.params);
  switch (ins.name) {
    case 'OLShape': {
      // the path in the box's own millimetres (equal scales in both directions: see shapeInBoxUnits)
      const k = parseShapeKeys(keys);
      const norm = shapeInBoxUnits(p.get('path') ?? '', k.vb, k.w, k.h);
      os.write(`\\olshape{${writeShapeKeys({ ...k, vb: norm.vb })}}{${norm.d}}\n`);
      break;
    }
    case 'OLImage': os.write(`\\olimage{${keys}}{${p.get('src') ?? ''}}\n`); break;
    case 'OLRaw': {
      let latex = '';
      try { latex = JSON.parse(p.get('latex') ?? '""'); } catch { /* damaged */ }
      if (p.get('placed') === 'false') { os.write(latex + '\n'); break; }
      os.write(`\\begin{olraw}{${keys}}\n${latex}${latex.endsWith('\n') ? '' : '\n'}\\end{olraw}\n`);
      break;
    }
  }
}

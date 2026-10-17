/**
 * A font by name on a run of text (core fontface.ts): the `face` attribute's value, its CSS (the
 * editor, a markdown <span style>) and \olfont in a .tex file — each read back as written.
 */
import { describe, it, expect } from 'vitest';
import { parseFace, faceValue, faceCss, faceFromCss, faceLatexOpen, parseAxes, boldWeightOf } from '../packages/core/src/fontface.ts';
import { parseTex, writeTex } from '../packages/core/src/tex/index.ts';
import { parseMarkdown } from '../packages/core/src/md/index.ts';
import { writeMarkdown } from '../packages/core/src/md/write.ts';
import type { Item } from '../packages/core/src/lyx/ast.ts';

const faces = (items: Item[]) => items.filter(i => i.kind === 'text').map(i => [(i as { text: string }).text, i.font.face ?? null, i.font.series ?? null]);

describe('the face value', () => {
  it('holds a family, its axes and OpenType features', () => {
    expect(parseFace('Inter')).toEqual({ family: 'Inter', axes: {}, features: [] });
    expect(parseFace('Inter|350')).toEqual({ family: 'Inter', axes: { wght: 350 }, features: [] });
    const f = parseFace('Roboto Flex|wght=650,wdth=87.5,GRAD=-50|+onum;-liga')!;
    expect(f).toEqual({ family: 'Roboto Flex', axes: { wght: 650, wdth: 87.5, GRAD: -50 }, features: ['+onum', '-liga'] });
    expect(faceValue(f)).toBe('Roboto Flex|GRAD=-50,wdth=87.5,wght=650|+onum;-liga');
    expect(faceValue(parseFace(faceValue(f))!)).toBe(faceValue(f));
    expect(faceValue({ family: 'Inter', axes: {}, features: ['+smcp'] })).toBe('Inter||+smcp');
    expect(parseFace('Bad;Name')).toBeNull();
    expect(parseAxes('wght=x,opsz=12')).toEqual({ opsz: 12 });
    expect(boldWeightOf(300)).toBe(700);
    expect(boldWeightOf(700)).toBe(900);
  });

  it('is CSS the editor draws and markdown keeps, read back the same', () => {
    const f = parseFace('Inter|wght=300,opsz=32|+onum;-liga')!;
    const css = faceCss(f);
    expect(css).toEqual({ 'font-family': "'Inter'", 'font-weight': '300', 'font-variation-settings': "'opsz' 32", 'font-feature-settings': "'onum' 1, 'liga' 0" });
    const style = Object.entries(css).map(([k, v]) => `${k}: ${v}`).join('; ');
    expect(faceFromCss(style)).toEqual(f);
    expect(faceFromCss('font-family: "EB Garamond", serif; font-weight: bold')).toEqual({ family: 'EB Garamond', axes: { wght: 700 }, features: [] });
    expect(faceFromCss('color: red')).toBeNull();
  });
});

describe('a .tex document', () => {
  const SAMPLE = '\\documentclass{article}\n\\begin{document}\nPlain \\olfont[300][+onum;+tnum]{Inter}{light 0123 \\textbf{bold}} and \\olfont[wght=650,opsz=24]{Inter}{heavy} and \\olfont{EB Garamond}{Garamond}.\n\\end{document}\n';

  it('reads \\olfont as the face attribute and writes it back, with its definition in the managed block', () => {
    const { doc } = parseTex(SAMPLE);
    expect(faces(doc.body[0].items)).toEqual([
      ['Plain ', null, null], ['light 0123 ', 'Inter|300|+onum;+tnum', null], ['bold', 'Inter|300|+onum;+tnum', 'bold'],
      [' and ', null, null], ['heavy', 'Inter|opsz=24,wght=650', null], [' and ', null, null], ['Garamond', 'EB Garamond', null], ['.', null, null],
    ]);
    const text = writeTex(doc, { basename: 'x' }).text;
    // (a font change closes the groups and opens them again, as LyX writes fonts)
    expect(text).toContain('Plain \\olfont[300][+onum;+tnum]{Inter}{light 0123 }\\olfont[300][+onum;+tnum]{Inter}{\\textbf{bold}} and \\olfont[opsz=24,wght=650]{Inter}{heavy} and \\olfont{EB Garamond}{Garamond}.');
    const managed = text.slice(text.indexOf('%% OverLyX'), text.indexOf('%% end OverLyX'));
    expect(managed).toContain('\\DeclareDocumentCommand \\olfont');
    expect(managed).toContain('\\RequirePackage[no-math]{fontspec}');
    expect(writeTex(parseTex(text).doc, { basename: 'x' }).text).toBe(text);
  });

  it('keeps an \\olfont it cannot read as LaTeX', () => {
    const { doc } = parseTex('\\documentclass{article}\n\\begin{document}\nA \\olfont{Not;A Font}{x} b.\n\\end{document}\n');
    expect(doc.body[0].items.every(i => !i.font.face)).toBe(true);
  });

  it('opens with the axes and features it has', () => {
    expect(faceLatexOpen(parseFace('Inter')!)).toBe('\\olfont{Inter}{');
    expect(faceLatexOpen(parseFace('Inter||+smcp')!)).toBe('\\olfont[][+smcp]{Inter}{');
  });
});

describe('a markdown document', () => {
  it('reads <span style="font-family: …"> as the face attribute and writes it back', () => {
    const md = "Plain <span style=\"font-family: 'Inter'; font-weight: 300; font-feature-settings: 'onum' 1\">light **bold**</span> end.\n";
    const { doc } = parseMarkdown(md);
    expect(faces(doc.body[0].items)).toEqual([['Plain ', null, null], ['light ', 'Inter|300|+onum', null], ['bold', 'Inter|300|+onum', 'bold'], [' end.', null, null]]);
    const out = writeMarkdown(doc).text;
    expect(out).toContain(md.trim());
  });

  it('keeps a <span> that names no font as HTML', () => {
    const { doc } = parseMarkdown('A <span class="x">b</span> c.\n');
    expect(doc.body[0].items.every(i => !i.font.face)).toBe(true);
    expect(writeMarkdown(doc).text).toContain('<span class="x">b</span>');
  });
});

describe('saving a .tex file as it was', () => {
  it('gives a file that uses \\olfont the managed block that defines it', async () => {
    const { writeTexPreserving } = await import('../packages/core/src/tex/index.ts');
    const base = '\\documentclass{article}\n\\begin{document}\nA \\olfont[300]{Inter}{light} word.\n\nB.\n\\end{document}\n';
    const parsed = parseTex(base);
    parsed.doc.body[1].items = [{ kind: 'text', text: 'B, edited.', font: {} }];
    const out = writeTexPreserving(parsed.doc, { base, parse: t => parseTex(t), write: d => writeTex(d, { basename: 'x' }) });
    expect(out.text).toContain('\\DeclareDocumentCommand \\olfont');
    expect(out.text).toContain('A \\olfont[300]{Inter}{light} word.');
  });
});

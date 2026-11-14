/**
 * An empty inline formula (Ctrl+M or `$` opens one; it stays empty until typed into) was written as
 * `$$`, which TeX and the parser read as display math: the text up to the next empty formula became a
 * display formula, and two paragraphs joined into one on reopen. It is written as `${}$`, which the
 * parser reads back as the empty formula: the round trip is exact in both directions.
 */
import { it, expect } from 'vitest';
import { lyxToPmNode, pmToLyxBody, writeParagraphs } from '@overlyx/core';
import { parseTex, writeTex } from '@overlyx/core/tex/index.ts';

const opts = { layoutDir: process.env.LYX_LAYOUT_DIR ?? `${process.env.HOME}/lyx/lib/layouts` };
const SRC = '\\documentclass{article}\n\\begin{document}\nBefore $x$ after, and more text.\n\nSecond paragraph with $y$ here.\n\nLast paragraph.\n\\end{document}\n';
const bodyOf = (text: string) => text.split('\\begin{document}')[1];

/** the document with its inline formulas emptied in the editor's model (all, or only the first) */
function emptied(onlyFirst: boolean) {
  const doc = parseTex(SRC, opts).doc;
  const pmNode = lyxToPmNode(doc);
  const pm = pmNode.toJSON();
  let done = false;
  const walk = (n: any) => { if (n.type === 'math_inline' && !(onlyFirst && done)) { n.attrs.latex = ''; done = true; } (n.content ?? []).forEach(walk); };
  walk(pm);
  return { ...doc, body: pmToLyxBody((pmNode as any).type.schema.nodeFromJSON(pm)) };
}

for (const onlyFirst of [true, false]) {
  it(`${onlyFirst ? 'one empty formula' : 'two empty formulas'}: written as \${}$, read back as empty inline formulas`, () => {
    const doc = emptied(onlyFirst);
    const text = writeTex(doc, opts).text;
    expect(bodyOf(text)).not.toContain('$$');
    expect(bodyOf(text)).toContain('Before ${}$ after');
    const again = parseTex(text, opts).doc;
    expect(again.body.length).toBe(doc.body.length);
    expect(writeParagraphs(again.body)).toBe(writeParagraphs(doc.body));
    expect(writeTex(again, opts).text).toBe(text);
  });
}

it('a file with ${}$ opens as an empty formula and is written back as ${}$', () => {
  const src = SRC.replace('$x$', '${}$');
  const { doc } = parseTex(src, opts);
  const f = JSON.stringify(doc.body).match(/"latex":"\$\$"/g);
  expect(f?.length).toBe(1);
  expect(bodyOf(writeTex(doc, opts).text)).toContain('Before ${}$ after');
});

import { expect, it } from 'vitest';
import { lyxToPmNode, pmToLyxBody } from '../packages/core/src/convert.ts';
import { walkInsets } from '../packages/core/src/lyx/ast.ts';
import { schema } from '../packages/core/src/schema.ts';
import { parseTex, writeTex } from '../packages/core/src/tex/index.ts';
import { LYX_LAYOUTS } from './lyxlib.ts';

const opts = { layoutDir: LYX_LAYOUTS };

it('renders bibliography block separators as spaces and preserves their command through editing', () => {
  const source = String.raw`\documentclass{article}
\begin{document}
\begin{thebibliography}{1}
\bibitem{sample} Example author.
\newblock \emph{Example title}.
\newblock{} Example press.
\end{thebibliography}
\end{document}
`;
  const { doc } = parseTex(source, opts);
  const insets = [...walkInsets(doc.body)].map(x => x.inset);
  expect(insets.filter(i => i.type === 'Leaf' && i.name === 'space' && i.arg === '\\newblock{}')).toHaveLength(2);
  expect(insets.some(i => i.type === 'Text' && i.name === 'ERT')).toBe(false);

  const pm = lyxToPmNode(doc);
  const out = writeTex({ ...doc, body: pmToLyxBody(pm) }, opts);
  expect(out.warnings).toEqual([]);
  expect(out.text).toContain('\\newblock{}\\emph{Example title}.');
  expect(out.text).toContain('\\newblock{} Example press.');
  expect(writeTex(parseTex(out.text, opts).doc, opts).text).toBe(out.text);
});

it('draws the standard newblock gap as an inline space inset', () => {
  const node = schema.nodes.space.create({ kind: '\\newblock{}' });
  expect(schema.nodes.space.spec.toDOM!(node)).toEqual(['span', {
    class: 'lyx-space', 'data-kind': '\\newblock{}', 'data-params': '[]',
    title: 'space \\newblock{}', style: 'display:inline-block;width:0.11em',
  }, ' ']);
});

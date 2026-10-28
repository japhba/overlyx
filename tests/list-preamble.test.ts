import { describe, it, expect } from 'vitest';
import { parseTex, writeTex, writeTexPreserving } from '../packages/core/src/tex/index.ts';
import { canonical } from '../packages/core/src/tex/preserve.ts';
import { lyxToPm, pmToLyxBody } from '../packages/core/src/index.ts';

const doc = (body: string) => `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;
const rewrite = (text: string) => writeTex(parseTex(text).doc).text;

describe('list preambles', () => {
  it.each(['itemize', 'enumerate'])('keeps the %s preamble before the first real item', env => {
    for (const preamble of [
      '\\itemsep0pt',
      '\\setlength{\\itemsep}{0pt}',
      '% a comment mentioning \\item',
      '\\newcommand{\\listmarker}{\\item ignored}\n\n\\itemsep0pt % compact spacing',
    ]) {
      const src = doc(`\\begin{${env}}${preamble}\n\\item Alpha\n\\item Beta\n\\end{${env}}`);
      const layout = env === 'itemize' ? 'Itemize' : 'Enumerate';
      expect(parseTex(src).doc.body.map(p => p.layout)).toEqual([layout, layout]);
      const out = rewrite(src);
      expect(out).toContain(`\\begin{${env}}\n${preamble}\n\\item Alpha\n\\item Beta`);
      expect(rewrite(out)).toBe(out);
    }
  });

  it('keeps nested list preambles with their own environments', () => {
    const src = doc('\\begin{itemize}\\itemsep1pt\n\\item Parent\n\\begin{enumerate}\\setlength{\\itemsep}{0pt}\n\\item Child\n\\end{enumerate}\n\\item Next\n\\end{itemize}');
    expect(parseTex(src).doc.body.map(p => `${p.layout}@${p.depth}`)).toEqual(['Itemize@0', 'Enumerate@1', 'Itemize@0']);
    const out = rewrite(src);
    expect(out).toContain('\\begin{itemize}\n\\itemsep1pt\n\\item Parent');
    expect(out).toContain('\\begin{enumerate}\n\\setlength{\\itemsep}{0pt}\n\\item Child');
    expect(rewrite(out)).toBe(out);
  });

  it.each(['itemize', 'enumerate'])('saving %s preambles through the editor adds no items', env => {
    const src = doc(`\\begin{${env}}\\itemsep0pt\n% compact list\n  \\item Alpha\n  \\item Beta\n\\end{${env}}`);
    const parsed = parseTex(src);
    const edited = { ...parsed.doc, body: pmToLyxBody(JSON.parse(JSON.stringify(lyxToPm(parsed.doc)))) };
    const save = () => writeTexPreserving(edited, { base: src, parse: parseTex, write: writeTex }).text;
    expect(save()).toBe(src);
    const firstText = edited.body[0].items.find(it => it.kind === 'text');
    if (!firstText || firstText.kind !== 'text') throw new Error('missing first item text');
    firstText.text = 'Alpha revised';
    const out = save();
    expect(out).toBe(src.replace('Alpha', 'Alpha revised'));
    expect(parseTex(out).doc.body.map(canonical)).toEqual(edited.body.map(canonical));
  });
});

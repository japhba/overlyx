/**
 * Two "Uncover" paragraphs in a row, each with its own overlay (<2->, <3->): the writer grouped
 * consecutive paragraphs of one environment style into one environment and kept the first one's
 * argument only, so "Point three" appeared at step 2 (layout mode persona p5:F5). A paragraph that
 * brings an argument its environment already has starts an environment of its own (read back,
 * the two are kept apart by LyX's separator paragraph, as any two environments in a row).
 *   npx vitest run tests/uncover-overlays.test.ts
 */
import { describe, it, expect } from 'vitest';
import { parseTex, writeTex } from '../packages/core/src/tex/index.ts';
import { lyxToPm, pmToLyxBody, walkParagraphs, type LyxDocument } from '../packages/core/src/index.ts';

const opts = {};
const viaEditor = (d: LyxDocument): LyxDocument => ({ ...d, body: pmToLyxBody(JSON.parse(JSON.stringify(lyxToPm(d)))) });
const envs = (t: string) => [...t.matchAll(/\\begin\{uncoverenv\}(<[^>]*>)?/g)].map(m => m[1]);

describe('consecutive overlay environments', () => {
  it('a frame: each Uncover paragraph keeps its own <N->', () => {
    const src = '\\documentclass{beamer}\n\\begin{document}\n\\begin{frame}{Title}\nPoint one\n\\begin{uncoverenv}<2->\nPoint two\n\\end{uncoverenv}\n\\begin{uncoverenv}<3->\nPoint three\n\\end{uncoverenv}\n\\end{frame}\n\\end{document}\n';
    const doc = parseTex(src, opts).doc;
    // as the editor makes it: two Uncover paragraphs in a row, each with its argument
    doc.body = doc.body.filter(p => !p.items.some(it => it.kind === 'inset' && it.inset.type === 'Leaf' && it.inset.name === 'Separator'));
    expect(doc.body.map(p => p.layout)).toEqual(['Frame', 'Uncover', 'Uncover']);
    const out = writeTex(viaEditor(doc), opts).text;
    expect(envs(out)).toEqual(['<2->', '<3->']);
    expect(out.match(/\\end\{uncoverenv\}/g)).toHaveLength(2);
    const again = writeTex(parseTex(out, opts).doc, opts).text;
    expect(envs(again)).toEqual(['<2->', '<3->']);
    expect(writeTex(parseTex(again, opts).doc, opts).text).toBe(again);
  });

  it('a layout text box: the second Uncover paragraph is not folded into the first', () => {
    const src = '\\documentclass{beamer}\n\\begin{document}\n\\begin{frame}[plain]\n\\olpage{}\n\\begin{olbox}{x=10mm,y=10mm,w=60mm,h=40mm}\nPoint one\n\\begin{uncoverenv}<2->\nPoint two\n\\end{uncoverenv}\n\\begin{uncoverenv}<3->\nPoint three\n\\end{uncoverenv}\n\\end{olbox}\n\\end{frame}\n\\end{document}\n';
    const doc = parseTex(src, opts).doc;
    const inBox = [...walkParagraphs(doc.body)].filter(p => p.layout === 'Uncover');
    expect(inBox).toHaveLength(2);
    // as the editor makes it: no separator between them
    for (const p of walkParagraphs(doc.body)) for (const it of p.items) if (it.kind === 'inset' && it.inset.type === 'Text' && it.inset.paragraphs) it.inset.paragraphs = it.inset.paragraphs.filter(q => !q.items.some(x => x.kind === 'inset' && x.inset.type === 'Leaf' && x.inset.name === 'Separator'));
    const out = writeTex(viaEditor(doc), opts).text;
    expect(envs(out)).toEqual(['<2->', '<3->']);
    expect(out.match(/\\end\{uncoverenv\}/g)).toHaveLength(2);
    const again = writeTex(parseTex(out, opts).doc, opts).text;
    expect(envs(again)).toEqual(['<2->', '<3->']);
  });

  it('an argument in a later paragraph of an environment that has none yet still belongs to it (LyX)', () => {
    const src = '\\documentclass{beamer}\n\\begin{document}\n\\begin{frame}{T}\n\\begin{uncoverenv}\nA\n\nB\n\\end{uncoverenv}\n\\end{frame}\n\\end{document}\n';
    const doc = parseTex(src, opts).doc;
    const second = doc.body.filter(p => p.layout === 'Uncover')[1];
    second.items.unshift({ kind: 'inset', font: {}, inset: { type: 'Text', name: 'Argument', arg: '1', params: [], status: 'collapsed', paragraphs: [{ layout: 'Plain Layout', depth: 0, params: {}, items: [{ kind: 'text', text: '2-', font: {} }] }] } });
    const out = writeTex(doc, opts).text;
    expect(envs(out)).toEqual(['<2->']);
  });
});

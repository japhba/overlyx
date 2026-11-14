// @vitest-environment happy-dom
/**
 * A formula in a link's text (the owner: "when editing hyperlinks, preserve ability to enter formula
 * with cursor"). `\href{url}{see $x^2$}` and `[see $x^2$](url)` survive the .tex and .md readers and
 * writers; the text editor makes a link over words and formulas (it refused before), shows the
 * formula, keeps it when only the address changes and gives it back as a formula on Remove link.
 */
import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema, linkNameFor, linkShownText, linkTextParts, linkTextLatex } from '../packages/core/src/index.ts';
import { parseTex, writeTex } from '../packages/core/src/tex/index.ts';
import { parseMarkdown, writeMarkdown, markdownForLatex } from '../packages/core/src/md/index.ts';
import { hrefOf, hrefText, unlinkText, pasteLinkOverSelection, selectedLinkText, dollarsAround, linksPlugin } from '../packages/client/src/editor/links';
import { LYX_LAYOUTS } from './lyxlib';

const texOpts = { layoutDir: LYX_LAYOUTS, localDirs: [] };
const texDoc = (body: string) => `\\documentclass{article}\n\\usepackage{hyperref}\n\\begin{document}\n${body}\n\\end{document}\n`;

describe('a link’s text with formulas', () => {
  it('is LaTeX in a .tex document (words escaped, formulas kept) and the text itself in markdown', () => {
    expect(linkNameFor('see $x^2$ at 50%', false)).toEqual({ name: 'see $x^2$ at 50\\%', literal: true });
    expect(linkNameFor('plain words', false)).toEqual({ name: 'plain words', literal: false });
    expect(linkNameFor('see $x^2$', true)).toEqual({ name: 'see $x^2$', literal: true });
    expect(linkShownText('see $x^2$ at 50\\%', true)).toBe('see $x^2$ at 50%');
    expect(linkShownText('\\textbf{bold} $x$', true)).toBe('\\textbf{bold} $x$');   // other LaTeX shown as it is
    expect(linkShownText('a_b', false)).toBe('a_b');
    expect(linkTextParts('see $x^2$ now')).toEqual([{ text: 'see ' }, { math: 'x^2' }, { text: ' now' }]);
    expect(linkTextLatex('a_b $c_d$')).toBe('a\\_b $c_d$');
  });

  it('survives the .tex reader and writer', () => {
    const doc = parseTex(texDoc('Read \\href{https://x.org/a}{the $\\beta$-VAE paper} now.'), texOpts).doc;
    const tex = writeTex(doc).text;
    expect(tex).toContain('\\href{https://x.org/a}{the $\\beta$-VAE paper}');
    expect(writeTex(parseTex(tex, texOpts).doc).text).toContain('\\href{https://x.org/a}{the $\\beta$-VAE paper}');
  });

  it('survives the markdown reader and writer, and goes into the PDF’s LaTeX as a formula', () => {
    const md = 'Read [the $\\beta$-VAE paper](https://x.org/a) and [a_b](a_b.md) now.\n';
    const r = parseMarkdown(md);
    const out = writeMarkdown(r.doc).text;
    expect(out).toContain('[the $\\beta$-VAE paper](https://x.org/a)');
    expect(out).toContain('[a_b](a_b.md)');
    const latex = writeTex(markdownForLatex(r.doc)).text;
    expect(latex).toContain('{the $\\beta$-VAE paper}');
    expect(latex).toContain('{a\\_b}');
  });
});

describe('links over words and formulas in the editor', () => {
  function editor(docId: string): EditorView {
    const para = schema.node('paragraph', { layout: 'Standard' }, [schema.text('See the '), schema.nodes.math_inline.create({ latex: '\\beta' }), schema.text('-VAE paper here')]);
    const dom = document.createElement('div');
    const v = new EditorView(dom, { state: EditorState.create({ doc: schema.node('doc', null, [para]), plugins: [linksPlugin()] }) });
    v.dom.dataset.docId = docId;
    return v;
  }
  const select = (v: EditorView, from: number, to: number) => v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, from, to)));

  for (const docId of ['admin/p/doc.tex', 'admin/p/notes.md']) {
    it(`link the words with the formula and remove the link again (${docId.slice(-3)})`, () => {
      const v = editor(docId);
      // "the β-VAE paper": positions 5 … 20 (the formula is one position)
      select(v, 5, 20);
      expect(selectedLinkText(v.state)).toMatchObject({ text: 'the $\\beta$-VAE paper' });
      expect(pasteLinkOverSelection(v, 'https://x.org/a')).toBe(true);
      const node = v.state.doc.firstChild!.child(1);
      expect(node.type.name).toBe('command');
      expect(hrefOf(node)).toEqual({ url: 'https://x.org/a', name: 'the $\\beta$-VAE paper', literal: true });
      expect(hrefText(v, node)).toBe('the $\\beta$-VAE paper');
      unlinkText(v, 5);
      const p = v.state.doc.firstChild!;
      expect(p.textContent).toBe('See the -VAE paper here');
      const math: string[] = [];
      p.forEach(n => { if (n.type.name === 'math_inline') math.push(n.attrs.latex); });
      expect(math).toEqual(['\\beta']);
      v.destroy();
    });
  }

  it('Ctrl+M in the link box’s text puts dollars around the selection, the cursor inside', () => {
    const input = document.createElement('input');
    input.value = 'see x^2 here';
    input.setSelectionRange(4, 7);
    dollarsAround(input);
    expect(input.value).toBe('see $x^2$ here');
    expect([input.selectionStart, input.selectionEnd]).toEqual([5, 8]);
    input.setSelectionRange(3, 3);
    dollarsAround(input);
    expect(input.value).toBe('see$$ $x^2$ here');
    expect(input.selectionStart).toBe(4);
  });
});

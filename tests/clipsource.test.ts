// @vitest-environment happy-dom
/**
 * Copying in a .tex document puts its LaTeX on the clipboard's text, in a markdown document its
 * markdown (client editor/clipsource.ts); highlighted code copied in VS Code pastes as its text
 * (editor/cliphtml.ts isCodeHtml).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { parseTex, writeTex } from '../packages/core/src/tex/index.ts';
import { writeMarkdown, parseMarkdown } from '../packages/core/src/md/index.ts';
import { lyxToPmNode } from '../packages/core/src/convert.ts';
import { sliceSource, setSourceWriter } from '../packages/client/src/editor/clipsource.ts';
import { isCodeHtml } from '../packages/client/src/editor/cliphtml.ts';
import { LYX_LAYOUTS } from './lyxlib.ts';

const TEX = [
  '\\documentclass{article}',
  '\\begin{document}',
  '\\section{Intro}',
  'Some \\emph{word} and \\textbf{bold} text with 50\\% and $x^2$, see \\cite{foo}.\\footnote{A note.}',
  '\\begin{itemize}',
  '\\item one',
  '\\item two',
  '\\end{itemize}',
  '\\end{document}',
].join('\n') + '\n';

beforeAll(() => {
  setSourceWriter('tex', doc => { const r = writeTex(doc, { layoutDir: LYX_LAYOUTS, localDirs: [], fragment: true }); return r.text.slice(r.bodyRange.start, r.bodyRange.end); });
  setSourceWriter('md', doc => writeMarkdown(doc).text);
});

describe('copy as source', () => {
  const lyx = parseTex(TEX, { layoutDir: LYX_LAYOUTS }).doc;
  const pm = lyxToPmNode(lyx);
  const header = lyx.header.lines;

  it('writes whole paragraphs as the .tex file has them', () => {
    const text = sliceSource(pm.slice(0, pm.content.size), 'p/doc.tex', header)!;
    expect(text).toContain('\\section{Intro}');
    expect(text).toContain('Some \\emph{word} and \\textbf{bold} text with 50\\% and $x^2$, see \\cite{foo}.\\footnote{A note.}');
    expect(text).toMatch(/\\begin\{itemize\}\s*\\item one\s*\\item two\s*\\end\{itemize\}/);
    expect(text).not.toContain('\\begin{document}');
  });

  it('writes words inside a paragraph as words', () => {
    let at = -1;
    pm.descendants((n, pos) => { if (at < 0 && n.isText && n.text!.startsWith('Some ')) at = pos; return at < 0; });
    const text = sliceSource(pm.slice(at + 5, at + 18), 'p/doc.tex', header)!;
    expect(text).toBe('\\emph{word} and \\textbf{bold}');
  });

  it('writes markdown in a markdown document', () => {
    const md = parseMarkdown('# Intro\n\nSome *word* and **bold**.\n\n- one\n- two\n').doc;
    const mpm = lyxToPmNode(md);
    expect(sliceSource(mpm.slice(0, mpm.content.size), 'p/notes.md', md.header.lines)).toBe('# Intro\n\nSome *word* and **bold**.\n\n- one\n- two');
  });

  it('leaves other documents to the plain text', () => {
    expect(sliceSource(pm.slice(0, pm.content.size), 'p/doc.lyx', header)).toBeNull();
  });
});

describe('highlighted code on the clipboard', () => {
  it('knows VS Code\'s copy', () => {
    const html = `<meta charset='utf-8'><div style="color: #cccccc;background-color: #1f1f1f;font-family: 'Droid Sans Mono', monospace;font-weight: normal;font-size: 14px;line-height: 19px;white-space: pre;"><div><span style="color: #569cd6;">\\section</span><span style="color: #cccccc;">{Intro}</span></div><br><div><span style="color: #cccccc;">Some </span><span style="color: #569cd6;">\\emph</span><span style="color: #cccccc;">{word}</span></div></div>`;
    expect(isCodeHtml(html)).toBe(true);
  });
  it('leaves rich text and ProseMirror\'s HTML alone', () => {
    expect(isCodeHtml('<p>Some <em>word</em></p>')).toBe(false);
    expect(isCodeHtml('<p data-pm-slice="1 1 []"><span style="white-space: pre">x</span></p>')).toBe(false);
    expect(isCodeHtml('<div><span>plain spans, no code</span></div>')).toBe(false);
    expect(isCodeHtml('<pre><code>\\alpha</code></pre>')).toBe(true);
  });
});


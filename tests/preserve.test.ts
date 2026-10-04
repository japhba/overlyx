/**
 * Saving without reformatting (packages/core/src/tex/preserve.ts): a document read from a user's
 * .tex file is written back into that file's text — what was not edited keeps its bytes (hard
 * line breaks, comments, the user's macro spellings, no managed block it does not need), what was
 * edited is written by the writer, and the result always reads back as the document saved.
 *   npx vitest run tests/preserve.test.ts
 */
import { describe, it, expect } from 'vitest';
import { parseTex, writeTex, writeTexPreserving, type PreserveCache, type PreserveStats } from '../packages/core/src/tex/index.ts';
import { canonical, texBalance } from '../packages/core/src/tex/preserve.ts';
import { lyxToPm, pmToLyxBody, lyxAuthorId, addAuthor, type LyxDocument, type Paragraph } from '../packages/core/src/index.ts';

/** An Overleaf-style paper: hard-wrapped paragraphs, comments, the user's own preamble and spellings. */
const PAPER = `% !TEX program = pdflatex
\\documentclass[11pt]{article}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\newcommand{\\R}{\\mathbb{R}}   % reals

\\title{A Study of Things}
\\author{A. Author \\and B. Author}

\\begin{document}
\\maketitle

\\begin{abstract}
We study things.
They are interesting.
\\end{abstract}

\\section{Introduction}
\\label{sec:intro}

Recent work on things has focused on
their size. We show that the size of a thing
in $\\R^n$ is bounded by its volume
(see Section~\\ref{sec:method}).
% TODO: cite more papers here

The second paragraph has
several lines, too.
Each sentence on its own line.

\\begin{itemize}
  \\item First point,
  wrapped.
  \\item Second point.
\\end{itemize}

\\section{Method}\\label{sec:method}
We use the following equation:
\\begin{equation}
  x^2 + y^2 = z^2 .
\\end{equation}
This concludes the method.
\\begin{center}
\\includegraphics[width=0.5\\linewidth]{fig}
\\end{center}
\\bibliographystyle{plain}
\\bibliography{refs}

\\end{document}
`;

/** REVTeX-style front matter: the abstract before \\maketitle. */
const REVTEX = `\\documentclass{article}
\\begin{document}
\\title{Physics}
\\author{C. Author}
\\begin{abstract}
An abstract,
on two lines.
\\end{abstract}
\\maketitle

\\section{One}
Body text
that is wrapped.

Another paragraph.
\\end{document}
`;

/** A child document (\\input by its master): no preamble, no settings line. */
const CHILD = `\\section{Appendix}
Some appendix text,
wrapped by hand.

% a comment between paragraphs

More appendix text.
`;

const parse = (t: string) => parseTex(t);
/** the document as the editor hands it back (ProseMirror round trip) */
const viaEditor = (d: LyxDocument): LyxDocument => ({ ...d, header: { lines: [...d.header.lines] }, body: pmToLyxBody(JSON.parse(JSON.stringify(lyxToPm(d)))) });

function save(base: string, edit: (d: LyxDocument) => void, cache: PreserveCache = {}): { text: string; stats: PreserveStats; doc: LyxDocument } {
  const p = parse(base);
  const doc = viaEditor(p.doc);
  edit(doc);
  const stats: PreserveStats = {};
  const text = writeTexPreserving(doc, { base, parse, write: d => writeTex(d, { fragment: p.fragment }), cache, stats }).text;
  if (process.env.DUMP) console.log('DUMP', JSON.stringify(changedLines(base, text)), JSON.stringify(stats));
  return { text, stats, doc };
}

/** the paragraph whose text contains `needle` */
function par(d: LyxDocument, needle: string): Paragraph {
  const p = d.body.find(x => x.items.some(it => it.kind === 'text' && it.text.includes(needle)));
  if (!p) throw new Error('no paragraph with ' + needle);
  return p;
}
function replaceText(d: LyxDocument, from: string, to: string): void {
  const p = par(d, from);
  for (const it of p.items) if (it.kind === 'text' && it.text.includes(from)) { it.text = it.text.replace(from, to); return; }
}

/** lines of `b` that are not lines of `a` at the same place, after the common prefix and suffix */
function changedLines(a: string, b: string): { removed: string[]; added: string[] } {
  const A = a.split('\n'), B = b.split('\n');
  let p = 0;
  while (p < A.length && p < B.length && A[p] === B[p]) p++;
  let s = 0;
  while (s < A.length - p && s < B.length - p && A[A.length - 1 - s] === B[B.length - 1 - s]) s++;
  return { removed: A.slice(p, A.length - s), added: B.slice(p, B.length - s) };
}

/** the saved text reads back as the document saved */
function readsBack(text: string, doc: LyxDocument): void {
  const back = parse(text).doc;
  expect(back.body.map(canonical)).toEqual(doc.body.map(canonical));
}

describe('saving keeps the file as it is where nothing changed', () => {
  for (const [name, text] of [['paper', PAPER], ['revtex', REVTEX], ['child', CHILD]] as const) {
    it(`${name}: a save without an edit gives the file back byte for byte`, () => {
      const r = save(text, () => {});
      expect(r.text).toBe(text);
    });
  }

  it('one word typed into a hard-wrapped paragraph changes that paragraph only', () => {
    const r = save(PAPER, d => replaceText(d, 'the size of a thing', 'the true size of a thing'));
    const { removed, added } = changedLines(PAPER, r.text);
    // the paragraph's source lines (the comment line after it belongs to it) become the writer's
    // one line; nothing else moves
    expect(removed.join('\n')).toBe('Recent work on things has focused on\ntheir size. We show that the size of a thing\nin $\\R^n$ is bounded by its volume\n(see Section~\\ref{sec:method}).\n% TODO: cite more papers here');
    expect(added).toEqual(['Recent work on things has focused on their size. We show that the true size of a thing in $\\R^n$ is bounded by its volume (see Section~\\ref{sec:method}). % TODO: cite more papers here']);
    expect(r.text).toContain('\\newcommand{\\R}{\\mathbb{R}}   % reals');
    expect(r.text).not.toContain('%% OverLyX');
    expect(r.stats.outcome).toBe('kept');
    readsBack(r.text, r.doc);
  });

  it('an edited list item is written; its neighbours and the list around it are kept', () => {
    const r = save(PAPER, d => replaceText(d, 'Second point.', 'Second point, revised.'));
    const { removed, added } = changedLines(PAPER, r.text);
    expect(removed).toEqual(['  \\item Second point.']);
    expect(added).toEqual(['  \\item Second point, revised.']);   // its indentation is the line's, kept
    readsBack(r.text, r.doc);
  });

  it('deleting and inserting paragraphs touches only those places', () => {
    const del = save(PAPER, d => { d.body.splice(d.body.indexOf(par(d, 'The second paragraph has')), 1); });
    expect(changedLines(PAPER, del.text).added).toEqual([]);
    expect(del.text).not.toContain('The second paragraph has');
    readsBack(del.text, del.doc);
    const ins = save(PAPER, d => { d.body.splice(d.body.indexOf(par(d, 'The second paragraph has')), 0, { layout: 'Standard', depth: 0, params: {}, items: [{ kind: 'text', text: 'An inserted paragraph.', font: {} }] }); });
    const c = changedLines(PAPER, ins.text);
    expect(c.removed).toEqual([]);
    expect(c.added.filter(l => l.trim())).toEqual(['An inserted paragraph.']);
    readsBack(ins.text, ins.doc);
  });

  it('editing the paragraph before a \\begin{center} or a \\bibliographystyle keeps them', () => {
    const r = save(PAPER, d => replaceText(d, 'This concludes the method.', 'This concludes the method section.'));
    expect(r.text).toContain('\\begin{center}\n\\includegraphics[width=0.5\\linewidth]{fig}\n\\end{center}');
    expect(r.text).toContain('\\bibliographystyle{plain}\n\\bibliography{refs}');
    readsBack(r.text, r.doc);
  });

  it('\\maketitle after the abstract (REVTeX) is neither lost nor doubled when the front matter is edited', () => {
    for (const edit of [(d: LyxDocument) => replaceText(d, 'An abstract,', 'A new abstract,'), (d: LyxDocument) => replaceText(d, 'Body text', 'The body text')]) {
      const r = save(REVTEX, edit);
      expect(r.text.match(/\\maketitle/g)).toHaveLength(1);
      readsBack(r.text, r.doc);
    }
  });

  it('a child document gets no settings line it did not have', () => {
    const r = save(CHILD, d => replaceText(d, 'More appendix text.', 'More appendix text, edited.'));
    expect(r.text).toBe(CHILD.replace('More appendix text.', 'More appendix text, edited.'));
  });

  it('a managed block appears when the content needs one, and goes again when it no longer does', () => {
    const cache: PreserveCache = {};
    // a tracked change needs the change-tracking macros: the block goes right before \begin{document}
    const tracked = save(PAPER, d => {
      const ann = lyxAuthorId('Ann', '');
      addAuthor(d.header, ann, 'Ann', '');
      const p = par(d, 'This concludes the method.');
      p.items.push({ kind: 'text', text: ' Added.', font: {}, change: { type: 'inserted', author: ann, time: 1790000000 } });
    }, cache);
    expect(tracked.text).toContain('%% OverLyX ---');
    expect(tracked.text).toContain('\\lyxadded');
    const lines = changedLines(PAPER, tracked.text);
    expect(lines.added.some(l => l.includes('\\lyxadded'))).toBe(true);
    readsBack(tracked.text, tracked.doc);
    // the change taken back: the file is what it was
    const back = save(tracked.text, d => {
      const p = par(d, 'This concludes the method.');
      p.items = p.items.filter(it => !it.change);
    }, cache);
    expect(back.text).toBe(PAPER);
  });

  it("a managed block from an older OverLyX is brought up to date (it is OverLyX's own)", () => {
    const old = PAPER.replace('\\begin{document}', '%% OverLyX ------------------------------------------------------------------\n%% overlyx-settings: {"textclass":"article"}\n\\providecommand{\\lyxoldmacro}{x}\n%% end OverLyX --------------------------------------------------------------\n\\begin{document}');
    const r = save(old, () => {});
    expect(r.text).not.toContain('lyxoldmacro');
    expect(r.text).toContain('Recent work on things has focused on\ntheir size.');
    readsBack(r.text, r.doc);
    // and a block that is current stays as it is
    const tracked = save(PAPER, d => {
      const ann = lyxAuthorId('Ann', '');
      addAuthor(d.header, ann, 'Ann', '');
      par(d, 'This concludes the method.').items.push({ kind: 'text', text: ' Added.', font: {}, change: { type: 'inserted', author: ann, time: 1790000000 } });
    });
    expect(save(tracked.text, () => {}).text).toBe(tracked.text);
  });

  it('a file that uses what only the managed block defines (layout objects) gets the block', () => {
    const deck = '\\documentclass[aspectratio=169]{beamer}\n\\begin{document}\n\\begin{frame}[plain]\n\\begin{olbox}{x=10mm,y=10mm,w=60mm,h=10mm}\nFirst words\n\\end{olbox}\n\\end{frame}\n\\end{document}\n';
    const r = save(deck, () => {});
    expect(r.text).toContain('%% OverLyX ---');
    expect(r.text).toContain('\\newenvironment{olbox}');
    expect(r.text.slice(r.text.indexOf('\\begin{document}'))).toBe(deck.slice(deck.indexOf('\\begin{document}')));
  });

  it('a document setting changed in the dialog is merged into the preamble, the rest kept', () => {
    const r = save(PAPER, d => {
      d.header.lines = d.header.lines.map(l => (l.startsWith('\\use_hyperref') ? '\\use_hyperref true' : l));
      if (!d.header.lines.some(l => l.startsWith('\\use_hyperref'))) d.header.lines.push('\\use_hyperref true');
    });
    expect(r.text).toContain('\\newcommand{\\R}{\\mathbb{R}}   % reals');
    expect(r.text).toContain('Recent work on things has focused on\ntheir size.');
    readsBack(r.text, r.doc);
  });

  it('keeps Windows line ends and a byte order mark', () => {
    const crlf = '\ufeff' + PAPER.replace(/\n/g, '\r\n');
    const zero = save(crlf, () => {});
    expect(zero.text).toBe(crlf);
    const one = save(crlf, d => replaceText(d, 'Second point.', 'Second point, revised.'));
    expect(one.text).toBe(crlf.replace('\\item Second point.', '\\item Second point, revised.'));
  });

  it('chained saves reuse the cache and stay correct', () => {
    const cache: PreserveCache = {};
    let text = PAPER;
    for (const [from, to] of [['Second point.', 'Second point 2.'], ['several lines', 'several more lines'], ['We study things.', 'We study many things.']]) {
      const r = save(text, d => replaceText(d, from, to), cache);
      expect(r.text).toContain(to);
      readsBack(r.text, r.doc);
      text = r.text;
    }
    expect(text).toContain('% TODO: cite more papers here');
  });
});

describe('the result is verified', () => {
  it('a writer whose paragraph boundaries cannot be trusted falls back to rewriting more, never to a wrong file', () => {
    const p = parse(PAPER);
    const doc = viaEditor(p.doc);
    replaceText(doc, 'Second point.', 'Second point, revised.');
    const stats: PreserveStats = {};
    // a broken source map: every paragraph's span shifted by one character
    const write = (d: LyxDocument) => {
      const r = writeTex(d);
      return { ...r, spans: r.spans.map(s => s && { start: s.start + 1, end: s.end }) };
    };
    const text = writeTexPreserving(doc, { base: PAPER, parse, write, stats }).text;
    readsBack(text, doc);
  });

  it('a parse that does not give the document back means the writer\'s text', () => {
    const p = parse(PAPER);
    const doc = viaEditor(p.doc);
    replaceText(doc, 'Second point.', 'Second point, revised.');
    const stats: PreserveStats = {};
    const full = writeTex(doc).text;
    // the base and the writer's text read normally, anything else (the result) as something else
    const lying = (t: string) => (t === PAPER || t === full ? parse(t) : parse(t.replace(/First point/g, 'Wrong point')));
    const text = writeTexPreserving(doc, { base: PAPER, parse: lying, write: d => writeTex(d), stats }).text;
    expect(stats.outcome).toBe('full');
    expect(text).toBe(full);
  });
});

describe('a preserved save never balances environments differently from both the file and a full rewrite', () => {
  it('texBalance counts environments and braces, not comments or escaped braces', () => {
    expect(texBalance('\\begin{a}x\\end{a}{y}')).toBe(texBalance(''));
    expect(texBalance('\\begin{center}\\par\\end{center}\\par\\end{center}')).not.toBe(texBalance(''));
    expect(texBalance('% \\begin{x} {\n\\{ \\}')).toBe(texBalance(''));
  });
  it('falls back to the full rewrite instead of doubling a closing line (titlepage with \\centering)', () => {
    const src = '\\documentclass{article}\n\\begin{document}\n\nBody first.\n\n\\begin{titlepage}\n    \\centering\n    {\\Large A title\\par}\n\n    Bit flip (gate $X$).\n\\end{titlepage}\n\n\\end{document}\n';
    const opts = { layoutDir: '/root/lyx/lib/layouts', localDirs: ['/tmp'] };
    const parse = (t: string) => parseTex(t, opts);
    const write = (d: any) => writeTex(d, { ...opts, fragment: false, basename: 'main' });
    const doc = parse(src).doc;
    const W = write(doc).text;
    const out = writeTexPreserving(doc, { base: W, parse, write }).text;
    expect([texBalance(W), texBalance(src)]).toContain(texBalance(out));
  });
});

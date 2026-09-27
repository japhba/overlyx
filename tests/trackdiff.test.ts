/**
 * The tracked-change diff (packages/core/src/lyx/trackdiff.ts): an agent's edit becomes the
 * smallest set of change marks — changed words or characters, not whole paragraphs — and
 * Accept all / Reject all give back exactly the new / the old document.
 */
import { describe, it, expect } from 'vitest';
import { parseTex, writeTex } from '../packages/core/src/tex/index.ts';
import { trackDiff, resolveChanges, rejectOwnChanges, changeStats } from '../packages/core/src/lyx/trackdiff.ts';
import { lyxAuthorId, addAuthor, type LyxDocument, type Paragraph } from '../packages/core/src/lyx/ast.ts';

const AGENT = 'Agent (MCP)';
const as = { author: lyxAuthorId(AGENT, ''), time: 1790000000 };
const pre = '\\documentclass{article}\n\\usepackage{hyperref}\n\\begin{document}\n';
const post = '\n\\end{document}\n';

const CV = String.raw`\section*{Education}

\textbf{PhD in Theoretical Neuroscience}, University College London \hfill 2021--2025\\
Thesis: \emph{Learning dynamics} in recurrent networks. Advisor: \href{https://example.org}{Prof.\ A. Smith}.

\begin{tabular}{ll}
2019--2021 & MSc Physics, \textbf{LMU Munich} \\
2016--2019 & BSc Physics, TU Munich \\
\end{tabular}

Some text with a footnote\footnote{The old footnote text here.} and more.

\section*{Skills}

\begin{itemize}
\item First item with $x^2$ math.
\item Second item.
\end{itemize}`;

const parse = (body: string): LyxDocument => {
  const doc = parseTex(pre + body + post).doc;
  for (const name of [AGENT, 'Jan']) addAuthor(doc.header, lyxAuthorId(name, ''), name, '');
  return doc;
};
const bodyTex = (doc: LyxDocument, pars: Paragraph[]): string => {
  const t = writeTex({ ...doc, body: pars }).text;
  return t.slice(t.indexOf('\\begin{document}') + '\\begin{document}'.length, t.indexOf('\\end{document}')).trim();
};
/** the tracked body as LaTeX, change macros shortened to \ADD{…} / \DEL{…} */
const shown = (doc: LyxDocument, pars: Paragraph[]): string =>
  bodyTex(doc, pars).replace(/\\lyxadded\{[^}]*\}\{[^}]*\}/g, '\\ADD').replace(/\\lyxdeleted\{[^}]*\}\{[^}]*\}/g, '\\DEL');

function edit(body: string, change: (s: string) => string) {
  const a = parse(body), b = parse(change(body));
  const out = trackDiff(a.body, b.body, as);
  return { a, b, out, text: shown(a, out) };
}

/** Accept all = the new document, Reject all = the old one (compared as written LaTeX). */
function expectResolves(a: LyxDocument, b: LyxDocument, out: Paragraph[]) {
  expect(bodyTex(a, resolveChanges(out, true))).toBe(bodyTex(b, b.body));
  expect(bodyTex(a, resolveChanges(out, false))).toBe(bodyTex(a, a.body));
}

describe('trackDiff: only what changed is marked', () => {
  it('a changed year marks the changed digit', () => {
    const r = edit(CV, s => s.replace('2021--2025', '2021--2026'));
    expect(r.text).toContain('2021--202\\DEL{5}\\ADD{6}');
    expect(r.text.match(/\\ADD|\\DEL/g)).toHaveLength(2);
    expectResolves(r.a, r.b, r.out);
  });

  it('a replaced word in a formatted paragraph (bold, emph, \\hfill, \\href) is one word', () => {
    const r = edit(CV, s => s.replace('recurrent networks', 'spiking networks'));
    expect(r.text).toContain('\\emph{Learning dynamics} in \\DEL{recurrent}\\ADD{spiking} networks.');
    expect(r.text.match(/\\ADD|\\DEL/g)).toHaveLength(2);
    expectResolves(r.a, r.b, r.out);
  });

  it('a rewritten phrase is one deletion and one insertion, not shredded', () => {
    const r = edit(CV, s => s.replace('Some text with a footnote\\footnote{The old footnote text here.} and more.', 'Some text with a footnote\\footnote{The old footnote text here.} and a lot of new words that replace it.'));
    expect(r.text).toMatch(/and \\DEL\{more\.\}\\ADD\{a lot of new words that replace it\.\}/);
    expectResolves(r.a, r.b, r.out);
  });

  it('a table cell edit stays inside the cell', () => {
    const r = edit(CV, s => s.replace('BSc Physics, TU Munich', 'BSc Physics (with honours), TU Munich'));
    expect(r.text).toContain('\\begin{tabular}{ll}');
    expect(r.text).not.toMatch(/\\DEL\{\\begin\{tabular/);
    expect(r.text).toMatch(/2016--2019 & BSc \\DEL\{Physics,\}\\ADD\{Physics \(with honours\),\} TU Munich/);
    expectResolves(r.a, r.b, r.out);
  });

  it('a footnote edit stays inside the footnote', () => {
    const r = edit(CV, s => s.replace('The old footnote', 'The new footnote'));
    expect(r.text).toContain('\\footnote{The \\DEL{old}\\ADD{new} footnote text here.}');
    expectResolves(r.a, r.b, r.out);
  });

  it('formulas and links change as units', () => {
    const r = edit(CV, s => s.replace('$x^2$', '$x^3$').replace('A. Smith', 'B. Smith'));
    expect(r.text).toContain('\\DEL{$x^2$}\\ADD{$x^3$}');
    expect(r.text).toContain('\\DEL{\\href{https://example.org}{Prof.\\ A. Smith}}\\ADD{\\href{https://example.org}{Prof.\\ B. Smith}}');
    expectResolves(r.a, r.b, r.out);
  });

  it('an inserted paragraph tracks its paragraph break', () => {
    const r = edit(CV, s => s.replace('\\begin{tabular}', 'A brand new paragraph.\n\n\\begin{tabular}'));
    expect(r.text).toContain('\\ADD{A brand new paragraph.}');
    expect(r.text).toContain('\\ADD{¶}');
    expectResolves(r.a, r.b, r.out);
  });

  it('a deleted paragraph is kept, struck, with its break', () => {
    const r = edit(CV, s => s.replace('Some text with a footnote\\footnote{The old footnote text here.} and more.\n\n', ''));
    expect(r.text).toContain('\\DEL{Some text with a footnote\\footnote{The old footnote text here.} and more.}');
    expect(r.text).toContain('\\DEL{¶}');
    expectResolves(r.a, r.b, r.out);
  });

  it('a new list item', () => {
    const r = edit(CV, s => s.replace('\\item Second item.', '\\item Second item.\n\\item Third item.'));
    expect(r.text).toContain('\\item \\ADD{Third item.}');
    expect(r.text).toContain('\\item Second item.');
    expectResolves(r.a, r.b, r.out);
  });

  it('a heading turned into another layout is a deleted + an inserted paragraph', () => {
    const r = edit(CV, s => s.replace('\\section*{Skills}', '\\subsection*{Skills}'));
    expect(r.text).toContain('\\section*{\\DEL{Skills}');
    expect(r.text).toContain('\\subsection*{\\ADD{Skills}}');
    expectResolves(r.a, r.b, r.out);
  });

  it('several edits across the document, each minimal', () => {
    const r = edit(CV, s => s.replace('2016--2019', '2015--2019').replace('Second item.', 'Second item, revised.').replace('LMU Munich', 'LMU München'));
    expect(r.text).toContain('201\\DEL{6}\\ADD{5}--2019');
    expect(r.text).toContain('\\item Second \\DEL{item.}\\ADD{item, revised.}');
    // too different to narrow down: the word
    expect(r.text).toContain('\\DEL{\\textbf{Munich}}\\ADD{\\textbf{München}}');
    expectResolves(r.a, r.b, r.out);
  });

  it('no change: nothing is marked and the paragraphs are the same objects', () => {
    const a = parse(CV), b = parse(CV);
    const out = trackDiff(a.body, b.body, as);
    expect(out.every((p, i) => p === a.body[i])).toBe(true);
    expect(changeStats(out, as)).toEqual({ inserted: 0, deleted: 0 });
  });
});

describe('trackDiff: existing tracked changes', () => {
  it('refining its own earlier proposal re-derives it instead of stacking changes', () => {
    const first = edit(CV, s => s.replace('recurrent networks', 'spiking networks'));
    // the agent reads the document back (with the markup) and edits its own insertion
    const seen = bodyTex(first.a, first.out);
    const again = parse(seen.replace('spiking', 'spiking neural'));
    const out = trackDiff(first.out, again.body, { ...as, time: as.time + 60 });
    const text = shown(first.a, out);
    expect(text).toContain('in \\DEL{recurrent}\\ADD{spiking neural} networks.');
    expect(bodyTex(first.a, resolveChanges(out, false))).toBe(bodyTex(first.a, first.a.body));
  });

  it('the agent may leave its own markup out of the new version', () => {
    const first = edit(CV, s => s.replace('recurrent networks', 'spiking networks'));
    const again = parse(CV.replace('recurrent networks', 'spiking neural networks'));
    const text = shown(first.a, trackDiff(first.out, again.body, as));
    expect(text).toContain('in \\DEL{recurrent}\\ADD{spiking neural} networks.');
  });

  it('deleting its own inserted paragraph removes it entirely', () => {
    const first = edit(CV, s => s.replace('\\begin{tabular}', 'A brand new paragraph.\n\n\\begin{tabular}'));
    const out = trackDiff(first.out, parse(CV).body, as);
    expect(bodyTex(first.a, out)).toBe(bodyTex(first.a, first.a.body));
    expect(changeStats(out, as)).toEqual({ inserted: 0, deleted: 0 });
  });

  it("another author's pending insertion that the new version keeps stays theirs", () => {
    const human = { author: lyxAuthorId('Jan', ''), time: 1780000000 };
    const humanEdit = trackDiff(parse(CV).body, parse(CV.replace('Second item.', 'Second item here.')).body, human);
    const out = trackDiff(humanEdit, parse(CV.replace('Second item.', 'Second item here.').replace('First item', 'Initial item')).body, as);
    const doc = parse(CV);
    const tex = bodyTex(doc, out);
    expect(tex).toContain('\\lyxadded{Jan}');
    expect(tex).toMatch(/\\lyxdeleted\{Agent \(MCP\)\}\{[^}]*\}\{First\}\\lyxadded\{Agent \(MCP\)\}\{[^}]*\}\{Initial\}/);
    expect(tex.match(/\\lyxadded\{Jan\}/g)).toHaveLength(1);
  });

  it('text already deleted stays deleted when the new version leaves it out', () => {
    const human = { author: lyxAuthorId('Jan', ''), time: 1780000000 };
    const humanEdit = trackDiff(parse(CV).body, parse(CV.replace('Second item.', 'Second.')).body, human);
    // the agent writes the clean text (without the struck word) and changes something else
    const out = trackDiff(humanEdit, parse(CV.replace('Second item.', 'Second.').replace('First item', 'Initial item')).body, as);
    const tex = bodyTex(parse(CV), out);
    expect(tex).toMatch(/\\lyxdeleted\{Jan\}\{[^}]*\}\{ item\}/);
    expect(tex).not.toMatch(/\\lyxdeleted\{Agent \(MCP\)\}\{[^}]*\}\{[^}]*item\}/);
  });

  it('rejectOwnChanges takes back only that author', () => {
    const human = { author: lyxAuthorId('Jan', ''), time: 1780000000 };
    const humanEdit = trackDiff(parse(CV).body, parse(CV.replace('Second item.', 'Second item here.')).body, human);
    const both = trackDiff(humanEdit, parse(CV.replace('Second item.', 'Second item here.').replace('First', 'Initial')).body, as);
    const back = rejectOwnChanges(both, as.author);
    expect(bodyTex(parse(CV), back)).toBe(bodyTex(parse(CV), humanEdit));
  });
});

describe('trackDiff: random edits resolve exactly', () => {
  let seed = 12345;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'networks', 'Munich', '2027', 'the', 'and', 'learning'];

  /** mutate the plain words of the body: replace / delete / insert words, drop / add / split paragraphs */
  function mutate(body: string): string {
    const lines = body.split('\n');
    for (let k = 0, n = 1 + rnd(3); k < n; k++) {
      const li = rnd(lines.length);
      const line = lines[li];
      const op = rnd(7);
      const words = [...line.matchAll(/(?<![\\{a-zA-Z])[a-z]{3,}(?![a-zA-Z}])/g)];
      if (op <= 2 && words.length) {
        const w = words[rnd(words.length)];
        const rep = op === 0 ? WORDS[rnd(WORDS.length)] : op === 1 ? '' : `${w[0]} ${WORDS[rnd(WORDS.length)]}`;
        lines[li] = line.slice(0, w.index) + rep + line.slice(w.index! + w[0].length);
      } else if (op === 3 && line.trim() && !line.startsWith('\\') && !line.includes('&')) {
        lines.splice(li, 1);
      } else if (op === 4 && !line.includes('&') && !line.startsWith('\\item')) {
        lines.splice(li, 0, '', `A new ${WORDS[rnd(WORDS.length)]} paragraph.`, '');
      } else if (op === 5 && words.length > 1 && !line.includes('&') && !line.startsWith('\\')) {
        const w = words[1];
        lines[li] = line.slice(0, w.index) + '\n\n' + line.slice(w.index);
      } else if (op === 6 && line.startsWith('\\item')) {
        lines.splice(li + 1, 0, `\\item Extra ${WORDS[rnd(WORDS.length)]}.`);
      }
    }
    return lines.join('\n');
  }

  it('Accept all = the edited version, Reject all = the original (200 random edits)', () => {
    for (let n = 0; n < 200; n++) {
      const edited = mutate(CV);
      const a = parse(CV), b = parse(edited);
      const out = trackDiff(a.body, b.body, as);
      expect(bodyTex(a, resolveChanges(out, true)), edited).toBe(bodyTex(b, b.body));
      expect(bodyTex(a, resolveChanges(out, false)), edited).toBe(bodyTex(a, a.body));
    }
  });

  it('a chain of edits on its own proposals still rejects to the original', () => {
    for (let n = 0; n < 60; n++) {
      const a = parse(CV);
      let cur = a.body, text = CV;
      for (let step = 0; step < 3; step++) {
        const seen = bodyTex(a, cur);                  // what the agent reads back (with markup)
        const next = mutate(seen);
        cur = trackDiff(cur, parse(next).body, { ...as, time: as.time + step });
        text = next;
      }
      expect(bodyTex(a, resolveChanges(cur, false)), text).toBe(bodyTex(a, a.body));
      const want = parse(text);
      expect(bodyTex(a, resolveChanges(cur, true)), text).toBe(bodyTex(want, resolveChanges(want.body, true)));
    }
  });
});

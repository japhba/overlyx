/**
 * The headings of a LaTeX file, from its text alone (no parse): the document panel shows the
 * outline of documents that are not open in the editor. Levels follow the editor's outline
 * (`buildOutline` in the client: Part 0, Chapter 1, Section 2, Subsection 3, … — the same CSS
 * classes), numbers are computed like LyX's (starred headings are unnumbered, `\appendix`
 * letters the top level), and every heading carries its ordinal `n` among all headings of the
 * file, which `#/<doc>?heading=<n>` uses to jump to it once the document is open.
 */
export interface TexHeading { level: number; text: string; n: number; num?: string; starred: boolean }

const LEVELS: Record<string, number> = { part: -1, chapter: 0, section: 1, subsection: 2, subsubsection: 3, paragraph: 4, subparagraph: 5 };
const HEAD_RE = /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)(\*?)\s*(?:\[[^\]\n]*\])?\s*\{/g;

/** the `{…}` group starting at `open` (the index of `{`), nested braces allowed; returns its content and the index after it */
function braceGroup(text: string, open: number): { body: string; end: number } | null {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') { i++; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return { body: text.slice(open + 1, i), end: i + 1 }; }
    else if (c === '\n' && depth > 0 && text[i + 1] === '\n') return null;   // a heading does not span a blank line
  }
  return null;
}

/** the words the editor shows for a heading: markup commands unwrapped, formulas kept as their LaTeX */
export function headingPlainText(latex: string): string {
  let s = latex.replace(/\\\\/g, ' ');
  // change tracking (OverLyX's \lyxadded / \lyxdeleted{author}{time}{text}): inserted text stays, deleted text goes
  for (let i = 0; i < 3; i++) s = s.replace(/\\lyxadded\s*\{[^{}]*\}\s*\{[^{}]*\}\s*\{([^{}]*)\}/g, '$1').replace(/\\lyxdeleted\s*\{[^{}]*\}\s*\{[^{}]*\}\s*\{[^{}]*\}/g, '');
  for (let i = 0; i < 4; i++) s = s.replace(/\\(?:emph|textbf|textit|texttt|textsc|textrm|textsf|mbox|protect|uppercase|MakeUppercase|text)\s*\{([^{}]*)\}/g, '$1');
  s = s.replace(/\\(?:label|index)\s*\{[^{}]*\}/g, '');
  s = s.replace(/\\(?:protect|relax)\b/g, '');
  return s.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
}

/** `true` when `at` lies in a `%` comment of its line */
function inComment(text: string, at: number): boolean {
  const ls = text.lastIndexOf('\n', at - 1) + 1;
  for (let i = ls; i < at; i++) { if (text[i] === '\\') { i++; continue; } if (text[i] === '%') return true; }
  return false;
}

export function texHeadings(text: string, secnumdepth = 3): TexHeading[] {
  const out: TexHeading[] = [];
  const counters = [0, 0, 0, 0, 0, 0, 0];
  let appendix = false;
  const appendixAt: number[] = [];
  for (const m of text.matchAll(/\\appendix\b/g)) if (!inComment(text, m.index!)) appendixAt.push(m.index!);
  let n = 0;
  HEAD_RE.lastIndex = 0;
  for (let m = HEAD_RE.exec(text); m; m = HEAD_RE.exec(text)) {
    if (inComment(text, m.index)) continue;
    const g = braceGroup(text, m.index + m[0].length - 1);
    if (!g) continue;
    if (!appendix && appendixAt.some(a => a < m.index)) { appendix = true; counters.fill(0); }
    const lvl = LEVELS[m[1]];
    const starred = m[2] === '*';
    let num: string | undefined;
    if (!starred) {
      counters[lvl + 1]++;
      for (let i = lvl + 2; i < counters.length; i++) counters[i] = 0;
      const parts = counters.slice(0, lvl + 2).map(String);
      while (parts.length > 1 && parts[0] === '0') parts.shift();
      if (appendix && parts.length) parts[0] = String.fromCharCode(64 + Number(parts[0]));
      if (lvl <= secnumdepth) num = parts.join('.');
    }
    out.push({ level: Math.max(0, lvl + 1), text: headingPlainText(g.body) || '(empty)', n: n++, num, starred });
    HEAD_RE.lastIndex = g.end;
  }
  return out;
}

/**
 * A small LaTeX scanner. It is *total*: every byte of the input belongs to some token, unbalanced
 * input never throws, and raw helpers (verbatim environments, math, balanced groups) let the
 * parser take source slices verbatim where the document model keeps LaTeX as text.
 *
 * Whitespace follows TeX's rules as far as the document model needs them: a run of blanks is one
 * space, a run containing an empty line is a paragraph break, a comment eats its newline and the
 * indentation of the next line, and the blanks after a multi-letter control sequence are skipped.
 */

export type TokKind = 'cs' | 'text' | 'space' | 'par' | 'open' | 'close' | 'math' | 'amp' | 'tilde' | 'sup' | 'sub' | 'hash' | 'comment' | 'eof';

export interface Tok {
  kind: TokKind;
  /** cs: the name without backslash ('\\' for `\\`, ' ' for `\ `); text: the run; comment: the text after `%` */
  value: string;
  start: number;
  end: number;
  /** cs: blanks followed the name and were skipped */
  spaceAfter?: boolean;
}

const isLetter = (c: string): boolean => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
const isBlank = (c: string): boolean => c === ' ' || c === '\t' || c === '\r';
const SPECIAL = new Set(['\\', '{', '}', '$', '&', '#', '^', '_', '~', '%']);

export class Scanner {
  pos: number;
  /** `@` counts as a letter (inside \makeatletter ... \makeatother) */
  atLetter = false;

  constructor(public readonly s: string, pos = 0) { this.pos = pos; }

  get eof(): boolean { return this.pos >= this.s.length; }
  peekChar(off = 0): string { return this.s[this.pos + off] ?? ''; }

  private isNameChar(c: string): boolean { return isLetter(c) || (this.atLetter && c === '@'); }

  /** Next token (consumed). */
  next(): Tok {
    const s = this.s;
    const start = this.pos;
    if (start >= s.length) return { kind: 'eof', value: '', start, end: start };
    const c = s[start];
    if (c === '\\') {
      const n = s[start + 1] ?? '';
      if (n === '') { this.pos = start + 1; return { kind: 'text', value: '\\', start, end: this.pos }; }
      if (this.isNameChar(n)) {
        let i = start + 1;
        while (i < s.length && this.isNameChar(s[i])) i++;
        const name = s.slice(start + 1, i);
        // blanks (including one newline) after a control word are ignored by TeX
        let j = i;
        let sawNewline = false;
        while (j < s.length && (isBlank(s[j]) || (s[j] === '\n' && !sawNewline))) { if (s[j] === '\n') sawNewline = true; j++; }
        // ... unless the run contains an empty line: that stays a paragraph break
        if (sawNewline && s[j] === '\n') { this.pos = i; return { kind: 'cs', value: name, start, end: i }; }
        this.pos = j;
        return { kind: 'cs', value: name, start, end: j, spaceAfter: j > i };
      }
      this.pos = start + 2;
      return { kind: 'cs', value: n, start, end: this.pos };
    }
    if (c === '%') {
      let i = start + 1;
      while (i < s.length && s[i] !== '\n') i++;
      const value = s.slice(start + 1, i);
      // the comment swallows its newline and the indentation of the next line
      if (i < s.length) i++;
      let j = i;
      while (j < s.length && isBlank(s[j])) j++;
      // an empty line after the comment is still a paragraph break (TeX: newline at line start):
      // leave the comment's newline to the following blank run so that it counts two newlines
      if (s[j] === '\n') { this.pos = i - 1; return { kind: 'comment', value, start, end: i - 1 }; }
      this.pos = j;
      return { kind: 'comment', value, start, end: j };
    }
    if (c === '\n' || isBlank(c)) {
      let i = start;
      let newlines = 0;
      while (i < s.length && (isBlank(s[i]) || s[i] === '\n')) { if (s[i] === '\n') newlines++; i++; }
      this.pos = i;
      return { kind: newlines >= 2 ? 'par' : 'space', value: s.slice(start, i), start, end: i };
    }
    this.pos = start + 1;
    switch (c) {
      case '{': return { kind: 'open', value: c, start, end: this.pos };
      case '}': return { kind: 'close', value: c, start, end: this.pos };
      case '$': return { kind: 'math', value: c, start, end: this.pos };
      case '&': return { kind: 'amp', value: c, start, end: this.pos };
      case '~': return { kind: 'tilde', value: c, start, end: this.pos };
      case '^': return { kind: 'sup', value: c, start, end: this.pos };
      case '_': return { kind: 'sub', value: c, start, end: this.pos };
      case '#': return { kind: 'hash', value: c, start, end: this.pos };
      default: break;
    }
    // a run of ordinary characters
    let i = start + 1;
    while (i < s.length && !SPECIAL.has(s[i]) && s[i] !== '\n' && !isBlank(s[i])) i++;
    this.pos = i;
    return { kind: 'text', value: s.slice(start, i), start, end: i };
  }

  peek(): Tok {
    const save = this.pos;
    const t = this.next();
    this.pos = save;
    return t;
  }

  /** Skip blanks and at most one newline (no paragraph break). Returns true when something was skipped. */
  skipBlanks(): boolean {
    const start = this.pos;
    let newlines = 0;
    let i = this.pos;
    while (i < this.s.length && (isBlank(this.s[i]) || this.s[i] === '\n')) {
      if (this.s[i] === '\n') { newlines++; if (newlines > 1) break; }
      i++;
    }
    if (newlines > 1) return false;   // a paragraph break: leave it to the parser
    this.pos = i;
    return this.pos > start;
  }

  /**
   * Read a balanced `{...}` group at the current position (after optional blanks); returns the
   * inner text, or null when there is none. An unbalanced group runs to the end of the input.
   */
  readGroup(): string | null {
    const save = this.pos;
    this.skipBlanks();
    if (this.s[this.pos] !== '{') { this.pos = save; return null; }
    const end = groupEnd(this.s, this.pos);
    const inner = this.s.slice(this.pos + 1, end - 1 >= this.pos + 1 ? end - 1 : end);
    this.pos = end;
    return inner;
  }

  /** Read a `[...]` optional argument (balanced braces inside, `\]` ignored); null when none. */
  readOptional(): string | null {
    const save = this.pos;
    this.skipBlanks();
    if (this.s[this.pos] !== '[') { this.pos = save; return null; }
    const end = optionalEnd(this.s, this.pos);
    if (end < 0) { this.pos = save; return null; }
    const inner = this.s.slice(this.pos + 1, end - 1);
    this.pos = end;
    return inner;
  }

  /** `*` directly following (a starred command); consumed when present. */
  readStar(): boolean {
    if (this.s[this.pos] === '*') { this.pos++; return true; }
    return false;
  }

  /** Read raw text up to (not including) `\end{name}`; the `\end{name}` is consumed. */
  readUntilEnd(name: string): string {
    const marker = `\\end{${name}}`;
    const idx = this.s.indexOf(marker, this.pos);
    if (idx < 0) { const out = this.s.slice(this.pos); this.pos = this.s.length; return out; }
    const out = this.s.slice(this.pos, idx);
    this.pos = idx + marker.length;
    return out;
  }

  /** Read raw text up to (not including) `marker`; the marker is consumed. Returns null when not found. */
  readUntil(marker: string): string | null {
    const idx = this.s.indexOf(marker, this.pos);
    if (idx < 0) return null;
    const out = this.s.slice(this.pos, idx);
    this.pos = idx + marker.length;
    return out;
  }

  /** Read inline math after an opening `$` (the `$` is already consumed): up to the closing `$`. */
  readDollarMath(): string | null {
    const s = this.s;
    let i = this.pos;
    while (i < s.length) {
      const c = s[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '$') { const out = s.slice(this.pos, i); this.pos = i + 1; return out; }
      if (c === '\n' && s[i + 1] === '\n') return null;   // a paragraph break inside inline math: not math
      i++;
    }
    return null;
  }

  slice(a: number, b: number): string { return this.s.slice(a, b); }
}

/** Index just after the `}` matching the `{` at `i` (or the end of the text when unbalanced). */
export function groupEnd(s: string, i: number): number {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') { j++; continue; }
    if (c === '%') { while (j < s.length && s[j] !== '\n') j++; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return j + 1; }
  }
  return s.length;
}

/** Index just after the `]` matching the `[` at `i`, or -1. */
export function optionalEnd(s: string, i: number): number {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') { j++; continue; }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === ']' && depth === 0) return j + 1;
    else if (c === '\n' && s[j + 1] === '\n') return -1;
  }
  return -1;
}

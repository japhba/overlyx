/**
 * Shared behaviour of the plain-text editors (the text-file tabs, TextEditor.tsx, and the source
 * pane, SourcePane.tsx — both a textarea under a coloured copy of the text, texhighlight.ts):
 *
 * - an undo / redo stack of their own. The browser's undo stops working as soon as a script
 *   assigns `textarea.value`, which a controlled textarea does on every keystroke and which the
 *   Tab / reload / "take the server's version" paths do too. Runs of typing (and of deleting)
 *   coalesce into one step, broken at whitespace like in most editors.
 * - bracket matching for the overlay: the bracket next to the cursor and its partner, or, when
 *   the cursor is not next to one, the innermost pair enclosing it.
 */

export interface Snapshot { value: string; start: number; end: number }

const MAX_STEPS = 500;
/** typing that pauses longer than this starts a new undo step */
const GROUP_MS = 1000;

type Kind = 'type' | 'delete' | 'other';

export class UndoStack {
  private past: Snapshot[] = [];
  private future: Snapshot[] = [];
  private last: Snapshot;
  private lastKind: Kind = 'other';
  private lastTime = 0;

  constructor(initial: Snapshot) { this.last = initial; }

  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }

  /** the text was edited by the user: `next` is the textarea after the edit */
  record(next: Snapshot, now = Date.now()): void {
    const prev = this.last;
    if (next.value === prev.value) { this.last = next; return; }
    const kind = classify(prev.value, next.value);
    const merge = kind !== 'other' && kind === this.lastKind && now - this.lastTime < GROUP_MS;
    if (!merge) {
      // the cursor of the remembered state: at the end of what changed (where the edit was made)
      const p = commonPrefix(prev.value, next.value);
      const s = commonSuffix(prev.value, next.value, p);
      const at = prev.value.length - s;
      this.past.push({ value: prev.value, start: at, end: at });
      if (this.past.length > MAX_STEPS) this.past.shift();
    }
    this.future = [];
    this.last = next;
    this.lastKind = kind;
    this.lastTime = now;
  }

  /** the text was replaced from outside (loaded, reverted, the server's version): the history starts over */
  reset(s: Snapshot): void { this.past = []; this.future = []; this.last = s; this.lastKind = 'other'; }

  undo(current: Snapshot): Snapshot | null {
    const s = this.past.pop();
    if (!s) return null;
    this.future.push(current);
    this.last = s; this.lastKind = 'other';
    return s;
  }
  redo(current: Snapshot): Snapshot | null {
    const s = this.future.pop();
    if (!s) return null;
    this.past.push(current);
    this.last = s; this.lastKind = 'other';
    return s;
  }
}

function commonPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}
function commonSuffix(a: string, b: string, prefix: number): number {
  const n = Math.min(a.length, b.length) - prefix;
  let i = 0;
  while (i < n && a.charCodeAt(a.length - 1 - i) === b.charCodeAt(b.length - 1 - i)) i++;
  return i;
}
/** typing one non-blank character / deleting one character, or anything else */
function classify(prev: string, next: string): Kind {
  const d = next.length - prev.length;
  if (d !== 1 && d !== -1) return 'other';
  const p = commonPrefix(prev, next);
  const [longer, shorter] = d === 1 ? [next, prev] : [prev, next];
  if (longer.slice(0, p) + longer.slice(p + 1) !== shorter) return 'other';
  const ch = longer[p];
  if (d === 1) return /\s/.test(ch) ? 'other' : 'type';
  return 'delete';
}

/** the key event is undo / redo (Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y; ⌘ on a Mac) */
export function undoRedoKey(e: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }, mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)): 'undo' | 'redo' | null {
  const mod = mac ? e.metaKey : e.ctrlKey;
  if (!mod || e.altKey) return null;
  const k = e.key.toLowerCase();
  if (k === 'z') return e.shiftKey ? 'redo' : 'undo';
  if (k === 'y' && !mac && !e.shiftKey) return 'redo';
  return null;
}

/** Apply an undo / redo key to a textarea; returns the snapshot now in place (the caller stores it as the new text), or null. */
export function applyUndoRedo(el: HTMLTextAreaElement, stack: UndoStack, what: 'undo' | 'redo'): Snapshot | null {
  const cur = { value: el.value, start: el.selectionStart, end: el.selectionEnd };
  const s = what === 'undo' ? stack.undo(cur) : stack.redo(cur);
  if (!s) return null;
  el.value = s.value;
  el.setSelectionRange(s.start, s.end);
  return s;
}

// ---- bracket matching ------------------------------------------------------------------------

export interface BracketMatch {
  /** offsets of the opening and closing bracket; `len` characters each (2 for \{ \}) */
  open: number; close: number; len: number;
  /** the cursor touches one of them, or the pair merely encloses the cursor */
  kind: 'adjacent' | 'enclosing';
}

const OPEN: Record<string, string> = { '{': '}', '[': ']', '(': ')' };
const CLOSE: Record<string, string> = { '}': '{', ']': '[', ')': '(' };
/** how far the partner may be (characters) */
const MAX_SCAN = 200000;

/** positions that are inside a % comment (an unescaped % up to the end of the line) */
export function commentMask(text: string): Uint8Array {
  const mask = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') { i++; continue; }
    if (c === '%') {
      let j = text.indexOf('\n', i);
      if (j < 0) j = text.length;
      mask.fill(1, i, j);
      i = j;
    }
  }
  return mask;
}

/** the bracket token starting at i: its character and whether it is a \-escaped brace (a literal one, matched with the other \-escaped brace) */
function tokenAt(text: string, i: number): { ch: string; escaped: boolean } | null {
  const c = text[i];
  if (c === undefined) return null;
  if (c in OPEN || c in CLOSE) {
    // preceded by an odd number of backslashes: escaped
    let k = i - 1, n = 0;
    while (k >= 0 && text[k] === '\\') { n++; k--; }
    return { ch: c, escaped: n % 2 === 1 };
  }
  return null;
}

/** the partner of the bracket at `i` (same escapedness, same kind, comments skipped), or -1 */
function partner(text: string, mask: Uint8Array, i: number): number {
  const t = tokenAt(text, i);
  if (!t) return -1;
  const forward = t.ch in OPEN;
  const other = forward ? OPEN[t.ch] : CLOSE[t.ch];
  let depth = 0;
  const step = forward ? 1 : -1;
  const limit = forward ? Math.min(text.length, i + MAX_SCAN) : Math.max(-1, i - MAX_SCAN);
  for (let j = i; j !== limit; j += step) {
    if (mask[j]) continue;
    const c = text[j];
    if (c !== t.ch && c !== other) continue;
    const u = tokenAt(text, j)!;
    if (u.escaped !== t.escaped) continue;
    if (c === t.ch) depth++;
    else if (--depth === 0) return j;
  }
  return -1;
}

/**
 * The bracket pair to highlight for a cursor at `pos` (no selection): the bracket just before
 * the cursor, else the one just after, else the innermost pair around the cursor.
 */
export function matchBrackets(text: string, pos: number, mask: Uint8Array = commentMask(text)): BracketMatch | null {
  const pair = (i: number, kind: BracketMatch['kind']): BracketMatch | null => {
    const j = partner(text, mask, i);
    if (j < 0) return null;
    const esc = tokenAt(text, i)!.escaped;
    const [a, b] = i < j ? [i, j] : [j, i];
    return { open: esc ? a - 1 : a, close: esc ? b - 1 : b, len: esc ? 2 : 1, kind };
  };
  for (const i of [pos - 1, pos]) {
    if (i < 0 || i >= text.length || mask[i]) continue;
    if (tokenAt(text, i)) { const m = pair(i, 'adjacent'); if (m) return m; }
  }
  // enclosing: walk back to the nearest unmatched opening bracket
  const stack: string[] = [];
  const limit = Math.max(-1, pos - MAX_SCAN);
  for (let j = pos - 1; j > limit; j--) {
    if (mask[j]) continue;
    const c = text[j];
    if (!(c in OPEN) && !(c in CLOSE)) continue;
    const u = tokenAt(text, j)!;
    const key = (u.escaped ? '\\' : '') + c;
    if (c in CLOSE) { stack.push(key); continue; }
    const want = (u.escaped ? '\\' : '') + OPEN[c];
    if (stack.length && stack[stack.length - 1] === want) { stack.pop(); continue; }
    if (stack.length) continue;   // an unbalanced opener of another kind: skip it
    return pair(j, 'enclosing');
  }
  return null;
}

// ---- editing conveniences (what one is used to from VS Code's LaTeX editing) ------------------

/** the indentation unit (Tab inserts it; Shift+Tab / Ctrl+[ remove one) */
export const INDENT = '  ';
const PAIRS: Record<string, string> = { '{': '}', '[': ']', '(': ')', $: '$' };
const CLOSERS = new Set(['}', ']', ')']);

const lineStart = (v: string, i: number): number => v.lastIndexOf('\n', i - 1) + 1;
const lineEnd = (v: string, i: number): number => { const j = v.indexOf('\n', i); return j < 0 ? v.length : j; };
const indentOf = (line: string): string => /^[ \t]*/.exec(line)![0];
const escapedAt = (v: string, i: number): boolean => { let n = 0; for (let k = i - 1; k >= 0 && v[k] === '\\'; k--) n++; return n % 2 === 1; };

/**
 * Typing an opening bracket (or `$`) with the cursor before whitespace / a closer / the end
 * inserts the pair and puts the cursor between; with a selection, the selection is wrapped.
 * Typing a closer that is already the next character steps over it.
 */
export function typeChar(s: Snapshot, ch: string): Snapshot | null {
  const v = s.value;
  if (s.start !== s.end) {
    if (!(ch in PAIRS)) return null;
    const inner = v.slice(s.start, s.end);
    return { value: v.slice(0, s.start) + ch + inner + PAIRS[ch] + v.slice(s.end), start: s.start + 1, end: s.end + 1 };
  }
  const at = s.start;
  const next = v[at] ?? '';
  if ((CLOSERS.has(ch) || ch === '$') && next === ch && !escapedAt(v, at)) return { value: v, start: at + 1, end: at + 1 };
  if (!(ch in PAIRS)) return null;
  if (escapedAt(v, at)) return null;                                  // \{ is a literal brace
  if (ch === '$' && (at > 0 && /[\w$\\]/.test(v[at - 1]))) return null;
  if (next !== '' && !/\s/.test(next) && !CLOSERS.has(next) && !(ch === '$' && next === '$')) return null;
  if (ch === '$' && next === '$') return null;
  return { value: v.slice(0, at) + ch + PAIRS[ch] + v.slice(at), start: at + 1, end: at + 1 };
}

/** Backspace between the two halves of an empty pair removes both. */
export function backspace(s: Snapshot): Snapshot | null {
  if (s.start !== s.end || s.start === 0) return null;
  const v = s.value, at = s.start;
  const o = v[at - 1], c = v[at];
  if (o in PAIRS && PAIRS[o] === c && !escapedAt(v, at - 1)) return { value: v.slice(0, at - 1) + v.slice(at + 1), start: at - 1, end: at - 1 };
  return null;
}

/**
 * Enter keeps the indentation; between `{` and `}` it opens the pair over three lines; at the
 * end of a `\begin{env}` line whose environment is not closed yet it adds the `\end{env}` too.
 */
export function enter(s: Snapshot): Snapshot {
  const v = s.value;
  const before = v.slice(0, s.start), after = v.slice(s.end);
  const line = v.slice(lineStart(v, s.start), s.start);
  const ind = indentOf(line);
  if (before.endsWith('{') && after.startsWith('}') && !escapedAt(v, s.start - 1)) {
    const mid = '\n' + ind + INDENT;
    return { value: before + mid + '\n' + ind + after, start: before.length + mid.length, end: before.length + mid.length };
  }
  const m = /\\begin\{([^{}]+)\}(?:\[[^\]]*\]|\{[^{}]*\})*\s*$/.exec(line);
  if (m && /^\s*$/.test(after.slice(0, lineEnd(after, 0)))) {
    const env = m[1];
    const opens = (v.match(new RegExp('\\\\begin\\{' + escapeRe(env) + '\\}', 'g')) ?? []).length;
    const closes = (v.match(new RegExp('\\\\end\\{' + escapeRe(env) + '\\}', 'g')) ?? []).length;
    if (opens > closes) {
      const mid = '\n' + ind + INDENT;
      return { value: before + mid + '\n' + ind + '\\end{' + env + '}' + after, start: before.length + mid.length, end: before.length + mid.length };
    }
  }
  const nl = '\n' + ind;
  return { value: before + nl + after, start: before.length + nl.length, end: before.length + nl.length };
}
const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** the lines a selection touches: [from, to) offsets of whole lines */
function lineSpan(v: string, s: Snapshot): [number, number] {
  const from = lineStart(v, Math.min(s.start, s.end));
  let last = Math.max(s.start, s.end);
  if (last > from && v[last - 1] === '\n' && s.start !== s.end) last--;   // a selection ending at a line start does not include that line
  return [from, lineEnd(v, last)];
}
/** map every line of the span through `f`, keeping the selection on the same lines */
function mapLines(s: Snapshot, f: (line: string) => string): Snapshot {
  const v = s.value;
  const [from, to] = lineSpan(v, s);
  const lines = v.slice(from, to).split('\n');
  const out = lines.map(f);
  const text = out.join('\n');
  const value = v.slice(0, from) + text + v.slice(to);
  const d0 = out[0].length - lines[0].length;
  const dAll = text.length - (to - from);
  const clamp = (x: number) => Math.max(from, Math.min(x, from + text.length));
  const sel = s.start === s.end ? { start: clamp(s.start + d0), end: clamp(s.start + d0) } : { start: clamp(s.start + (s.start === from ? 0 : d0)), end: clamp(s.end + dAll) };
  return { value, ...sel };
}

/** Tab with a multi-line selection / Ctrl+]: indent; Shift+Tab / Ctrl+[: outdent */
export function indentLines(s: Snapshot, dir: 1 | -1): Snapshot {
  return mapLines(s, l => (dir > 0 ? (l ? INDENT + l : l) : l.startsWith(INDENT) ? l.slice(INDENT.length) : l.replace(/^[ \t]/, '')));
}

/** Ctrl+/: comment the lines out with `% ` at their common indentation, or back in when they all are */
export function toggleComment(s: Snapshot): Snapshot {
  const v = s.value;
  const [from, to] = lineSpan(v, s);
  const lines = v.slice(from, to).split('\n');
  const content = lines.filter(l => l.trim());
  const allCommented = content.length > 0 && content.every(l => /^\s*%/.test(l));
  if (allCommented) return mapLines(s, l => l.replace(/^(\s*)%\s?/, '$1'));
  const col = Math.min(...content.map(l => indentOf(l).length));
  return mapLines(s, l => (l.trim() ? l.slice(0, col) + '% ' + l.slice(col) : l));
}

/** Alt+↑ / Alt+↓: move the selected lines; with copy: Shift+Alt — duplicate them instead */
export function moveLines(s: Snapshot, dir: 1 | -1, copy = false): Snapshot | null {
  const v = s.value;
  const [from, to] = lineSpan(v, s);
  const block = v.slice(from, to);
  if (copy) {
    const value = v.slice(0, to) + '\n' + block + v.slice(to);
    const d = dir > 0 ? block.length + 1 : 0;
    return { value, start: s.start + d, end: s.end + d };
  }
  if (dir < 0) {
    if (from === 0) return null;
    const pFrom = lineStart(v, from - 1);
    const prev = v.slice(pFrom, from - 1);
    const value = v.slice(0, pFrom) + block + '\n' + prev + v.slice(to);
    const d = -(prev.length + 1);
    return { value, start: s.start + d, end: s.end + d };
  }
  if (to >= v.length) return null;
  const nEnd = lineEnd(v, to + 1);
  const next = v.slice(to + 1, nEnd);
  const value = v.slice(0, from) + next + '\n' + block + v.slice(nEnd);
  const d = next.length + 1;
  return { value, start: s.start + d, end: s.end + d };
}

/** Ctrl+Shift+K: delete the lines of the selection */
export function deleteLines(s: Snapshot): Snapshot {
  const v = s.value;
  const [from, to] = lineSpan(v, s);
  // the last line goes together with the line break before it
  const a = to < v.length ? from : Math.max(0, from - 1);
  const value = to < v.length ? v.slice(0, from) + v.slice(to + 1) : v.slice(0, a);
  const col = Math.min(s.start, s.end) - from;
  const at = Math.min(a + col, lineEnd(value, a));
  return { value, start: at, end: at };
}

/** Home: to the first non-blank character of the line, or to column 0 when already there */
export function smartHome(s: Snapshot): Snapshot {
  const v = s.value;
  const ls = lineStart(v, s.start);
  const first = ls + indentOf(v.slice(ls, lineEnd(v, s.start))).length;
  const at = s.start === first ? ls : first;
  return { value: v, start: at, end: at };
}

/**
 * The editing keys of the plain-text editors; returns the new state to put into the textarea (the
 * caller records it for undo and stores the value), or null when the key is not one of ours.
 */
export function editingKey(e: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }, el: { value: string; selectionStart: number; selectionEnd: number }, mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)): Snapshot | null {
  const s: Snapshot = { value: el.value, start: el.selectionStart, end: el.selectionEnd };
  const mod = mac ? e.metaKey : e.ctrlKey;
  const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
  if (plain && e.key.length === 1) return e.shiftKey && !(e.key in PAIRS) && !CLOSERS.has(e.key) ? null : typeChar(s, e.key);
  if (plain && e.key === 'Backspace') return backspace(s);
  if (plain && !e.shiftKey && e.key === 'Enter') return enter(s);
  if (plain && e.key === 'Tab') {
    const multi = s.start !== s.end && s.value.slice(s.start, s.end).includes('\n');
    if (e.shiftKey) return indentLines(s, -1);
    if (multi) return indentLines(s, 1);
    return { value: s.value.slice(0, s.start) + INDENT + s.value.slice(s.end), start: s.start + INDENT.length, end: s.start + INDENT.length };
  }
  if (plain && !e.shiftKey && e.key === 'Home') return smartHome(s);
  if (mod && !e.altKey && (e.key === '/' || (e.key === '7' && !e.shiftKey && !mac))) return toggleComment(s);   // '/' is Shift+7 on some layouts
  if (mod && !e.altKey && !e.shiftKey && e.key === ']') return indentLines(s, 1);
  if (mod && !e.altKey && !e.shiftKey && e.key === '[') return indentLines(s, -1);
  if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') return deleteLines(s);
  if (e.altKey && !mod && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) return moveLines(s, e.key === 'ArrowDown' ? 1 : -1, e.shiftKey);
  return null;
}

/** put a snapshot into a textarea */
export function applySnapshot(el: HTMLTextAreaElement, s: Snapshot): void {
  el.value = s.value;
  el.setSelectionRange(s.start, s.end);
}

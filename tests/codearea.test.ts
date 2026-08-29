/** Undo stack and bracket matching of the plain-text editors (packages/client/src/app/codearea.ts). */
import { describe, it, expect } from 'vitest';
import { UndoStack, undoRedoKey, matchBrackets, typeChar, backspace, enter, indentLines, toggleComment, moveLines, deleteLines, smartHome, editingKey } from '../packages/client/src/app/codearea.ts';

const snap = (value: string, at = value.length) => ({ value, start: at, end: at });

describe('undo stack', () => {
  it('coalesces a run of typing into one step, broken at whitespace and pauses', () => {
    const u = new UndoStack(snap(''));
    let t = 0;
    for (const ch of 'hello world') { t += 50; u.record(snap((u as any).last.value + ch), t); }
    const s1 = u.undo(snap('hello world'));
    expect(s1?.value).toBe('hello ');
    expect(s1?.start).toBe(6);
    const s2 = u.undo(snap('hello '));
    expect(s2?.value).toBe('hello');
    expect(u.undo(snap('hello'))?.value).toBe('');
    expect(u.undo(snap(''))).toBeNull();
    // redo walks forward again
    expect(u.redo(snap(''))?.value).toBe('hello');
    expect(u.redo(snap('hello'))?.value).toBe('hello ');
    expect(u.redo(snap('hello '))?.value).toBe('hello world');
    expect(u.redo(snap('hello world'))).toBeNull();
    // a pause starts a new step
    u.record(snap('hello worldX'), 5000);
    u.record(snap('hello worldXY'), 5010);
    expect(u.undo(snap('hello worldXY'))?.value).toBe('hello world');
  });

  it('a new edit after undo drops the redo history; deletions coalesce too', () => {
    const u = new UndoStack(snap('abc'));
    u.record(snap('abcd'), 1);
    u.undo(snap('abcd'));
    expect(u.canRedo).toBe(true);
    u.record(snap('abcX'), 2);
    expect(u.canRedo).toBe(false);
    u.record(snap('abc', 3), 3);
    u.record(snap('ab', 2), 4);
    u.record(snap('a', 1), 5);
    const s = u.undo(snap('a', 1));
    expect(s?.value).toBe('abcX');
    expect(s?.start).toBe(4);   // where the deleting happened
  });

  it('a big replacement is its own step with the cursor at the change', () => {
    const u = new UndoStack(snap('one two three'));
    u.record(snap('one 2 three', 5), 1);
    const s = u.undo(snap('one 2 three', 5));
    expect(s?.value).toBe('one two three');
    expect(s?.start).toBe(7);
  });

  it('recognises the keys per platform', () => {
    const ev = (key: string, m: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...m });
    expect(undoRedoKey(ev('z', { ctrlKey: true }), false)).toBe('undo');
    expect(undoRedoKey(ev('Z', { ctrlKey: true, shiftKey: true }), false)).toBe('redo');
    expect(undoRedoKey(ev('y', { ctrlKey: true }), false)).toBe('redo');
    expect(undoRedoKey(ev('z', { metaKey: true }), true)).toBe('undo');
    expect(undoRedoKey(ev('z', { ctrlKey: true }), true)).toBeNull();
    expect(undoRedoKey(ev('y', { metaKey: true }), true)).toBeNull();
    expect(undoRedoKey(ev('z', { ctrlKey: true, altKey: true }), false)).toBeNull();
  });
});

describe('bracket matching', () => {
  const src = '\\frac{a}{b} % {not}\n\\left\\{ x \\right\\} [1,(2)]';
  it('finds the partner of the bracket next to the cursor, comments skipped', () => {
    expect(matchBrackets(src, 6)).toEqual({ open: 5, close: 7, len: 1, kind: 'adjacent' });   // after "{"
    expect(matchBrackets(src, 8)).toEqual({ open: 5, close: 7, len: 1, kind: 'adjacent' });   // after "}"
    expect(matchBrackets(src, 5)).toEqual({ open: 5, close: 7, len: 1, kind: 'adjacent' });   // before "{"
    const i = src.indexOf('[1');
    expect(matchBrackets(src, i)).toEqual({ open: i, close: src.indexOf(']'), len: 1, kind: 'adjacent' });
    expect(matchBrackets(src, src.indexOf('(2') + 1)).toEqual({ open: src.indexOf('(2'), close: src.indexOf('(2') + 2, len: 1, kind: 'adjacent' });
  });
  it('matches \\{ with \\} and not with a plain brace', () => {
    const o = src.indexOf('\\{'), c = src.indexOf('\\}');
    expect(matchBrackets(src, o + 2)).toEqual({ open: o, close: c, len: 2, kind: 'adjacent' });
    expect(matchBrackets('{ \\{ }', 1)).toEqual({ open: 0, close: 5, len: 1, kind: 'adjacent' });
  });
  it('shows the enclosing pair when the cursor is inside', () => {
    const t = '\\textbf{some [x] words} after';
    expect(matchBrackets(t, 12)).toEqual({ open: 7, close: 22, len: 1, kind: 'enclosing' });
    expect(matchBrackets(t, 13)).toEqual({ open: 13, close: 15, len: 1, kind: 'adjacent' });
    expect(matchBrackets(t, 26)).toBeNull();
    // brackets in a comment do not count
    expect(matchBrackets('% {\nabc', 6)).toBeNull();
  });
  it('gives nothing for an unbalanced bracket', () => {
    expect(matchBrackets('a { b', 3)).toBeNull();
    expect(matchBrackets('a } b', 3)).toBeNull();
  });
});

describe('editing conveniences', () => {
  const s = (value: string, start: number, end = start) => ({ value, start, end });

  it('auto-closes brackets before whitespace / closers / the end, wraps a selection, steps over a closer', () => {
    expect(typeChar(s('a ', 2), '{')).toEqual(s('a {}', 3));
    expect(typeChar(s('a b', 2), '{')).toBeNull();                 // before a word: no pair
    expect(typeChar(s('a }', 2), '(')).toEqual(s('a ()}', 3));
    expect(typeChar(s('\\', 1), '{')).toBeNull();                  // \{ is a literal brace
    expect(typeChar(s('a {}', 3), '}')).toEqual(s('a {}', 4));     // over the closer
    expect(typeChar(s('one two', 0, 3), '[')).toEqual(s('[one] two', 1, 4));
    expect(typeChar(s('x ', 2), '$')).toEqual(s('x $$', 3));
    expect(typeChar(s('x $$', 3), '$')).toEqual(s('x $$', 4));
    expect(typeChar(s('x$', 2), '$')).toBeNull();                  // after a word character: a display formula being typed, say
    expect(typeChar(s('a ', 2), 'x')).toBeNull();
  });
  it('Backspace inside an empty pair removes both', () => {
    expect(backspace(s('f{}', 2))).toEqual(s('f', 1));
    expect(backspace(s('f{x}', 2))).toBeNull();
    expect(backspace(s('\\{}', 2))).toBeNull();
  });
  it('Enter keeps the indentation, opens a brace pair and completes \\begin with \\end', () => {
    expect(enter(s('  foo', 5))).toEqual(s('  foo\n  ', 8));
    expect(enter(s('  \\frac{}', 8))).toEqual(s('  \\frac{\n    \n  }', 13));
    expect(enter(s('\\begin{itemize}', 15))).toEqual(s('\\begin{itemize}\n  \n\\end{itemize}', 18));
    expect(enter(s('  \\begin{figure}[t]', 19))).toEqual(s('  \\begin{figure}[t]\n    \n  \\end{figure}', 24));
    // already closed further down: a plain line break
    expect(enter(s('\\begin{itemize}\n\\end{itemize}', 15))).toEqual(s('\\begin{itemize}\n\n\\end{itemize}', 16));
  });
  it('indents / outdents the selected lines and toggles % comments', () => {
    const v = 'a\nb\nc';
    expect(indentLines(s(v, 0, 3), 1)).toEqual(s('  a\n  b\nc', 0, 7));
    expect(indentLines(s('  a\n  b', 2, 6), -1)).toEqual(s('a\nb', 0, 2));
    expect(toggleComment(s(v, 2, 3))).toEqual(s('a\n% b\nc', 2, 5));   // a selection from column 0 takes the marker in, like VS Code
    expect(toggleComment(s('a\n% b\n%c', 2, 8))).toEqual(s('a\nb\nc', 2, 5));
    expect(toggleComment(s('  x\n\n  y', 0, 8))).toEqual(s('  % x\n\n  % y', 0, 12));
  });
  it('moves, copies and deletes lines', () => {
    expect(moveLines(s('a\nb\nc', 2), 1)).toEqual(s('a\nc\nb', 4));
    expect(moveLines(s('a\nb\nc', 2), -1)).toEqual(s('b\na\nc', 0));
    expect(moveLines(s('a\nb\nc', 0), -1)).toBeNull();
    expect(moveLines(s('a\nb\nc', 2), 1, true)).toEqual(s('a\nb\nb\nc', 4));
    expect(deleteLines(s('a\nb\nc', 2))).toEqual(s('a\nc', 2));
    expect(deleteLines(s('a\nb', 3))).toEqual(s('a', 1));
    expect(deleteLines(s('a\nb\nc\nd', 2, 5))).toEqual(s('a\nd', 2));
  });
  it('Home goes to the first non-blank character first', () => {
    expect(smartHome(s('  ab', 4))).toEqual(s('  ab', 2));
    expect(smartHome(s('  ab', 2))).toEqual(s('  ab', 0));
  });
  it('maps the keys', () => {
    const ev = (key: string, m: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...m });
    const el = (value: string, start: number, end = start) => ({ value, selectionStart: start, selectionEnd: end });
    expect(editingKey(ev('{'), el('a ', 2), false)).toEqual(s('a {}', 3));
    expect(editingKey(ev('Tab'), el('a', 1), false)).toEqual(s('a  ', 3));
    expect(editingKey(ev('Tab'), el('a\nb', 0, 3), false)).toEqual(s('  a\n  b', 0, 7));
    expect(editingKey(ev('Tab', { shiftKey: true }), el('  a', 3), false)).toEqual(s('a', 1));
    expect(editingKey(ev('/', { ctrlKey: true }), el('a', 0), false)).toEqual(s('% a', 2));
    expect(editingKey(ev('/', { metaKey: true }), el('a', 0), true)).toEqual(s('% a', 2));
    expect(editingKey(ev('ArrowDown', { altKey: true }), el('a\nb', 0), false)).toEqual(s('b\na', 2));
    expect(editingKey(ev('k', { ctrlKey: true, shiftKey: true }), el('a\nb', 0), false)).toEqual(s('b', 0));
    expect(editingKey(ev('x'), el('a', 1), false)).toBeNull();
    expect(editingKey(ev('s', { ctrlKey: true }), el('a', 1), false)).toBeNull();
  });
});

// @vitest-environment happy-dom
/**
 * LyX .bind files as OverLyX shortcuts (client app/lyxbind.ts): the file format, LyX's key names, the
 * functions that have a command here, what is left out — and that OverLyX's default keys stay LyX's
 * own (cua.bind), but for the few it deliberately gives other work.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseBind, lyxKey, commandFor, planBind, ctrlIPlan, ctrlINow, CTRLI_COMMANDS } from '../packages/client/src/app/lyxbind.ts';
import { LYX_LIB } from './lyxlib';

describe('parseBind', () => {
  it('reads \\bind, \\unbind and \\bind_file, skips comments', () => {
    const r = parseBind('# my keys\n\\bind_file cua\n\\bind "C-b"   "font-bold"  # bold\n\\unbind "C-i" "inset-toggle"\n\\bind "M-p s" "layout Standard"\n');
    expect(r.includes).toEqual(['cua']);
    expect(r.binds).toEqual([
      { line: 3, keys: 'C-b', lfun: 'font-bold', unbind: false },
      { line: 4, keys: 'C-i', lfun: 'inset-toggle', unbind: true },
      { line: 5, keys: 'M-p s', lfun: 'layout Standard', unbind: false },
    ]);
  });
});

describe('lyxKey', () => {
  it('turns LyX key names into OverLyX shortcuts', () => {
    expect(lyxKey('C-b')).toBe('Ctrl+B');
    expect(lyxKey('C-S-z')).toBe('Ctrl+Shift+Z');
    expect(lyxKey('M-minus')).toBe('Alt+-');
    expect(lyxKey('~S-M-period')).toBe('Alt+.');
    expect(lyxKey('C-M-space')).toBe('Ctrl+Alt+Space');
    expect(lyxKey('C-Up')).toBe('Ctrl+↑');
    expect(lyxKey('C-Return')).toBe('Ctrl+Enter');
    expect(lyxKey('F5')).toBe('F5');
  });
  it('leaves out chords and plain keys', () => {
    expect(lyxKey('M-p s')).toBeNull();
    expect(lyxKey('Return')).toBeNull();
    expect(lyxKey('S-Tab')).toBeNull();
  });
});

const IDS = ['Edit ▸ Text Style ▸ Bold', 'Edit ▸ Text Style ▸ Noun (small caps)', 'Edit ▸ Text Style ▸ Size: scriptsize', 'Edit ▸ Paragraph style ▸ Section',
  'Edit ▸ Paragraph style ▸ Itemize (bullet list — or type “- ”)', 'Insert ▸ Math ▸ Inline formula', 'Insert ▸ Table', 'Edit ▸ Table ▸ Add row above', 'Insert ▸ Citation'];

describe('commandFor', () => {
  it('finds the command of a LyX function by its menu path', () => {
    expect(commandFor('font-bold', IDS)).toBe('Edit ▸ Text Style ▸ Bold');
    expect(commandFor('font-noun', IDS)).toBe('Edit ▸ Text Style ▸ Noun (small caps)');
    expect(commandFor('font-size script', IDS)).toBe('Edit ▸ Text Style ▸ Size: scriptsize');
    expect(commandFor('layout Section', IDS)).toBe('Edit ▸ Paragraph style ▸ Section');
    expect(commandFor('layout Itemize', IDS)).toBe('Edit ▸ Paragraph style ▸ Itemize (bullet list — or type “- ”)');
    expect(commandFor('tabular-insert', IDS)).toBe('Insert ▸ Table');   // not the Table submenu of Edit
    expect(commandFor('dialog-show-new-inset citation', IDS)).toBe('Insert ▸ Citation');
    expect(commandFor('char-forward', IDS)).toBeNull();
  });
});

describe('planBind', () => {
  it('sets what differs from the defaults, unbinds, and says what it left out', () => {
    const entries = [{ id: 'Edit ▸ Text Style ▸ Bold', shortcut: 'Ctrl+B' }, { id: 'Insert ▸ Math ▸ Inline formula', shortcut: 'Ctrl+M' }, { id: 'Insert ▸ Citation', shortcut: 'Ctrl+Shift+C' }, { id: 'Edit ▸ Paragraph style ▸ Section', shortcut: 'Ctrl+2' }];
    const plan = planBind([
      '\\bind_file emacs',
      '\\bind "C-b" "font-bold"',            // LyX's default as well: nothing to set
      '\\bind "C-S-b" "font-bold"',          // the user's own key
      '\\bind "M-c" "dialog-show-new-inset citation"',
      '\\unbind "C-m" "math-mode"',
      '\\bind "M-p 2" "layout Section"',     // a chord
      '\\bind "C-f" "char-forward"',         // an editing function
    ].join('\n'), entries);
    expect(plan.set).toEqual([
      { id: 'Edit ▸ Text Style ▸ Bold', key: 'Ctrl+Shift+B', lfun: 'font-bold' },
      { id: 'Insert ▸ Citation', key: 'Alt+C', lfun: 'dialog-show-new-inset citation' },
      { id: 'Insert ▸ Math ▸ Inline formula', key: null, lfun: 'math-mode' },
    ]);
    expect(plan.skipped.map(s => s.lfun)).toEqual(['layout Section', 'char-forward']);
    expect(plan.includes).toEqual(['emacs']);
  });
});

describe('the defaults are LyX’s', () => {
  const cua = path.join(LYX_LIB, 'bind', 'cua.bind');
  it.skipIf(!existsSync(cua))('every key cua.bind gives a command OverLyX has is that command’s default (but for the deliberate ones)', async () => {
    const { documentMenus } = await import('../packages/client/src/app/documentMenus.ts');
    const { collectEntries } = await import('../packages/client/src/app/MenuBar.tsx');
    const menus = documentMenus({ view: null, meta: null, run: () => {}, runView: () => {}, setDialog: () => {}, setFindOpen: () => {}, textColor: null, tracking: false, changeInfo: null, toggleTracking: () => {}, toggleCellLine: () => {}, healthItems: [], reloadMetadata: () => {} } as never);
    const entries = collectEntries(Object.values(menus).filter(Boolean) as never);
    const plan = planBind(readFileSync(cua, 'utf8'), entries);
    // what OverLyX gives other work: Ctrl+I italic (LyX: open/close inset — LyX's meaning can be chosen
    // in Settings ▸ Shortcuts, Classic; a .bind giving it to inset-toggle does the same), Ctrl+Shift+P the command
    // palette (LyX: typewriter), Alt+- an em dash (LyX: hyphenation point); and LyX's second keys
    // (Ctrl+Alt+B bold, Ctrl+Shift+Z redo, Ctrl+Shift+F find, Ctrl+Alt+I inset settings), Ctrl+Alt+Space
    const allowed = new Set(['font-bold', 'font-typewriter', 'dialog-show findreplaceadv', 'inset-toggle', 'inset-settings', 'redo', 'specialchar-insert hyphenation', 'space-insert normal']);
    expect(plan.set.filter(s => !allowed.has(s.lfun))).toEqual([]);
  }, 60000);
});

describe('Ctrl+I: italic or LyX\'s open / close the inset', () => {
  const ids = ['Edit ▸ Text Style ▸ Bold', ...CTRLI_COMMANDS];
  it('LyX\'s meaning gives Ctrl+I to inset-toggle and takes it from italic; italic puts both defaults back', () => {
    expect(CTRLI_COMMANDS).toEqual(['Edit ▸ Text Style ▸ Italic', 'Edit ▸ Open/close inset']);
    expect(ctrlIPlan('inset', ids)).toEqual([{ id: 'Edit ▸ Open/close inset', key: 'Ctrl+I' }, { id: 'Edit ▸ Text Style ▸ Italic', key: null }]);
    expect(ctrlIPlan('italic', ids)).toEqual([{ id: 'Edit ▸ Open/close inset', key: undefined }, { id: 'Edit ▸ Text Style ▸ Italic', key: undefined }]);
    expect(ctrlIPlan('inset', ['Edit ▸ Text Style ▸ Bold'])).toEqual([]);
  });
  it('what Ctrl+I does with the shortcuts in force', () => {
    expect(ctrlINow({}, ids)).toBe('italic');
    expect(ctrlINow({ 'Edit ▸ Open/close inset': 'Ctrl+I', 'Edit ▸ Text Style ▸ Italic': null }, ids)).toBe('inset');
    expect(ctrlINow({ 'Edit ▸ Open/close inset': 'Ctrl+Alt+J' }, ids)).toBe('italic');
    // a .bind file's \bind "C-i" "inset-toggle" (LyX's cua.bind has it) lands as LyX's meaning
    const plan = planBind('\\bind "C-i" "inset-toggle"\n', [{ id: 'Edit ▸ Open/close inset', shortcut: 'Ctrl+Alt+I' }, { id: 'Edit ▸ Text Style ▸ Italic', shortcut: 'Ctrl+I' }]);
    expect(ctrlINow(Object.fromEntries(plan.set.map(b => [b.id, b.key])), ids)).toBe('inset');
  });
});

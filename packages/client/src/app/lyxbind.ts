/**
 * LyX's key binding files (.bind — a LyX user directory's `bind/user.bind`, or one of LyX's own such
 * as emacs.bind) as OverLyX shortcuts. OverLyX's defaults already are LyX's (cua.bind + menus.bind +
 * math.bind, editor/keymap.ts), so a file only has to carry what the user changed: each
 * `\bind "key" "function"` whose LyX function has a command here becomes that command's shortcut
 * (keybindings.ts, kept in the browser and the account), `\unbind` takes the command's default key
 * away. Not taken, and said so: two-key chords, plain keys without Ctrl / Alt (editing keys), the
 * cursor and editing functions (fixed in the editor), and functions OverLyX has no command for.
 */
import { canonical } from './keybindings';

export interface BindLine { line: number; keys: string; lfun: string; unbind: boolean }

/** the `\bind` / `\unbind` lines of a .bind file, and the files it pulls in (`\bind_file`) */
export function parseBind(text: string): { binds: BindLine[]; includes: string[] } {
  const binds: BindLine[] = [], includes: string[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const s = raw.trim();
    if (!s || s.startsWith('#')) return;
    const inc = /^\\bind_file\s+"?([^"\s]+)"?/.exec(s);
    if (inc) { includes.push(inc[1]); return; }
    const m = /^\\(un)?bind\s+"([^"]*)"\s+"(.*)"\s*(?:#.*)?$/.exec(s);
    if (m) binds.push({ line: i + 1, keys: m[2].trim(), lfun: m[3].trim().replace(/\s+/g, ' '), unbind: !!m[1] });
  });
  return { binds, includes };
}

/** LyX's (Qt's) key names → what keybindings.ts understands */
const KEYS: Record<string, string> = {
  Return: 'Enter', KP_Enter: 'Enter', Enter: 'Enter', BackSpace: 'Backspace', Delete: 'Delete', KP_Delete: 'Delete', Tab: 'Tab', ISO_Left_Tab: 'Tab',
  Escape: 'Esc', space: 'Space', Up: 'Up', Down: 'Down', Left: 'Left', Right: 'Right', Prior: 'PageUp', Next: 'PageDown', Page_Up: 'PageUp', Page_Down: 'PageDown',
  Home: 'Home', End: 'End', Insert: 'Insert',
  period: '.', comma: ',', minus: '-', plus: '+', equal: '=', slash: '/', backslash: '\\', apostrophe: "'", quotedbl: '"', semicolon: ';', colon: ':',
  bracketleft: '[', bracketright: ']', braceleft: '{', braceright: '}', parenleft: '(', parenright: ')', less: '<', greater: '>', asterisk: '*',
  underscore: '_', asciicircum: '^', asciitilde: '~', grave: '`', numbersign: '#', dollar: '$', percent: '%', ampersand: '&', at: '@', exclam: '!',
  question: '?', bar: '|',
};

/**
 * A LyX key ("C-S-x", "M-Return", "~S-M-period") as a canonical OverLyX shortcut; null for a chord
 * ("M-p s"), a plain key without Ctrl / Alt / an F-key (an editing key), or a key we cannot name.
 */
export function lyxKey(keys: string): string | null {
  if (/\s/.test(keys.trim())) return null;   // a chord: two keys one after the other
  let rest = keys.trim();
  const mods = new Set<string>();
  for (;;) {
    const m = /^(~?)([CSMA])-(.+)$/.exec(rest);
    if (!m) break;
    rest = m[3];
    if (m[1]) continue;   // "~S-": shift either way
    mods.add(m[2] === 'C' ? 'Ctrl' : m[2] === 'S' ? 'Shift' : 'Alt');
  }
  const key = KEYS[rest] ?? (/^F([1-9]|1[0-2])$/.test(rest) || [...rest].length === 1 ? rest : null);
  if (!key) return null;
  if (!mods.has('Ctrl') && !mods.has('Alt') && !/^F\d+$/.test(key)) return null;
  return canonical([...mods, key].join('+'));
}

/** LyX functions → the OverLyX command (menu path, a prefix of its label is enough) */
const LFUNS: Record<string, string> = {
  'undo': 'Edit ▸ Undo', 'redo': 'Edit ▸ Redo',
  'dialog-show findreplace': 'Edit ▸ Find & Replace', 'dialog-show findreplaceadv': 'Edit ▸ Find & Replace', 'dialog-toggle findreplaceadv': 'Edit ▸ Find & Replace',
  'inset-select-all': 'Edit ▸ Select inset / all',
  'font-emph': 'Edit ▸ Text Style ▸ Emphasized', 'font-italic': 'Edit ▸ Text Style ▸ Italic', 'font-bold': 'Edit ▸ Text Style ▸ Bold', 'font-boldsymbol': 'Edit ▸ Text Style ▸ Bold',
  'font-noun': 'Edit ▸ Text Style ▸ Noun', 'font-underline': 'Edit ▸ Text Style ▸ Underline', 'font-strikeout': 'Edit ▸ Text Style ▸ Strikeout',
  'font-typewriter': 'Edit ▸ Text Style ▸ Typewriter', 'font-sans': 'Edit ▸ Text Style ▸ Sans serif', 'font-default': 'Edit ▸ Text Style ▸ Reset font',
  'font-underunderline': 'Edit ▸ Text Style ▸ Double underline', 'font-underwave': 'Edit ▸ Text Style ▸ Wavy underline',
  'layout-paragraph': 'Edit ▸ Paragraph ▸ Paragraph settings', 'depth-increment': 'Edit ▸ Paragraph ▸ Increase depth', 'depth-decrement': 'Edit ▸ Paragraph ▸ Decrease depth',
  'paragraph-move-up': 'Edit ▸ Paragraph ▸ Move paragraph up', 'paragraph-move-down': 'Edit ▸ Paragraph ▸ Move paragraph down',
  'outline-up': 'Edit ▸ Paragraph ▸ Move section up', 'outline-down': 'Edit ▸ Paragraph ▸ Move section down',
  'outline-in': 'Edit ▸ Paragraph ▸ Demote section', 'outline-out': 'Edit ▸ Paragraph ▸ Promote section',
  'changes-track': 'Edit ▸ Track Changes ▸ Track changes', 'all-changes-accept': 'Edit ▸ Track Changes ▸ Accept all changes', 'all-changes-reject': 'Edit ▸ Track Changes ▸ Reject all changes',
  'inset-settings': 'Edit ▸ Inset settings', 'inset-toggle': 'Edit ▸ Open/close inset', 'math-display': 'Insert ▸ Math ▸ Display formula',
  'math-mode': 'Insert ▸ Math ▸ Inline formula', 'math-mode on': 'Insert ▸ Math ▸ Inline formula', 'math-matrix': 'Insert ▸ Math ▸ Matrix', 'math-delim': 'Insert ▸ Math ▸ Delimiters',
  'math-macro': 'Insert ▸ Math ▸ Math macro definition',
  'specialchar-insert dots': 'Insert ▸ Special Character ▸ Ellipsis', 'specialchar-insert end-of-sentence-period': 'Insert ▸ Special Character ▸ End of sentence',
  'specialchar-insert nobreakdash': 'Insert ▸ Special Character ▸ Non-breaking dash', 'specialchar-insert hyphenation': 'Insert ▸ Special Character ▸ Hyphenation point',
  'specialchar-insert ligature-break': 'Insert ▸ Special Character ▸ Ligature break', 'specialchar-insert slash': 'Insert ▸ Special Character ▸ Breakable slash',
  'specialchar-insert menu-separator': 'Insert ▸ Special Character ▸ Menu separator',
  'newline-insert newline': 'Insert ▸ Formatting ▸ Line break', 'newline-insert linebreak': 'Insert ▸ Formatting ▸ Justified line break',
  'newpage-insert newpage': 'Insert ▸ Formatting ▸ New page', 'newpage-insert pagebreak': 'Insert ▸ Formatting ▸ Page break', 'newpage-insert clearpage': 'Insert ▸ Formatting ▸ Clear page',
  'space-insert protected': 'Insert ▸ Formatting ▸ Protected space', 'space-insert thin': 'Insert ▸ Formatting ▸ Thin space', 'space-insert normal': 'Insert ▸ Formatting ▸ Interword space',
  'space-insert quad': 'Insert ▸ Formatting ▸ Quad space', 'space-insert hfill': 'Insert ▸ Formatting ▸ Horizontal fill',
  'float-insert figure': 'Insert ▸ Float ▸ Figure', 'float-insert table': 'Insert ▸ Float ▸ Table', 'float-insert algorithm': 'Insert ▸ Float ▸ Algorithm',
  'note-insert': 'Insert ▸ Note ▸ LyX note', 'note-insert Note': 'Insert ▸ Note ▸ LyX note', 'note-insert Comment': 'Insert ▸ Note ▸ Comment', 'note-insert Greyedout': 'Insert ▸ Note ▸ Greyed out',
  'dialog-show-new-inset graphics': 'Insert ▸ Graphics', 'tabular-insert': 'Insert ▸ Table', 'dialog-show-new-inset tabular': 'Insert ▸ Table', 'caption-insert': 'Insert ▸ Caption',
  'label-insert': 'Insert ▸ Label', 'dialog-show-new-inset label': 'Insert ▸ Label', 'dialog-show-new-inset ref': 'Insert ▸ Cross-reference',
  'dialog-show-new-inset citation': 'Insert ▸ Citation', 'citation-insert': 'Insert ▸ Citation', 'href-insert': 'Insert ▸ Link', 'dialog-show-new-inset href': 'Insert ▸ Link',
  'footnote-insert': 'Insert ▸ Footnote', 'marginalnote-insert': 'Insert ▸ Marginal note', 'index-insert': 'Insert ▸ Index entry',
  'argument-insert': 'Insert ▸ Short title', 'ert-insert': 'Insert ▸ TeX code', 'listing-insert': 'Insert ▸ Program listing', 'box-insert': 'Insert ▸ Box',
  'branch-insert': 'Insert ▸ Branch', 'dialog-show-new-inset include': 'Insert ▸ Child document', 'toc-insert': 'Insert ▸ Table of contents',
  'dialog-show document': 'Document ▸ Settings', 'appendix': 'Document ▸ Start Appendix Here', 'statistics': 'Document ▸ Statistics',
  'buffer-view': 'File ▸ Export ▸ PDF', 'buffer-update': 'File ▸ Export ▸ PDF', 'buffer-view pdf2': 'File ▸ Export ▸ PDF', 'buffer-update pdf2': 'File ▸ Export ▸ PDF',
  'buffer-new': 'File ▸ New', 'file-open': 'File ▸ Open', 'dialog-toggle toc': 'View ▸ Outline', 'dialog-show toc': 'View ▸ Outline',
  'buffer-begin': 'Navigate ▸ Beginning of document', 'buffer-end': 'Navigate ▸ End of document', 'forward-search': 'Navigate ▸ Sync to PDF',
  'dialog-show spellchecker': 'Tools ▸ Spell checking',
};
const SIZES: Record<string, string> = { tiny: 'tiny', script: 'scriptsize', footnote: 'footnotesize', small: 'small', normal: 'normal', large: 'large', larger: 'larger', largest: 'largest', huge: 'huge', giant: 'giant', huger: 'giant' };

/** the command of a LyX function among the menus' commands (`ids`), or null */
export function commandFor(lfun: string, ids: string[]): string | null {
  const low = ids.map(i => i.toLowerCase());
  const find = (path: string) => {
    const p = path.toLowerCase();
    let i = low.indexOf(p);
    if (i < 0) i = low.findIndex(x => x.startsWith(p + ' (') || x.startsWith(p + '*') || (x.startsWith(p + ' ') && !x.startsWith(p + ' ▸')));
    return i < 0 ? null : ids[i];
  };
  if (LFUNS[lfun]) return find(LFUNS[lfun]);
  const size = /^font-size (\w+)$/.exec(lfun);
  if (size && SIZES[size[1]]) return find('Edit ▸ Text Style ▸ Size: ' + SIZES[size[1]]);
  const layout = /^layout (.+)$/.exec(lfun);
  if (layout) return find('Edit ▸ Paragraph style ▸ ' + layout[1]);
  return null;
}

export interface BindPlan {
  /** the shortcuts to set: command id → canonical key (null: \unbind took the default away) */
  set: { id: string; key: string | null; lfun: string }[];
  /** what was left out, and why */
  skipped: { line: number; keys: string; lfun: string; why: string }[];
  /** \bind_file lines (other LyX keymaps this one builds on) */
  includes: string[];
}

/** what a .bind file asks for, against the commands there are (`entries`: id and default shortcut) */
export function planBind(text: string, entries: { id: string; shortcut?: string }[]): BindPlan {
  const { binds, includes } = parseBind(text);
  const ids = entries.map(e => e.id);
  const set = new Map<string, { id: string; key: string | null; lfun: string }>();
  const skipped: BindPlan['skipped'] = [];
  for (const b of binds) {
    const id = commandFor(b.lfun, ids);
    if (!id) { skipped.push({ line: b.line, keys: b.keys, lfun: b.lfun, why: 'no such command in OverLyX (or an editing key, fixed in the editor)' }); continue; }
    if (b.unbind) { set.set(id, { id, key: null, lfun: b.lfun }); continue; }
    const key = lyxKey(b.keys);
    if (!key) { skipped.push({ line: b.line, keys: b.keys, lfun: b.lfun, why: /\s/.test(b.keys.trim()) ? 'a chord of two keys (only single key combinations can be set)' : 'a plain key without Ctrl or Alt' }); continue; }
    // what LyX binds by default anyway needs no entry of its own
    const def = entries.find(e => e.id === id)?.shortcut;
    if (canonical(def) === key) continue;
    set.set(id, { id, key, lfun: b.lfun });
  }
  return { set: [...set.values()], skipped, includes };
}

/* ---- a file waiting to be applied: chosen on the landing page before the sign-in, or in Settings ----
   (the commands it binds are known once a document's menus are there: MenuBar applies it then) */

const PENDING = 'ol.lyxbind';
export const LYXBIND_EVENT = 'ol:lyxbind';

/** keep a chosen .bind file (or LyX `preferences`, for its \bind_file) until the menus can take it */
export function stashLyxBind(name: string, text: string): void {
  try { localStorage.setItem(PENDING, JSON.stringify({ name, text })); } catch { /* private window */ }
  window.dispatchEvent(new Event(LYXBIND_EVENT));
}
export function pendingLyxBind(): { name: string; text: string } | null {
  try { const v = JSON.parse(localStorage.getItem(PENDING) ?? 'null'); return v && typeof v.text === 'string' ? v : null; } catch { return null; }
}
export function clearPendingLyxBind(): void { try { localStorage.removeItem(PENDING); } catch { /* ignore */ } }

/** how many key bindings a file carries (the landing page's note before the sign-in) */
export function bindCount(text: string): number { return parseBind(text).binds.length; }

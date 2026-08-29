/**
 * Keyboard shortcuts are written once, LyX/Windows style ('Ctrl+Alt+Shift+O', 'Alt+P s', 'Ctrl+Z / Ctrl+Y');
 * on a Mac they are shown the way macOS menus show them (⌥⇧⌘O) — the bindings themselves already
 * use ⌘ for Ctrl there (ProseMirror's "Mod").
 */
export const isMacPlatform = (): boolean => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

const MAC_KEYS: Record<string, string> = { Enter: '↩', Backspace: '⌫', Delete: '⌦', Esc: '⎋', Escape: '⎋', Tab: '⇥' };
const MODIFIERS = new Set(['ctrl', 'alt', 'shift', 'cmd', 'meta', 'mod', 'control']);

function macToken(tok: string): string {
  if (!tok.includes('+') || tok === '+') return tok;
  let key: string, mods: string;
  if (tok.endsWith('++')) { key = '+'; mods = tok.slice(0, -2); }
  else { const i = tok.lastIndexOf('+'); key = tok.slice(i + 1); mods = tok.slice(0, i); }
  const parts = mods.split('+').filter(Boolean);
  if (!parts.length || !parts.every(p => MODIFIERS.has(p.toLowerCase()))) return tok;
  const has = (m: string) => parts.some(p => p.toLowerCase() === m);
  const cmd = has('ctrl') || has('cmd') || has('meta') || has('mod');
  return (has('control') ? '⌃' : '') + (has('alt') ? '⌥' : '') + (has('shift') ? '⇧' : '') + (cmd ? '⌘' : '') + (MAC_KEYS[key] ?? (key.length === 1 ? key.toUpperCase() : key));
}

/** platform rendering of a shortcut string; chords ('Alt+P s') and alternatives ('A / B') are handled part by part */
export function formatShortcut(s: string, mac = isMacPlatform()): string {
  if (!mac) return s;
  return s.split(' ').map(macToken).join(' ');
}

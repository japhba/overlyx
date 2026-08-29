/** Platform rendering of shortcut strings (packages/client/src/app/shortcuts.ts). */
import { describe, it, expect } from 'vitest';
import { formatShortcut } from '../packages/client/src/app/shortcuts.ts';

describe('formatShortcut', () => {
  it('is the identity off the Mac', () => {
    for (const s of ['Ctrl+Alt+Shift+O', 'Alt+P s', 'Ctrl+Z / Ctrl+Y', 'Ctrl++ / Ctrl+-']) expect(formatShortcut(s, false)).toBe(s);
  });
  it('uses ⌘ ⌥ ⇧ in macOS order on a Mac', () => {
    expect(formatShortcut('Ctrl+M', true)).toBe('⌘M');
    expect(formatShortcut('Ctrl+Alt+Shift+O', true)).toBe('⌥⇧⌘O');
    expect(formatShortcut('Alt+Shift+→ / ←', true)).toBe('⌥⇧→ / ←');
    expect(formatShortcut('Ctrl+Enter', true)).toBe('⌘↩');
    expect(formatShortcut('Ctrl+Space', true)).toBe('⌘Space');
  });
  it('keeps chords, alternatives and + keys readable', () => {
    expect(formatShortcut('Alt+P s/1/2/3', true)).toBe('⌥P s/1/2/3');
    expect(formatShortcut('Ctrl+Z / Ctrl+Y', true)).toBe('⌘Z / ⌘Y');
    expect(formatShortcut('Ctrl++ / Ctrl+- / Ctrl+0', true)).toBe('⌘+ / ⌘- / ⌘0');
    expect(formatShortcut('Alt+M f, s, x', true)).toBe('⌥M f, s, x');
  });
});

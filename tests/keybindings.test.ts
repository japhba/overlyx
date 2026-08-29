/** Canonical shortcut strings and key events (packages/client/src/app/keybindings.ts). */
import { describe, it, expect } from 'vitest';
import { canonical, keyFromEvent } from '../packages/client/src/app/keybindings.ts';

const ev = (key: string, code: string, mods: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }> = {}) =>
  ({ key, code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });

describe('canonical', () => {
  it('normalises modifier order, names and key names', () => {
    expect(canonical('Shift+Ctrl+o')).toBe('Ctrl+Shift+O');
    expect(canonical('Cmd+Alt+Right')).toBe('Ctrl+Alt+→');
    expect(canonical('Ctrl++')).toBe('Ctrl++');
    expect(canonical('Ctrl+Space')).toBe('Ctrl+Space');
    expect(canonical('F5')).toBe('F5');
  });
  it('rejects chords and alternatives', () => {
    expect(canonical('Alt+P s')).toBeNull();
    expect(canonical('Ctrl+Z / Ctrl+Y')).toBeNull();
    expect(canonical('')).toBeNull();
    expect(canonical('Foo+X')).toBeNull();
  });
});

describe('keyFromEvent', () => {
  it('reads letters and digits from the code (layout-independent), with the platform command key', () => {
    expect(keyFromEvent(ev('o', 'KeyO', { ctrlKey: true, altKey: true }), false)).toBe('Ctrl+Alt+O');
    expect(keyFromEvent(ev('ø', 'KeyO', { metaKey: true, altKey: true }), true)).toBe('Ctrl+Alt+O');
    expect(keyFromEvent(ev('!', 'Digit1', { ctrlKey: true, shiftKey: true }), false)).toBe('Ctrl+Shift+1');
    expect(keyFromEvent(ev('o', 'KeyO', { ctrlKey: true }), true)).toBe('Control+O');
  });
  it('ignores modifiers alone and plain typing', () => {
    expect(keyFromEvent(ev('Shift', 'ShiftLeft', { shiftKey: true }), false)).toBeNull();
    expect(keyFromEvent(ev('a', 'KeyA'), false)).toBeNull();
    expect(keyFromEvent(ev('A', 'KeyA', { shiftKey: true }), false)).toBeNull();
    expect(keyFromEvent(ev('F1', 'F1'), false)).toBe('F1');
    expect(keyFromEvent(ev('ArrowRight', 'ArrowRight', { altKey: true, shiftKey: true }), false)).toBe('Alt+Shift+→');
    expect(keyFromEvent(ev(' ', 'Space', { ctrlKey: true }), false)).toBe('Ctrl+Space');
  });
});

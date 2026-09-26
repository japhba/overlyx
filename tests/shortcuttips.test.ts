// @vitest-environment happy-dom
/**
 * Shortcut tips (client/src/shortcuttips.ts): an action taken with the mouse that has a shortcut
 * shows the shortcut from the third time on, five times; pressing the shortcut ends its tips;
 * "Don't show again" switches them all off. The right-click menu shows them too.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { normalizeShortcut, splitTitle, tookActionWithout, resetShortcutTips, shortcutTipCount, hideShortcutTip, TIP_AFTER, TIP_TIMES } from '../packages/client/src/shortcuttips.ts';
import { setPref, getPrefs } from '../packages/client/src/prefs.ts';
import { showContextMenu, closeContextMenu } from '../packages/client/src/editor/contextmenu.ts';

const tip = () => document.querySelector<HTMLElement>('.shortcut-tip');
const press = (init: KeyboardEventInit) => window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));

beforeEach(() => { setPref('shortcutTips', true); resetShortcutTips(); });

describe('reading shortcuts', () => {
  it('brings the menus\' spellings to one form', () => {
    expect(normalizeShortcut('Ctrl+E')).toBe('Ctrl+E');
    expect(normalizeShortcut('ctrl+shift+m')).toBe('Ctrl+Shift+M');
    expect(normalizeShortcut('⌘+B')).toBe('Ctrl+B');
    expect(normalizeShortcut('⌘K')).toBe('Ctrl+K');
    expect(normalizeShortcut('⌘+Alt+C')).toBe('Ctrl+Alt+C');
    expect(normalizeShortcut('⌥⇧⌘O')).toBe('Ctrl+Alt+Shift+O');
    expect(normalizeShortcut('Ctrl+Z / Ctrl+Y')).toBe('Ctrl+Z / Ctrl+Y');
    expect(normalizeShortcut('Alt+M F')).toBe('Alt+M F');
    expect(normalizeShortcut('double-click')).toBe('double-click');
    expect(normalizeShortcut('')).toBeNull();
    expect(normalizeShortcut(undefined)).toBeNull();
  });

  it('finds the shortcut at the end of a toolbar tooltip', () => {
    expect(splitTitle('Emphasis (Ctrl+E)')).toEqual({ label: 'Emphasis', shortcut: 'Ctrl+E' });
    expect(splitTitle('Insert ( ) (Alt+M ()')).toEqual({ label: 'Insert ( )', shortcut: 'Alt+M (' });
    expect(splitTitle('Subscript (Alt+M X, _)')).toEqual({ label: 'Subscript', shortcut: 'Alt+M X, _' });
    expect(splitTitle("Sync to PDF — show the cursor's place in the built PDF (Ctrl+Alt+J)")).toEqual({ label: 'Sync to PDF', shortcut: 'Ctrl+Alt+J' });
    expect(splitTitle('Insert figure float')).toEqual({ label: 'Insert figure float' });
    expect(splitTitle('Show notes (in the margin)')).toEqual({ label: 'Show notes (in the margin)' });
  });
});

describe('when a tip is shown', () => {
  it('from the third use on, five times, then never again', () => {
    const shown: boolean[] = [];
    for (let i = 0; i < TIP_AFTER + TIP_TIMES + 3; i++) {
      hideShortcutTip();
      tookActionWithout('Ctrl+E', 'Emphasis');
      shown.push(!!tip());
      if (tip()) {
        expect(tip()!.querySelector('kbd')!.textContent).toBe('Ctrl+E');
        expect(tip()!.textContent).toContain('Emphasis');
      }
    }
    expect(shown).toEqual([false, false, true, true, true, true, true, false, false, false]);
    expect(shortcutTipCount('Ctrl+E')).toMatchObject({ n: 10, shown: 5 });
  });

  it('counts the shortcut, not the place: the toolbar and the menu add up', () => {
    tookActionWithout('Ctrl+E', 'Emphasis');
    tookActionWithout('⌘+E', 'Emphasized');
    expect(tip()).toBeNull();
    tookActionWithout('Ctrl+E', 'Emphasis');
    expect(tip()).not.toBeNull();
  });

  it('actions without a shortcut never show one', () => {
    for (let i = 0; i < 5; i++) tookActionWithout(undefined, 'Insert figure float');
    expect(tip()).toBeNull();
  });

  it('pressing the shortcut once ends its tips, and closes the one shown', () => {
    for (let i = 0; i < 3; i++) tookActionWithout('Ctrl+E', 'Emphasis');
    expect(tip()).not.toBeNull();
    press({ key: 'e', code: 'KeyE', ctrlKey: true });
    expect(tip()).toBeNull();
    expect(shortcutTipCount('Ctrl+E')?.learnt).toBe(true);
    tookActionWithout('Ctrl+E', 'Emphasis');
    expect(tip()).toBeNull();
  });

  it('a chord counts as pressed when its keys come one after the other', () => {
    for (let i = 0; i < 3; i++) tookActionWithout('Alt+M F', 'Fraction');
    press({ key: 'm', code: 'KeyM', altKey: true });
    expect(shortcutTipCount('Alt+M F')?.learnt).toBeUndefined();
    press({ key: 'f', code: 'KeyF' });
    expect(shortcutTipCount('Alt+M F')?.learnt).toBe(true);
  });

  it("\"Don't show again\" switches all tips off", () => {
    for (let i = 0; i < 3; i++) tookActionWithout('Ctrl+E', 'Emphasis');
    tip()!.querySelector<HTMLButtonElement>('.shortcut-tip-off')!.click();
    expect(tip()).toBeNull();
    expect(getPrefs().shortcutTips).toBe(false);
    for (let i = 0; i < 4; i++) tookActionWithout('Ctrl+I', 'Italic');
    expect(tip()).toBeNull();
  });

  it('the × closes the tip; the next use shows it again', () => {
    for (let i = 0; i < 3; i++) tookActionWithout('Ctrl+E', 'Emphasis');
    tip()!.querySelector<HTMLButtonElement>('.shortcut-tip-close')!.click();
    expect(tip()).toBeNull();
    tookActionWithout('Ctrl+E', 'Emphasis');
    expect(tip()).not.toBeNull();
  });

  it('the right-click menu counts its entries\' shortcuts', () => {
    for (let i = 0; i < 3; i++) {
      showContextMenu(10, 10, [{ label: 'Bold', shortcut: 'Ctrl+B', action: () => {} }, { label: 'No key', action: () => {} }]);
      const row = [...document.querySelectorAll<HTMLElement>('.ctx-item')].find(r => r.textContent?.includes('Bold'))!;
      row.click();
    }
    expect(document.querySelector('.ctx-menu')).toBeNull();
    expect(tip()?.querySelector('kbd')?.textContent).toBe('Ctrl+B');
    closeContextMenu();
  });
});

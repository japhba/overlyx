// @vitest-environment happy-dom
/**
 * Smart invert (client app/darkpages.ts): one preference for every kind of page — documents, PDFs,
 * slides, layout pages — on by default, with the figures going along (line art inverted, photographs
 * in their colours); it only ever applies in the dark theme; theme.ts mirrors both on <html> for the
 * stylesheet; the old per-kind preferences (`darkPdf`, `invertSlides`) are carried over once; and the
 * theme switch's menu (MenuBar.tsx) offers all of it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DEFAULT_PREFS, getPrefs, setPref } from '../packages/client/src/prefs.ts';
import { darkPages, onDarkPages, toggleDarkPages, DARK_DESK } from '../packages/client/src/app/darkpages.ts';
import { themeMenuItems, smartInvertMenuItems, darkThemeMenuEntries } from '../packages/client/src/app/MenuBar.tsx';
import '../packages/client/src/app/theme.ts';

const html = () => document.documentElement;

describe('smart invert of the pages', () => {
  beforeEach(() => { setPref('darkPages', true); setPref('invertFigures', true); html().dataset.theme = 'light'; });

  it('defaults: pages and figures inverted in the dark theme', () => {
    expect(DEFAULT_PREFS.darkPages).toBe(true);
    expect(DEFAULT_PREFS.invertFigures).toBe(true);
    expect('darkPdf' in DEFAULT_PREFS).toBe(false);
    expect('invertSlides' in DEFAULT_PREFS).toBe(false);
    expect(DARK_DESK).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('only in the dark theme; figures only with the pages', () => {
    expect(darkPages()).toEqual({ dark: false, invert: false, figures: false });
    html().dataset.theme = 'dark';
    expect(darkPages()).toEqual({ dark: true, invert: true, figures: true });
    setPref('invertFigures', false);
    expect(darkPages()).toEqual({ dark: true, invert: true, figures: false });
    setPref('invertFigures', true);
    toggleDarkPages();
    expect(getPrefs().darkPages).toBe(false);
    expect(darkPages()).toEqual({ dark: true, invert: false, figures: false });
  });

  it('<html> carries both preferences for the stylesheet', () => {
    expect(html().hasAttribute('data-dark-pages')).toBe(true);
    expect(html().hasAttribute('data-invert-figures')).toBe(true);
    setPref('darkPages', false);
    expect(html().hasAttribute('data-dark-pages')).toBe(false);
    setPref('invertFigures', false);
    expect(html().hasAttribute('data-invert-figures')).toBe(false);
    expect(html().hasAttribute('data-invert-slides')).toBe(false);
  });

  it('listeners hear the preferences and the theme', async () => {
    let n = 0;
    const off = onDarkPages(() => { n++; });
    setPref('darkPages', false);
    expect(n).toBe(1);
    setPref('invertFigures', false);
    expect(n).toBe(2);
    html().dataset.theme = 'dark';
    await new Promise(r => setTimeout(r, 0));
    expect(n).toBe(3);
    off();
    setPref('darkPages', true);
    expect(n).toBe(3);
  });
});

describe('the old per-kind preferences', () => {
  const loadWith = async (stored: object) => {
    localStorage.setItem('ol.prefs', JSON.stringify(stored));
    vi.resetModules();
    const m = await import('../packages/client/src/prefs.ts');
    localStorage.removeItem('ol.prefs');
    return m.getPrefs() as unknown as Record<string, unknown>;
  };

  it('a PDF switched to its own colours keeps every page in its own colours', async () => {
    const p = await loadWith({ darkPdf: false, invertSlides: false });
    expect(p.darkPages).toBe(false);
    expect('darkPdf' in p || 'invertSlides' in p).toBe(false);
  });

  it('dark PDF pages (the old default) become smart invert everywhere, slides included', async () => {
    expect((await loadWith({ darkPdf: true })).darkPages).toBe(true);
    expect((await loadWith({ invertSlides: false })).darkPages).toBe(true);
    expect((await loadWith({ invertSlides: true })).darkPages).toBe(true);
  });

  it('a choice made since stays', async () => {
    expect((await loadWith({ darkPages: false, darkPdf: true })).darkPages).toBe(false);
    expect((await loadWith({ darkPages: false })).darkPages).toBe(false);
  });
});

describe('the theme switch’s menu', () => {
  beforeEach(() => { setPref('darkPages', true); setPref('invertFigures', true); setPref('darkTone', 'white'); });
  const labels = (items: { label?: string; sep?: boolean }[]) => items.map(i => (i.sep ? '—' : i.label));

  it('theme, smart invert of pages and figures, the text tone, the settings', () => {
    const picked: string[] = [];
    const items = themeMenuItems('dark', p => picked.push(p), 'the system', () => picked.push('settings'));
    expect(labels(items)).toEqual([
      'Theme', 'Default (follows the system)', 'Light', 'Dark', '—',
      'Smart invert in the dark theme', 'Pages — documents, PDFs, slides', 'Figures too — photos keep their colours', '—',
      'Text in the dark theme', 'White', 'Sepia', 'Gray', '—',
      'Appearance settings…',
    ]);
    expect(items.filter(i => i.checked).map(i => i.label)).toEqual(['Dark', 'Pages — documents, PDFs, slides', 'Figures too — photos keep their colours', 'White']);
    items.find(i => i.label === 'Light')!.action!();
    items.find(i => i.label === 'Appearance settings…')!.action!();
    expect(picked).toEqual(['light', 'settings']);
    // without a settings dialog (no shell offers one) the menu ends with the tone
    expect(labels(themeMenuItems('system', () => {})).at(-1)).toBe('Gray');
  });

  it('pages and figures switch the preferences; figures wait for the pages', () => {
    smartInvertMenuItems().find(i => i.label?.startsWith('Figures'))!.action!();
    expect(getPrefs().invertFigures).toBe(false);
    smartInvertMenuItems().find(i => i.label?.startsWith('Pages'))!.action!();
    expect(getPrefs().darkPages).toBe(false);
    const fig = smartInvertMenuItems().find(i => i.label?.startsWith('Figures'))!;
    expect(fig.disabled).toBe(true);
    themeMenuItems('dark', () => {}).find(i => i.label === 'Sepia')!.action!();
    expect(getPrefs().darkTone).toBe('sepia');
  });

  it('the View menu has them too, under names that stand alone in the command palette', () => {
    const [sub] = darkThemeMenuEntries();
    expect(sub.label).toBe('Dark theme ▸');
    expect(labels(sub.sub!)).toEqual(['Smart invert pages (documents, PDFs, slides)', 'Smart invert figures too (photos keep their colours)', '—', 'White text', 'Sepia text', 'Gray text']);
    sub.sub![0].action!();
    expect(getPrefs().darkPages).toBe(false);
    expect(darkThemeMenuEntries()[0].sub![1].disabled).toBe(true);
  });
});

describe('a colour as an inverted page shows it', () => {
  it('white turns black, black white, greys mirror, colours keep their hue', async () => {
    const { invertedColor } = await import('../packages/client/src/app/darkpages.ts');
    expect(invertedColor('#ffffff')).toBe('rgb(0, 0, 0)');
    expect(invertedColor('rgb(0, 0, 0)')).toBe('rgb(255, 255, 255)');
    expect(invertedColor('#808080')).toBe('rgb(127, 127, 127)');
    const [r, g, b] = invertedColor('#d02020').match(/\d+/g)!.map(Number);
    expect(r).toBeGreaterThan(g); expect(r).toBeGreaterThan(b);   // still red
    expect(invertedColor('transparent')).toBe('transparent');
  });
});

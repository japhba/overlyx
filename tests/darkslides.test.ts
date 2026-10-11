// @vitest-environment happy-dom
/**
 * Slides in the dark theme (client app/darkslides.ts): inverting them is a preference that is off by
 * default (designed slides change colour) while the PDF's dark pages stay on by default; it only ever
 * applies in the dark theme, and theme.ts mirrors it on <html> for the layout pages' rules.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DEFAULT_PREFS, getPrefs, setPref } from '../packages/client/src/prefs.ts';
import { darkSlides, onDarkSlides, DARK_DESK } from '../packages/client/src/app/darkslides.ts';
import '../packages/client/src/app/theme.ts';

describe('slides in the dark theme', () => {
  beforeEach(() => { setPref('invertSlides', false); document.documentElement.dataset.theme = 'light'; });

  it('defaults: slides as designed, the PDF dark', () => {
    expect(DEFAULT_PREFS.invertSlides).toBe(false);
    expect(DEFAULT_PREFS.darkPdf).toBe(true);
    expect(getPrefs().invertSlides).toBe(false);
    expect(DARK_DESK).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('inverted only in the dark theme, and only when asked for', () => {
    expect(darkSlides()).toEqual({ dark: false, invert: false });
    setPref('invertSlides', true);
    expect(darkSlides()).toEqual({ dark: false, invert: false });
    document.documentElement.dataset.theme = 'dark';
    expect(darkSlides()).toEqual({ dark: true, invert: true });
    setPref('invertSlides', false);
    expect(darkSlides()).toEqual({ dark: true, invert: false });
  });

  it('<html> carries the preference for the stylesheet', () => {
    setPref('invertSlides', true);
    expect(document.documentElement.hasAttribute('data-invert-slides')).toBe(true);
    setPref('invertSlides', false);
    expect(document.documentElement.hasAttribute('data-invert-slides')).toBe(false);
  });

  it('listeners hear the preference and the theme', async () => {
    let n = 0;
    const off = onDarkSlides(() => { n++; });
    setPref('invertSlides', true);
    expect(n).toBe(1);
    document.documentElement.dataset.theme = 'dark';
    await new Promise(r => setTimeout(r, 0));
    expect(n).toBe(2);
    off();
    setPref('invertSlides', false);
    expect(n).toBe(2);
  });
});

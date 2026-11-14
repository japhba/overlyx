// @vitest-environment happy-dom
/**
 * Preferences following the account (client app/accountprefs.ts) against a stand-in for the server
 * (the newer choice wins per key, `onlyNew` fills gaps only): the first device brings its choices
 * along, a later device takes the account's instead of pushing its stale ones, changes go up, and a
 * setting kept on this device only stays out of it.
 */
import { describe, it, expect, vi } from 'vitest';

const server = vi.hoisted(() => ({ prefs: {} as Record<string, { value: unknown; at: number }> }));
vi.mock('../packages/client/src/api', () => ({
  api: {
    accountPrefs: async () => ({ prefs: structuredClone(server.prefs) }),
    setAccountPrefs: async (set: Record<string, { value: unknown; at: number }>, onlyNew = false) => {
      for (const [k, e] of Object.entries(set)) {
        const cur = server.prefs[k];
        if (onlyNew ? !cur : !cur || e.at >= cur.at) server.prefs[k] = { value: e.value, at: e.at };
      }
      return { prefs: structuredClone(server.prefs) };
    },
  },
}));
vi.mock('../packages/client/src/app/theme', () => ({
  setThemePref: (p: string) => { if (p === 'system') localStorage.removeItem('ol.theme'); else localStorage.setItem('ol.theme', p); },
}));

/** a browser: its localStorage, then the modules loaded fresh, signed in as user 1 */
async function device(stored: Record<string, string>) {
  localStorage.clear();
  for (const [k, v] of Object.entries(stored)) localStorage.setItem(k, v);
  vi.resetModules();
  const prefs = await import('../packages/client/src/prefs');
  const sync = await import('../packages/client/src/app/accountprefs');
  const stop = sync.startAccountPrefs(1);
  await sync.sync(); await sync.sync();
  return { prefs, sync, stop };
}

describe('preferences that follow the account', () => {
  it('the first device brings its choices along — not its defaults, not its device settings', async () => {
    server.prefs = {};
    const { stop } = await device({ 'ol.prefs': JSON.stringify({ editorFont: 'gf:Lora', editorFontChosen: true, mathKeyboard: 'on' }), 'ol.theme': 'dark' });
    expect(server.prefs['pref.editorFont']?.value).toBe('gf:Lora');
    expect(server.prefs['ls.ol.theme']?.value).toBe('dark');
    expect(server.prefs['pref.mathKeyboard']).toBeUndefined();
    expect(server.prefs['pref.spellcheck']).toBeUndefined();
    stop();
  });
  it('a later device takes the account’s values instead of pushing its own', async () => {
    const { prefs, sync, stop } = await device({ 'ol.prefs': JSON.stringify({ editorFont: 'gf:Roboto', editorFontChosen: true, mathKeyboard: 'off' }) });
    expect(prefs.getUserPrefs().editorFont).toBe('gf:Lora');
    expect(prefs.getUserPrefs().mathKeyboard).toBe('off');
    expect(localStorage.getItem('ol.theme')).toBe('dark');
    expect(server.prefs['pref.editorFont']?.value).toBe('gf:Lora');
    // a change made here goes up
    prefs.setPref('spellcheck', false);
    await sync.sync();
    expect(server.prefs['pref.spellcheck']?.value).toBe(false);
    // kept on this device only: neither sent nor replaced
    sync.setDeviceOnly('pref.editorFont', true);
    prefs.setPref('editorFont', 'gf:Inter');
    await sync.sync();
    expect(server.prefs['pref.editorFont']?.value).toBe('gf:Lora');
    expect(prefs.getUserPrefs().editorFont).toBe('gf:Inter');
    // following the account again: its value comes back
    sync.setDeviceOnly('pref.editorFont', false);
    await sync.sync(); await sync.sync();
    expect(prefs.getUserPrefs().editorFont).toBe('gf:Lora');
    stop();
  });
  it('the first device picks up a change made elsewhere', async () => {
    const { prefs, sync, stop } = await device({ 'ol.prefs': JSON.stringify({ editorFont: 'gf:Lora', editorFontChosen: true }), 'ol.prefsSync': JSON.stringify({ user: 1, values: { 'pref.editorFont': '"gf:Lora"' }, at: { 'pref.editorFont': 1 } }) });
    expect(prefs.getUserPrefs().spellcheck).toBe(false);
    stop();
  });
});

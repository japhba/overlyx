/**
 * Preferences that follow the account (server accountprefs.ts): the newer choice wins per key, a
 * browser's first upload (`onlyNew`) never overwrites what the account holds, and odd input is left out.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import { rmSync } from 'node:fs';

const ROOT = vi.hoisted(() => {
  const r = require('node:path').join(process.env.OVERLYX_SCRATCH ?? require('node:os').tmpdir(), 'overlyx-account-prefs-test');
  require('node:fs').rmSync(r, { recursive: true, force: true });
  process.env.OVERLYX_DATA_DIR = require('node:path').join(r, 'data');
  process.env.OVERLYX_PROJECTS_DIR = require('node:path').join(r, 'projects');
  return r;
});
const { createUser } = await import('../packages/server/src/auth.ts');
const { accountPrefs, setAccountPrefs } = await import('../packages/server/src/accountprefs.ts');

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe('account preferences', () => {
  const uid = createUser('prefs', 'Prefs', 'pw').id;
  it('stores values with their time; the newer choice wins per key', () => {
    setAccountPrefs(uid, { 'pref.editorFont': { value: 'gf:Inter', at: 1000 }, 'pref.spellcheck': { value: false, at: 1000 } });
    // a device that was offline sends an older choice late: the newer one stays
    setAccountPrefs(uid, { 'pref.editorFont': { value: 'cm', at: 500 } });
    // a newer one replaces it, and leaves the other key alone
    const p = setAccountPrefs(uid, { 'pref.spellcheck': { value: true, at: 2000 } });
    expect(p['pref.editorFont']).toEqual({ value: 'gf:Inter', at: 1000 });
    expect(p['pref.spellcheck']).toEqual({ value: true, at: 2000 });
  });
  it('a first upload only fills what the account does not have', () => {
    const p = setAccountPrefs(uid, { 'pref.editorFont': { value: 'stale', at: Date.now() }, 'ls.ol.theme': { value: 'dark', at: 10 } }, true);
    expect(p['pref.editorFont'].value).toBe('gf:Inter');
    expect(p['ls.ol.theme'].value).toBe('dark');
  });
  it('leaves out bad keys and too-large values; times are never in the future', () => {
    const p = setAccountPrefs(uid, { 'bad key!': { value: 1 }, 'pref.big': { value: 'x'.repeat(70_000) }, 'pref.later': { value: 1, at: Date.now() + 1e9 }, 'pref.novalue': {} });
    expect(p['bad key!']).toBeUndefined();
    expect(p['pref.big']).toBeUndefined();
    expect(p['pref.novalue']).toBeUndefined();
    expect(p['pref.later'].at).toBeLessThanOrEqual(Date.now());
    expect(Object.keys(accountPrefs(uid + 1))).toEqual([]);
  });
});

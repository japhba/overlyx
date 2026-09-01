/**
 * Per-account settings (userSettings.ts) and token re-copy: the instance owner has
 * `allowRecopyTokens` on by default and everyone else off; administrator overrides are stored;
 * with the setting on, git and MCP tokens keep their plaintext and the lists hand it back —
 * with it off, nothing recoverable is stored.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), 'overlyx-settings-test');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'projects', 'p'), { recursive: true });
process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');
process.env.OVERLYX_PROJECTS_DIR = join(ROOT, 'projects');
process.env.OVERLYX_OWNER_EMAIL = 'owner@example.com';

const { createUser } = await import('../packages/server/src/auth.ts');
const { userSettings, setUserSettings } = await import('../packages/server/src/userSettings.ts');
const { createMcpToken, listMcpTokens, verifyMcpToken } = await import('../packages/server/src/mcpTokens.ts');
const { createToken, listTokens } = await import('../packages/server/src/git.ts');

const owner = createUser('jan', 'Jan', null, { email: 'Owner@Example.com', googleSub: 'g-jan' });
const bob = createUser('bob', 'Bob', 'bobs-password');

afterAll(() => { rmSync(ROOT, { recursive: true, force: true }); });

describe('per-account settings', () => {
  it('token re-copy is on for the instance owner, off for everyone else', () => {
    expect(userSettings(owner.id).allowRecopyTokens).toBe(true);
    expect(userSettings(bob.id).allowRecopyTokens).toBe(false);
  });
  it('an administrator override is stored and wins over the default', () => {
    expect(setUserSettings(bob.id, { allowRecopyTokens: true }).allowRecopyTokens).toBe(true);
    expect(userSettings(bob.id).allowRecopyTokens).toBe(true);
    setUserSettings(bob.id, { allowRecopyTokens: false });
    expect(userSettings(bob.id).allowRecopyTokens).toBe(false);
    expect(setUserSettings(owner.id, { allowRecopyTokens: false }).allowRecopyTokens).toBe(false);
    setUserSettings(owner.id, { allowRecopyTokens: true });
    expect(userSettings(owner.id).allowRecopyTokens).toBe(true);
  });
});

describe('re-copyable MCP tokens', () => {
  it('with storePlain the list hands the token back — but only to a caller allowed secrets', () => {
    const t = createMcpToken(owner.id, 'agent', true);
    expect(verifyMcpToken(t.token)?.userId).toBe(owner.id);
    expect(listMcpTokens(owner.id, true).find(r => r.id === t.id)?.token).toBe(t.token);
    expect(listMcpTokens(owner.id, false).find(r => r.id === t.id)?.token).toBeUndefined();
    expect(listMcpTokens(owner.id).find(r => r.id === t.id)?.token).toBeUndefined();
  });
  it('without storePlain nothing recoverable is stored', () => {
    const t = createMcpToken(owner.id, 'oneshot');
    expect(listMcpTokens(owner.id, true).find(r => r.id === t.id)?.token).toBeUndefined();
    expect(verifyMcpToken(t.token)?.name).toBe('oneshot');
  });
});

describe('re-copyable git tokens', () => {
  it('the same for personal access tokens', () => {
    const kept = createToken(owner.id, 'laptop', true);
    const oneshot = createToken(owner.id, 'desktop');
    const rows = listTokens(owner.id, true);
    expect(rows.find(r => r.id === kept.id)?.token).toBe(kept.token);
    expect(rows.find(r => r.id === oneshot.id)?.token).toBeUndefined();
    expect(listTokens(owner.id, false).find(r => r.id === kept.id)?.token).toBeUndefined();
  });
});

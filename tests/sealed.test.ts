/**
 * Secrets at rest (sealed.ts): values sealed under the login secret before the sealing key, and
 * token copies kept in plain text, are sealed again under the sealing key at start-up — which
 * secret.key no longer opens; a value no key opens reads as missing.
 */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), 'overlyx-sealed-test');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');

const { JWT_SECRET } = await import('../packages/server/src/config.ts');
const { db } = await import('../packages/server/src/db.ts');
const { sealer } = await import('../packages/server/src/sealed.ts');

const legacyKey = (purpose: string) => crypto.createHash('sha256').update(`overlyx-${purpose}:` + JWT_SECRET).digest();
/** how a value was sealed before 7 Nov 2026 */
function legacySeal(purpose: string, plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', legacyKey(purpose), iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), body].map(b => b.toString('base64url')).join('.');
}

describe('sealed secrets', () => {
  it('seals older values again under the sealing key', () => {
    db.exec('CREATE TABLE sealed_test (id INTEGER PRIMARY KEY, secret TEXT, kept TEXT)');
    db.prepare('INSERT INTO sealed_test (secret, kept) VALUES (?, ?)').run(legacySeal('test', 'api-key-1'), 'olx_plain');
    db.prepare('INSERT INTO sealed_test (secret, kept) VALUES (NULL, NULL)').run();
    const s = sealer('test'), tokens = sealer('tokens');
    s.reseal('sealed_test', 'secret');
    tokens.reseal('sealed_test', 'kept', 'plain');
    const row = db.prepare('SELECT secret, kept FROM sealed_test WHERE id = 1').get() as { secret: string; kept: string };
    expect(row.secret).toMatch(/^s2\./);
    expect(s.open(row.secret)).toBe('api-key-1');
    expect(row.kept).toMatch(/^s2\./);
    expect(tokens.open(row.kept)).toBe('olx_plain');
    expect(db.prepare('SELECT secret FROM sealed_test WHERE id = 2').get()).toEqual({ secret: null });
    expect(statSync(join(ROOT, 'data', 'sealing.key')).mode & 0o777).toBe(0o600);
    // the login secret opens it no more, nor another purpose's key
    const [iv, tag, body] = row.secret.slice(3).split('.').map(p => Buffer.from(p, 'base64url'));
    const d = crypto.createDecipheriv('aes-256-gcm', legacyKey('test'), iv);
    d.setAuthTag(tag);
    expect(() => Buffer.concat([d.update(body), d.final()])).toThrow();
    expect(sealer('other').open(row.secret)).toBeNull();
  });

  it('reads a value no key opens as missing', () => {
    const s = sealer('test');
    expect(s.open(s.seal('x').slice(0, -2) + 'AA')).toBeNull();
    expect(s.open('garbage')).toBeNull();
  });
});

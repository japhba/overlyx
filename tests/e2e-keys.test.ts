/**
 * End-to-end encrypted projects (DOCS.md "End-to-end encrypted projects"): the versions of a
 * project's key — ciphertexts that name the version they were made with (client e2e/crypto.ts), the
 * key ring that decrypts each with its own (e2e/keys.ts), and the server's side of replacing the key
 * when a member leaves (server e2e/store.ts) — and the .zip a browser makes of such a project
 * (e2e/zip.ts).
 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import zlib from 'node:zlib';

const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), 'overlyx-e2e-keys-test');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'projects'), { recursive: true });
process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');
process.env.OVERLYX_PROJECTS_DIR = join(ROOT, 'projects');

const { encrypt, decrypt, keyVersionOf, newProjectKey, newKeyPair, exportPublic, wrapProjectKey, unwrapProjectKey } = await import('../packages/client/src/e2e/crypto.ts');
const { Keyring } = await import('../packages/client/src/e2e/keys.ts');
const { makeZip, crc32 } = await import('../packages/client/src/e2e/zip.ts');
const store = await import('../packages/server/src/e2e/store.ts');

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe('ciphertexts name their key version', () => {
  it('keeps the first key\'s format and marks later versions', async () => {
    const k = await newProjectKey();
    const v1 = await encrypt(k, bytes('hello'), 'doc', 'abc');
    const v7 = await encrypt(k, bytes('hello'), 'doc', 'abc', 7);
    expect(v1[0]).toBe(1);
    expect(keyVersionOf(v1)).toBe(1);
    expect(v7[0]).toBe(2);
    expect(keyVersionOf(v7)).toBe(7);
    expect(text(await decrypt(k, v1, 'doc', 'abc'))).toBe('hello');
    expect(text(await decrypt(k, v7, 'doc', 'abc'))).toBe('hello');
  });

  it('refuses a ciphertext passed off as another document\'s', async () => {
    const k = await newProjectKey();
    const ct = await encrypt(k, bytes('x'), 'doc', 'abc', 3);
    await expect(decrypt(k, ct, 'doc', 'other')).rejects.toThrow();
    await expect(decrypt(k, ct, 'blob', 'abc')).rejects.toThrow();
  });

  it('wraps each version of the project key for a member', async () => {
    const pair = await newKeyPair();
    const k = await newProjectKey();
    const wrapped = await wrapProjectKey(k, await exportPublic(pair.publicKey), 5, 2);
    const back = await unwrapProjectKey(wrapped, pair.privateKey, 5, 2);
    const ct = await encrypt(back, bytes('same key'), 'blob', 'b1', 2);
    expect(text(await decrypt(k, ct, 'blob', 'b1'))).toBe('same key');
    // (made for version 2: not version 1's)
    await expect(unwrapProjectKey(wrapped, pair.privateKey, 5, 1)).rejects.toThrow();
  });
});

describe('Keyring', () => {
  it('encrypts with the newest key and decrypts each ciphertext with its own', async () => {
    const k1 = await newProjectKey(), k2 = await newProjectKey();
    const ring = new Keyring('jan/p', 1, [[1, k1]]);
    const old = await ring.encrypt(bytes('before'), 'doc', 'd');
    expect(keyVersionOf(old)).toBe(1);
    ring.add(2, k2);
    expect(ring.version).toBe(2);
    expect(ring.first).toBe(k1);
    const now = await ring.encrypt(bytes('after'), 'doc', 'd');
    expect(keyVersionOf(now)).toBe(2);
    expect(text(await ring.decrypt(old, 'doc', 'd'))).toBe('before');
    expect(text(await ring.decrypt(now, 'doc', 'd'))).toBe('after');
    // the old key alone cannot read what came after
    await expect(decrypt(k1, now, 'doc', 'd')).rejects.toThrow();
  });
});

describe('replacing the key when a member leaves (server store)', () => {
  const project = 'owner/secret';
  mkdirSync(join(ROOT, 'projects', project), { recursive: true });

  it('grants only versions that exist, never over a member\'s key', () => {
    expect(store.keyVersion(project)).toBe(0);
    expect(store.grantKey(project, 1, 1, 'wrapped-for-owner-v1', 1)).toBe(true);
    expect(store.grantKey(project, 2, 1, 'wrapped-for-bob-v1', 1)).toBe(true);
    expect(store.grantKey(project, 3, 1, 'wrapped-for-eve-v1', 1)).toBe(true);
    expect(store.grantKey(project, 2, 1, 'garbage', 3)).toBe(false);
    expect(store.wrappedKeys(project).find(k => k.userId === 2)!.wrapped).toBe('wrapped-for-bob-v1');
    expect(store.keyVersion(project)).toBe(1);
    expect(store.needsRotation(project, new Set([1, 2, 3]))).toBe(false);
  });

  it('asks for a new key once a holder left, until there is one', () => {
    store.dropKeys(project, 3);
    expect(store.wrappedKeys(project).some(k => k.userId === 3)).toBe(false);
    expect(store.needsRotation(project, new Set([1, 2]))).toBe(true);
    // only the next version, once
    expect(store.rotateKey(project, 3, [{ userId: 1, wrapped: 'x' }], 1)).toBe(false);
    expect(store.rotateKey(project, 2, [{ userId: 1, wrapped: 'owner-v2' }, { userId: 2, wrapped: 'bob-v2' }], 1)).toBe(true);
    expect(store.rotateKey(project, 2, [{ userId: 1, wrapped: 'other' }], 2)).toBe(false);
    expect(store.keyVersion(project)).toBe(2);
    expect(store.needsRotation(project, new Set([1, 2]))).toBe(false);
  });

  it('asks too when a holder of the newest key is no longer a member (a revoked link)', () => {
    expect(store.needsRotation(project, new Set([1]))).toBe(true);
  });

  it('does not ask when someone only replaced their own key pair', () => {
    const p2 = 'owner/other';
    mkdirSync(join(ROOT, 'projects', p2), { recursive: true });
    store.grantKey(p2, 1, 1, 'a', 1);
    store.grantKey(p2, 2, 1, 'b', 1);
    store.dropKeys(p2, 2, false);
    expect(store.needsRotation(p2, new Set([1, 2]))).toBe(false);
  });
});

describe('makeZip', () => {
  /** the entries of a zip, read back with node's inflate */
  function unzip(buf: Buffer): Map<string, { data: Buffer; crc: number }> {
    const out = new Map<string, { data: Buffer; crc: number }>();
    const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const count = buf.readUInt16LE(end + 10);
    let p = buf.readUInt32LE(end + 16);
    for (let i = 0; i < count; i++) {
      expect(buf.readUInt32LE(p)).toBe(0x02014b50);
      const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), size = buf.readUInt32LE(p + 20);
      const nameLen = buf.readUInt16LE(p + 28), offset = buf.readUInt32LE(p + 42);
      const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
      const lname = buf.readUInt16LE(offset + 26), lextra = buf.readUInt16LE(offset + 28);
      const body = buf.subarray(offset + 30 + lname + lextra, offset + 30 + lname + lextra + size);
      out.set(name, { data: method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body), crc });
      p += 46 + nameLen;
    }
    return out;
  }

  it('holds the files as they were, folders, UTF-8 names', async () => {
    const tex = bytes('\\documentclass{article}\n'.repeat(200));
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const blob = await makeZip([
      { path: 'main.tex', data: tex },
      { path: 'figures/', data: new Uint8Array(0) },
      { path: 'figures/größe.png', data: png },
    ]);
    const files = unzip(Buffer.from(await blob.arrayBuffer()));
    expect([...files.keys()]).toEqual(['main.tex', 'figures/', 'figures/größe.png']);
    expect(text(files.get('main.tex')!.data)).toBe(text(tex));
    expect([...files.get('figures/größe.png')!.data]).toEqual([...png]);
    expect(files.get('main.tex')!.crc).toBe(zlib.crc32(Buffer.from(tex)));
    expect(crc32(png)).toBe(zlib.crc32(Buffer.from(png)));
  });
});

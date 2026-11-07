/**
 * The keys of end-to-end encrypted projects in this browser (crypto.ts has the primitives):
 *
 *  - the account's key pair: made here once (`setUpAccount`, which shows the recovery code), unlocked
 *    on any other device with that code (`unlockAccount`); the private key is kept in IndexedDB,
 *    non-extractable, and forgotten at sign-out (app/localData.ts);
 *  - each project's keys (`Keyring`): unwrapped from what the server keeps for this account, cached
 *    here. A member who leaves knew the key: the next editor who opens the project makes a new
 *    version for those who stay (`rotateIfNeeded`), and new content is encrypted with it. What was
 *    there before stays encrypted with the older versions, which every member keeps;
 *  - members who joined since and wait for the key: any editor holding it can give it to them
 *    (`grantWaiting`, every version) — only when they say so, since the server decides who is a member.
 */
import { newKeyPair, exportPublic, newRecoveryCode, sealPrivate, unsealPrivate, newProjectKey, wrapProjectKey, unwrapProjectKey, fingerprint, encrypt, decrypt, keyVersionOf, type Cipher } from './crypto';

const DB = 'overlyx-e2e';
const STORE = 'kv';

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore(STORE); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await idb();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const r = db.transaction(STORE).objectStore(STORE).get(key);
      r.onsuccess = () => resolve(r.result as T | undefined);
      r.onerror = () => reject(r.error);
    });
  } finally { db.close(); }
}
async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await idb();
  try {
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(STORE, 'readwrite');
      t.objectStore(STORE).put(value, key);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  } finally { db.close(); }
}
async function idbDelete(key: string): Promise<void> {
  const db = await idb();
  try {
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(STORE, 'readwrite');
      t.objectStore(STORE).delete(key);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  } finally { db.close(); }
}

/** Forget every key of this browser (sign-out). */
export async function forgetKeys(): Promise<void> {
  device = null; projectKeys.clear();
  await new Promise<void>(resolve => { const r = indexedDB.deleteDatabase(DB); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });
}

/* --------------------------------------------------------------------------- server */

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, { method, credentials: 'same-origin', headers: body !== undefined ? { 'content-type': 'application/json' } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `${res.status} ${res.statusText}`), { status: res.status });
  return data as T;
}
interface ServerKeys { publicKey: string; sealedPrivate: string; updatedAt: number }
export interface KeyMember { userId: number; role: string; via: string; name: string; username: string; guest: boolean; publicKey: string | null; versions: number[] }
export interface ProjectKeyInfo { version: number; rotate?: boolean; mine: { version: number; wrapped: string }[]; members: KeyMember[] }
const enc = encodeURIComponent;
export const keyApi = {
  me: () => call<{ keys: ServerKeys | null }>('GET', '/api/e2e/me'),
  putMe: (publicKey: string, sealedPrivate: string, replace = false) => call<{ keys: ServerKeys }>('PUT', '/api/e2e/me', { publicKey, sealedPrivate, replace }),
  reseal: (sealedPrivate: string) => call<{ ok: boolean }>('POST', '/api/e2e/me/reseal', { sealedPrivate }),
  projectKeys: (project: string) => call<ProjectKeyInfo>('GET', `/api/e2e/projects/${enc(project)}/keys`),
  grant: (project: string, grants: { userId: number; version: number; wrapped: string }[]) => call<{ granted: number }>('POST', `/api/e2e/projects/${enc(project)}/keys`, { grants }),
  rotate: (project: string, version: number, grants: { userId: number; wrapped: string }[]) => call<{ ok: boolean; version: number }>('POST', `/api/e2e/projects/${enc(project)}/keys/rotate`, { version, grants }),
};

/* ---------------------------------------------------------------- the account's key pair */

interface Device { userId: number; publicKey: string; privateKey: CryptoKey }
let device: Device | null = null;

export type AccountState = 'ready' | 'setup' | 'unlock';

/** Whether this browser can open encrypted projects: `setup` (the account has no key pair yet), `unlock` (it has, not here yet). */
export async function accountState(userId: number): Promise<AccountState> {
  const server = (await keyApi.me()).keys;
  if (!server) return 'setup';
  const d = await deviceKeys(userId);
  return d && d.publicKey === server.publicKey ? 'ready' : 'unlock';
}

async function deviceKeys(userId: number): Promise<Device | null> {
  if (device?.userId === userId) return device;
  try {
    const d = await idbGet<Device>(`device:${userId}`);
    if (d && d.privateKey && d.publicKey) return device = d;
  } catch { /* no IndexedDB */ }
  return null;
}

async function keepDevice(d: Device): Promise<void> {
  device = d;
  try { await idbSet(`device:${d.userId}`, d); } catch { /* kept for this session only */ }
}

/**
 * A key pair for the account (the first encrypted project, or a lost recovery code with `replace`):
 * returns the recovery code, which the person must keep — it is shown once and never stored.
 */
export async function setUpAccount(userId: number, replace = false): Promise<string> {
  const pair = await newKeyPair();
  const code = newRecoveryCode();
  const publicKey = await exportPublic(pair.publicKey);
  const sealed = await sealPrivate(pair.privateKey, code, userId);
  await keyApi.putMe(publicKey, sealed, replace);
  // the private key kept here can no longer be exported
  const privateKey = await unsealPrivate(sealed, code, userId);
  projectKeys.clear();
  await keepDevice({ userId, publicKey, privateKey });
  return code;
}

/** This device unlocked with the recovery code. */
export async function unlockAccount(userId: number, code: string): Promise<void> {
  const server = (await keyApi.me()).keys;
  if (!server) throw new Error('This account has no key pair yet');
  const privateKey = await unsealPrivate(server.sealedPrivate, code, userId);
  await keepDevice({ userId, publicKey: server.publicKey, privateKey });
}

/** A new recovery code for the same key pair (the old one stops working). */
export async function newCode(userId: number, oldCode: string): Promise<string> {
  const server = (await keyApi.me()).keys;
  if (!server) throw new Error('This account has no key pair yet');
  const priv = await unsealPrivate(server.sealedPrivate, oldCode, userId, true);
  const code = newRecoveryCode();
  await keyApi.reseal(await sealPrivate(priv, code, userId));
  return code;
}

export async function myFingerprint(userId: number): Promise<string | null> {
  const d = await deviceKeys(userId);
  return d ? fingerprint(d.publicKey) : null;
}

/* ----------------------------------------------------------------------- project keys */

/**
 * A project's keys, by version: content is encrypted with the newest, decrypted with the one it
 * names (crypto.ts). A version this browser does not hold yet (a member replaced the key; the relay
 * says so, or a ciphertext names it) is fetched before anything is encrypted or decrypted with it.
 */
export class Keyring implements Cipher {
  private keys = new Map<number, CryptoKey>();
  private refreshing: Promise<void> | null = null;

  constructor(readonly project: string, private userId: number, keys: Iterable<[number, CryptoKey]>) {
    for (const [v, k] of keys) this.keys.set(v, k);
  }

  get version(): number { return Math.max(0, ...this.keys.keys()); }
  /** the oldest key held: what the local copies of the project are named after (it never changes) */
  get first(): CryptoKey { return this.keys.get(Math.min(...this.keys.keys()))!; }
  entries(): [number, CryptoKey][] { return [...this.keys]; }

  async encrypt(plain: Uint8Array, kind: string, id: string): Promise<Uint8Array> {
    if (this.refreshing) await this.refreshing;
    const v = this.version;
    return encrypt(this.keys.get(v)!, plain, kind, id, v);
  }

  async decrypt(data: Uint8Array, kind: string, id: string): Promise<Uint8Array> {
    const v = keyVersionOf(data);
    if (!this.keys.has(v) && v > 0) await this.refresh();
    const k = this.keys.get(v);
    if (!k) throw new Error(`this browser does not hold version ${v} of the key`);
    return decrypt(k, data, kind, id);
  }

  noteVersion(v: number): void { if (v > this.version) void this.refresh(); }

  /** Add the versions the server has for this account that are not here yet. */
  refresh(): Promise<void> {
    return this.refreshing ??= (async () => {
      const d = await deviceKeys(this.userId);
      if (!d) return;
      const info = await keyApi.projectKeys(this.project);
      for (const m of info.mine) if (!this.keys.has(m.version)) this.keys.set(m.version, await unwrapProjectKey(m.wrapped, d.privateKey, this.userId, m.version));
      void keepRing(this);
    })().catch(e => console.warn('[e2e] the project key could not be fetched', e)).finally(() => { this.refreshing = null; });
  }

  add(version: number, key: CryptoKey): void { this.keys.set(version, key); void keepRing(this); }
}

const projectKeys = new Map<string, Keyring>();

async function keepRing(ring: Keyring): Promise<void> {
  await idbSet(`project:${ring.project}`, { keys: ring.entries() }).catch(() => {});
}
/** the keys this browser kept of a project (before versions: one key) */
function keptEntries(kept: { keys?: [number, CryptoKey][]; key?: CryptoKey; version?: number } | undefined): [number, CryptoKey][] | null {
  if (kept?.keys?.length) return kept.keys;
  if (kept?.key) return [[kept.version ?? 1, kept.key]];
  return null;
}

export class KeyMissing extends Error {
  constructor(public reason: 'account' | 'waiting', message: string) { super(message); this.name = 'KeyMissing'; }
}

/** The project's keys: from this session, this browser, or unwrapped from the server's copies for this account. */
export async function projectKey(project: string, userId: number): Promise<Keyring> {
  const hit = projectKeys.get(project);
  if (hit) return hit;
  const d = await deviceKeys(userId);
  let info: ProjectKeyInfo | null = null;
  try { info = await keyApi.projectKeys(project); } catch (e) {
    // offline: the keys this browser kept
    const kept = keptEntries(await idbGet<{ keys?: [number, CryptoKey][]; key?: CryptoKey; version?: number }>(`project:${project}`).catch(() => undefined));
    if (kept) { const ring = new Keyring(project, userId, kept); projectKeys.set(project, ring); return ring; }
    throw e;
  }
  if (!d) throw new KeyMissing('account', 'Unlock encrypted projects in this browser with your recovery code');
  if (!info.mine.length) throw new KeyMissing('waiting', 'A member who has the key must give it to you: they see a request when they open the project');
  const keys: [number, CryptoKey][] = [];
  for (const m of info.mine) keys.push([m.version, await unwrapProjectKey(m.wrapped, d.privateKey, userId, m.version)]);
  const ring = new Keyring(project, userId, keys);
  projectKeys.set(project, ring);
  void keepRing(ring);
  return ring;
}

/** A new project's key, wrapped for its owner. */
export async function createProjectKey(project: string, userId: number): Promise<Keyring> {
  const d = await deviceKeys(userId);
  if (!d) throw new KeyMissing('account', 'Set up encryption first');
  const key = await newProjectKey();
  await keyApi.grant(project, [{ userId, version: 1, wrapped: await wrapProjectKey(key, d.publicKey, userId, 1) }]);
  const ring = new Keyring(project, userId, [[1, key]]);
  projectKeys.set(project, ring);
  void keepRing(ring);
  return ring;
}

/**
 * Someone who held the project key is no longer a member (the server says so): a new version for
 * the members who stay — those who held the key, and this account. Another browser may have made
 * it first (409): then that one is fetched. True when this browser made one.
 */
export async function rotateIfNeeded(project: string, userId: number): Promise<boolean> {
  const info = await keyApi.projectKeys(project);
  if (!info.rotate) return false;
  const ring = await projectKey(project, userId);
  const version = info.version + 1;
  const key = await newProjectKey();
  const grants: { userId: number; wrapped: string }[] = [];
  for (const m of info.members) if (m.publicKey && (m.versions.length || m.userId === userId)) grants.push({ userId: m.userId, wrapped: await wrapProjectKey(key, m.publicKey, m.userId, version) });
  try { await keyApi.rotate(project, version, grants); }
  catch (e) { if ((e as { status?: number }).status === 409) { await ring.refresh(); return false; } throw e; }
  ring.add(version, key);
  return true;
}

/** Members who wait for the key (they have a key pair, not the project key): with their fingerprints. */
export async function waitingMembers(project: string): Promise<(KeyMember & { fingerprint: string })[]> {
  const info = await keyApi.projectKeys(project);
  const v = Math.max(1, info.version);
  const out: (KeyMember & { fingerprint: string })[] = [];
  for (const m of info.members) if (m.publicKey && !m.versions.includes(v)) out.push({ ...m, fingerprint: await fingerprint(m.publicKey) });
  return out;
}

/** Members who have no key pair yet (they have not opened an encrypted project): they need to first. */
export async function membersWithoutKeys(project: string): Promise<KeyMember[]> {
  return (await keyApi.projectKeys(project)).members.filter(m => !m.publicKey);
}

/** Give the project key to these members (every version, wrapped for their public keys: what was written before the newest is theirs to read too). */
export async function grantWaiting(project: string, userId: number, members: KeyMember[]): Promise<number> {
  const ring = await projectKey(project, userId);
  await ring.refresh();
  const grants = [];
  for (const m of members) if (m.publicKey) for (const [version, key] of ring.entries()) grants.push({ userId: m.userId, version, wrapped: await wrapProjectKey(key, m.publicKey, m.userId, version) });
  if (!grants.length) return 0;
  return (await keyApi.grant(project, grants)).granted;
}

/** Forget a project's key here (it was deleted, or access ended). */
export async function forgetProjectKey(project: string): Promise<void> {
  projectKeys.delete(project);
  await idbDelete(`project:${project}`).catch(() => {});
}

/**
 * The keys of end-to-end encrypted projects in this browser (crypto.ts has the primitives):
 *
 *  - the account's key pair: made here once (`setUpAccount`, which shows the recovery code), unlocked
 *    on any other device with that code (`unlockAccount`); the private key is kept in IndexedDB,
 *    non-extractable, and forgotten at sign-out (app/localData.ts);
 *  - each project's key: unwrapped from what the server keeps for this account, cached here;
 *  - members who joined since and wait for the key: any editor holding it can give it to them
 *    (`grantWaiting`) — only when they say so, since the server decides who is a member.
 */
import { newKeyPair, exportPublic, newRecoveryCode, sealPrivate, unsealPrivate, newProjectKey, wrapProjectKey, unwrapProjectKey, fingerprint } from './crypto';

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
export interface ProjectKeyInfo { version: number; mine: { version: number; wrapped: string }[]; members: KeyMember[] }
const enc = encodeURIComponent;
export const keyApi = {
  me: () => call<{ keys: ServerKeys | null }>('GET', '/api/e2e/me'),
  putMe: (publicKey: string, sealedPrivate: string, replace = false) => call<{ keys: ServerKeys }>('PUT', '/api/e2e/me', { publicKey, sealedPrivate, replace }),
  reseal: (sealedPrivate: string) => call<{ ok: boolean }>('POST', '/api/e2e/me/reseal', { sealedPrivate }),
  projectKeys: (project: string) => call<ProjectKeyInfo>('GET', `/api/e2e/projects/${enc(project)}/keys`),
  grant: (project: string, grants: { userId: number; version: number; wrapped: string }[]) => call<{ granted: number }>('POST', `/api/e2e/projects/${enc(project)}/keys`, { grants }),
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

const projectKeys = new Map<string, { key: CryptoKey; version: number }>();

export class KeyMissing extends Error {
  constructor(public reason: 'account' | 'waiting', message: string) { super(message); this.name = 'KeyMissing'; }
}

/** The project's key: from this session, this browser, or unwrapped from the server's copy for this account. */
export async function projectKey(project: string, userId: number): Promise<{ key: CryptoKey; version: number }> {
  const hit = projectKeys.get(project);
  if (hit) return hit;
  const d = await deviceKeys(userId);
  let info: ProjectKeyInfo | null = null;
  try { info = await keyApi.projectKeys(project); } catch (e) {
    // offline: the key this browser kept
    const kept = await idbGet<{ key: CryptoKey; version: number }>(`project:${project}`).catch(() => undefined);
    if (kept) { projectKeys.set(project, kept); return kept; }
    throw e;
  }
  if (!d) throw new KeyMissing('account', 'Unlock encrypted projects in this browser with your recovery code');
  const mine = info.mine.sort((a, b) => b.version - a.version)[0];
  if (!mine) throw new KeyMissing('waiting', 'A member who has the key must give it to you: they see a request when they open the project');
  const key = await unwrapProjectKey(mine.wrapped, d.privateKey, userId, mine.version);
  const out = { key, version: mine.version };
  projectKeys.set(project, out);
  void idbSet(`project:${project}`, out).catch(() => {});
  return out;
}

/** A new project's key, wrapped for its owner. */
export async function createProjectKey(project: string, userId: number): Promise<{ key: CryptoKey; version: number }> {
  const d = await deviceKeys(userId);
  if (!d) throw new KeyMissing('account', 'Set up encryption first');
  const key = await newProjectKey();
  await keyApi.grant(project, [{ userId, version: 1, wrapped: await wrapProjectKey(key, d.publicKey, userId, 1) }]);
  const out = { key, version: 1 };
  projectKeys.set(project, out);
  void idbSet(`project:${project}`, out).catch(() => {});
  return out;
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

/** Give the project key to these members (wrapped for their public keys). */
export async function grantWaiting(project: string, userId: number, members: KeyMember[]): Promise<number> {
  const { key, version } = await projectKey(project, userId);
  const grants = [];
  for (const m of members) if (m.publicKey) grants.push({ userId: m.userId, version, wrapped: await wrapProjectKey(key, m.publicKey, m.userId, version) });
  if (!grants.length) return 0;
  return (await keyApi.grant(project, grants)).granted;
}

/** Forget a project's key here (it was deleted, or access ended). */
export async function forgetProjectKey(project: string): Promise<void> {
  projectKeys.delete(project);
  await idbDelete(`project:${project}`).catch(() => {});
}

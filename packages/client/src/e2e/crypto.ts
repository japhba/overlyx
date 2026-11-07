/**
 * The cryptography of end-to-end encrypted projects (DOCS.md "End-to-end encrypted projects"), all
 * of it WebCrypto:
 *
 *  - a project's content is encrypted with its project key (AES-256-GCM, a fresh 96-bit IV per
 *    message); the additional data names what the ciphertext is (`ol1:<kind>:<id>`), so the server
 *    cannot pass one document's update off as another's, or a blob as an update. The key has
 *    versions (a member who leaves makes the others replace it, keys.ts): a ciphertext says which
 *    one it was made with;
 *  - every account has an ECDH P-256 key pair: the project key reaches a member wrapped for their
 *    public key (an ephemeral ECDH exchange → HKDF → AES-GCM, ECIES-like);
 *  - the private key is kept on the server only sealed with the account's recovery code (128 random
 *    bits shown once, as Crockford base32), so a new device can unlock it; on a device it lives in
 *    IndexedDB as a non-extractable key (keys.ts).
 */

const enc = new TextEncoder();
const subtle = () => globalThis.crypto.subtle;
/** a ciphertext: `[1, iv, ct]` (made with a project's first key; sealed and wrapped keys), `[2, key version (2 bytes), iv, ct]` */
const VERSION = 1, VERSION_KEYED = 2;

/* ------------------------------------------------------------------------ encodings */

export function b64u(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function unb64u(text: string): Uint8Array {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
const buf = (u: Uint8Array): ArrayBuffer => (u.byteOffset === 0 && u.byteLength === u.buffer.byteLength ? u.buffer : u.slice().buffer) as ArrayBuffer;

/** a random URL-safe id (documents, blobs): 128 bits */
export function randomId(): string { return b64u(globalThis.crypto.getRandomValues(new Uint8Array(16))); }

/* ---------------------------------------------------------------------- project key */

export async function newProjectKey(): Promise<CryptoKey> {
  return subtle().generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

/** additional data: what a ciphertext is (`kind`: doc, aw, blob, manifest…) and of which id */
const ad = (kind: string, id: string) => enc.encode(`ol1:${kind}:${id}`);

/** `keyVersion`: the version of the project key `key` is (1 for anything else) */
export async function encrypt(key: CryptoKey, plain: Uint8Array, kind: string, id: string, keyVersion = 1): Promise<Uint8Array> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: buf(iv), additionalData: buf(ad(kind, id)) }, key, buf(plain)));
  const head = keyVersion === 1 ? 1 : 3;
  const out = new Uint8Array(head + 12 + ct.length);
  if (keyVersion === 1) out[0] = VERSION;
  else { out[0] = VERSION_KEYED; out[1] = keyVersion >> 8; out[2] = keyVersion & 255; }
  out.set(iv, head); out.set(ct, head + 12);
  return out;
}

/** Which version of the project key a ciphertext was made with (0: not a ciphertext of ours). */
export function keyVersionOf(data: Uint8Array): number {
  if (data[0] === VERSION) return 1;
  if (data[0] === VERSION_KEYED && data.length > 3) return (data[1] << 8) | data[2];
  return 0;
}

export async function decrypt(key: CryptoKey, data: Uint8Array, kind: string, id: string): Promise<Uint8Array> {
  const head = data[0] === VERSION ? 1 : data[0] === VERSION_KEYED ? 3 : 0;
  if (!head || data.length < head + 12 + 16) throw new Error('not an OverLyX ciphertext');
  return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: buf(data.subarray(head, head + 12)), additionalData: buf(ad(kind, id)) }, key, buf(data.subarray(head + 12))));
}

/** What encrypts a project's content and decrypts it: its keys (keys.ts Keyring). */
export interface Cipher {
  encrypt(plain: Uint8Array, kind: string, id: string): Promise<Uint8Array>;
  decrypt(data: Uint8Array, kind: string, id: string): Promise<Uint8Array>;
  /** the relay says which version is the newest */
  noteVersion?(version: number): void;
}

/* ------------------------------------------------------------------- account key pair */

export async function newKeyPair(): Promise<CryptoKeyPair> {
  // extractable once, to be sealed with the recovery code; kept non-extractable afterwards (keys.ts)
  return subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as Promise<CryptoKeyPair>;
}

export async function exportPublic(key: CryptoKey): Promise<string> {
  return b64u(new Uint8Array(await subtle().exportKey('spki', key)));
}
export async function importPublic(spki: string): Promise<CryptoKey> {
  return subtle().importKey('spki', buf(unb64u(spki)), { name: 'ECDH', namedCurve: 'P-256' }, true, []);
}

/** A short fingerprint of a public key, to compare out of band ("safety number"). */
export async function fingerprint(spki: string): Promise<string> {
  const h = new Uint8Array(await subtle().digest('SHA-256', buf(unb64u(spki))));
  return [...h.subarray(0, 10)].map(b => b.toString(16).padStart(2, '0')).join('').replace(/(.{4})(?!$)/g, '$1 ');
}

/* -------------------------------------------------------------------- recovery code */

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 128 random bits as Crockford base32: 26 characters in groups of four/two */
export function newRecoveryCode(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out.replace(/(.{4})(?!$)/g, '$1-');
}

/** The code as typed (any case, spaces / dashes, O for 0, I/L for 1) → its bytes, or null. */
export function parseRecoveryCode(text: string): Uint8Array | null {
  const s = text.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (s.length !== 26) return null;
  const out = new Uint8Array(16);
  let bits = 0, value = 0, n = 0;
  for (const ch of s) {
    const v = B32.indexOf(ch);
    if (v < 0) return null;
    value = (value << 5) | v; bits += 5;
    if (bits >= 8) { if (n < 16) out[n++] = (value >>> (bits - 8)) & 255; bits -= 8; }
  }
  return n === 16 ? out : null;
}

async function hkdfKey(secret: Uint8Array, salt: string, info: string): Promise<CryptoKey> {
  const base = await subtle().importKey('raw', buf(secret), 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: buf(enc.encode(salt)), info: buf(enc.encode(info)) }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** The private key sealed with the recovery code (what the server keeps). */
export async function sealPrivate(priv: CryptoKey, code: string, userId: number): Promise<string> {
  const bytes = parseRecoveryCode(code);
  if (!bytes) throw new Error('bad recovery code');
  const k = await hkdfKey(bytes, 'overlyx-e2e-recovery', 'seal');
  const pkcs8 = new Uint8Array(await subtle().exportKey('pkcs8', priv));
  return b64u(await encrypt(k, pkcs8, 'seal', String(userId)));
}

/** The private key unsealed with the recovery code (non-extractable unless it is to be sealed anew), or an error for a wrong code. */
export async function unsealPrivate(sealed: string, code: string, userId: number, extractable = false): Promise<CryptoKey> {
  const bytes = parseRecoveryCode(code);
  if (!bytes) throw new Error('That is not a recovery code (26 letters and digits)');
  const k = await hkdfKey(bytes, 'overlyx-e2e-recovery', 'seal');
  let pkcs8: Uint8Array;
  try { pkcs8 = await decrypt(k, unb64u(sealed), 'seal', String(userId)); }
  catch { throw new Error('This recovery code does not unlock the key of this account'); }
  return subtle().importKey('pkcs8', buf(pkcs8), { name: 'ECDH', namedCurve: 'P-256' }, extractable, ['deriveBits']);
}

/* ----------------------------------------------------------- wrapping the project key */

async function wrapKeyFor(sharedSecret: Uint8Array, ephemeral: Uint8Array, userId: number, version: number): Promise<CryptoKey> {
  return hkdfKey(sharedSecret, 'overlyx-e2e-wrap:' + b64u(ephemeral), `${userId}:${version}`);
}

/** The project key for a member's public key: `<ephemeral public key>.<ciphertext>`. */
export async function wrapProjectKey(projectKey: CryptoKey, memberPublic: string, userId: number, version: number): Promise<string> {
  const eph = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const pub = await importPublic(memberPublic);
  const secret = new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: pub }, eph.privateKey, 256));
  const ephSpki = new Uint8Array(await subtle().exportKey('spki', eph.publicKey));
  const k = await wrapKeyFor(secret, ephSpki, userId, version);
  const raw = new Uint8Array(await subtle().exportKey('raw', projectKey));
  return `${b64u(ephSpki)}.${b64u(await encrypt(k, raw, 'wrap', `${userId}:${version}`))}`;
}

export async function unwrapProjectKey(wrapped: string, priv: CryptoKey, userId: number, version: number): Promise<CryptoKey> {
  const [e, c] = wrapped.split('.');
  if (!e || !c) throw new Error('bad wrapped key');
  const ephSpki = unb64u(e);
  const eph = await subtle().importKey('spki', buf(ephSpki), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secret = new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: eph }, priv, 256));
  const k = await wrapKeyFor(secret, ephSpki, userId, version);
  const raw = await decrypt(k, unb64u(c), 'wrap', `${userId}:${version}`);
  return subtle().importKey('raw', buf(raw), { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
}

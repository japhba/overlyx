/**
 * Secrets of an account kept at rest — API keys, the Google Drive / LessWrong / Zotero
 * authorisations, account tokens kept for copying again: AES-256-GCM under a key derived from the
 * sealing key and the secret's purpose. The sealing key (`<data dir>/sealing.key`, made on first
 * use) is in no backup — the owner keeps a copy offline (DOCS.md "Secrets") — so a copy of the
 * database or a backup reveals none of them. A value the key cannot open (a restore without it)
 * reads as not connected (`open`): the account connects again.
 *
 * Sealed values start with `s2.`. Until 7 Nov 2026 they were sealed under the login secret
 * (secret.key, which every backup holds) and had no prefix: those still open, and `reseal` rewrites
 * them — and the token copies once kept in plain text — at start-up.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config, JWT_SECRET } from './config.ts';
import { db } from './db.ts';

const PREFIX = 's2.';

// which sealing key the database's secrets were sealed with (a fingerprint): a start with another
// one — a restore without the owner's copy — says so instead of failing quietly feature by feature
db.exec('CREATE TABLE IF NOT EXISTS sealing_key (id INTEGER PRIMARY KEY CHECK (id = 1), fingerprint TEXT NOT NULL, created_at INTEGER NOT NULL)');

let master: Buffer | null = null;
function sealingKey(): Buffer {
  if (master) return master;
  const file = path.join(config.dataDir, 'sealing.key');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
    console.warn(`[sealed] made a new sealing key, ${file}: keep a copy offline — no backup holds it (DOCS.md "Secrets")`);
  }
  const hex = fs.readFileSync(file, 'utf8').trim();
  const fingerprint = crypto.createHash('sha256').update('overlyx-sealing-fingerprint:' + hex).digest('hex').slice(0, 16);
  const known = db.prepare('SELECT fingerprint FROM sealing_key WHERE id = 1').get() as { fingerprint: string } | undefined;
  if (!known) db.prepare('INSERT INTO sealing_key (id, fingerprint, created_at) VALUES (1, ?, ?)').run(fingerprint, Date.now());
  else if (known.fingerprint !== fingerprint) {
    console.error(`[sealed] ${file} is not the key this database's secrets were sealed with (fingerprint ${known.fingerprint}): API keys and the Drive, LessWrong and Zotero connections read as not connected — put the owner's copy of sealing.key back and restart, or, if it is lost for good, DELETE FROM sealing_key to silence this`);
  }
  return (master = Buffer.from(hex, 'hex'));
}

export function sealer(purpose: string): {
  seal(plain: string): string;
  unseal(sealed: string): string;
  /** unseal, or null when the value cannot be opened (sealed under a sealing key this server does not have) */
  open(sealed: string): string | null;
  /** once at start-up: seal the column's older values again under the sealing key — sealed under the login secret, or (`plain`) not sealed at all */
  reseal(table: string, column: string, from?: 'legacy' | 'plain'): void;
} {
  let key: Buffer | null = null;
  const current = () => (key ??= Buffer.from(crypto.hkdfSync('sha256', sealingKey(), Buffer.alloc(0), `overlyx-${purpose}`, 32)));
  const legacy = () => crypto.createHash('sha256').update(`overlyx-${purpose}:` + JWT_SECRET).digest();
  const seal = (plain: string): string => {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', current(), iv);
    const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return PREFIX + [iv, c.getAuthTag(), body].map(b => b.toString('base64url')).join('.');
  };
  const unseal = (sealed: string): string => {
    const now = sealed.startsWith(PREFIX);
    const [iv, tag, body] = (now ? sealed.slice(PREFIX.length) : sealed).split('.').map(s => Buffer.from(s, 'base64url'));
    const d = crypto.createDecipheriv('aes-256-gcm', now ? current() : legacy(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(body), d.final()]).toString('utf8');
  };
  const open = (sealed: string): string | null => { try { return unseal(sealed); } catch { return null; } };
  const reseal = (table: string, column: string, from: 'legacy' | 'plain' = 'legacy') => {
    const rows = db.prepare(`SELECT rowid AS id, ${column} AS v FROM ${table} WHERE ${column} IS NOT NULL AND substr(${column}, 1, ${PREFIX.length}) <> '${PREFIX}'`).all() as { id: number; v: string }[];
    if (!rows.length) return;
    const put = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`);
    let done = 0;
    db.transaction(() => {
      for (const r of rows) {
        const plain = from === 'plain' ? r.v : open(r.v);
        if (plain !== null) { put.run(seal(plain), r.id); done++; }
      }
    })();
    console.log(`[sealed] ${table}.${column}: ${done} sealed under sealing.key` + (done < rows.length ? `, ${rows.length - done} could not be opened` : ''));
  };
  return { seal, unseal, open, reseal };
}

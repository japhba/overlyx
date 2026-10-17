/**
 * Secrets of an account kept at rest (a Zotero API key): AES-256-GCM under a key derived from the
 * server's JWT secret and the secret's purpose, so a copy of the database alone does not reveal them.
 * (gdocs/google.ts seals the Drive tokens the same way.)
 */
import crypto from 'node:crypto';
import { JWT_SECRET } from './config.ts';

export function sealer(purpose: string): { seal(plain: string): string; unseal(sealed: string): string } {
  const key = crypto.createHash('sha256').update(`overlyx-${purpose}:` + JWT_SECRET).digest();
  return {
    seal(plain) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
      return [iv, c.getAuthTag(), body].map(b => b.toString('base64url')).join('.');
    },
    unseal(sealed) {
      const [iv, tag, body] = sealed.split('.').map(s => Buffer.from(s, 'base64url'));
      const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(body), d.final()]).toString('utf8');
    },
  };
}

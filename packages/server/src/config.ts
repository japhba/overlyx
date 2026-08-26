import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '../../..');

export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  dataDir: path.resolve(process.env.OVERLYX_DATA_DIR ?? path.join(REPO_ROOT, 'data')),
  /** directory whose sub-directories are projects (each may hold .lyx files) */
  projectsDir: path.resolve(process.env.OVERLYX_PROJECTS_DIR ?? '/root/projects'),
  layoutDir: process.env.LYX_LAYOUT_DIR ?? '/root/lyx/lib/layouts',
  lyxBin: process.env.OVERLYX_LYX_BIN ?? 'lyx',
  lyx2lyx: process.env.OVERLYX_LYX2LYX ?? '/root/lyx/lib/lyx2lyx/lyx2lyx',
  publicUrl: process.env.OVERLYX_PUBLIC_URL ?? '',
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
  },
  clientDist: path.join(REPO_ROOT, 'packages/client/dist'),
  /** debounce for writing .lyx files back to disk (ms) */
  saveDebounceMs: Number(process.env.OVERLYX_SAVE_DEBOUNCE ?? 1500),
  /** minimum interval between automatic versions (ms) */
  autoVersionIntervalMs: Number(process.env.OVERLYX_AUTOVERSION_MS ?? 10 * 60 * 1000),
  sessionDays: 30,
};

fs.mkdirSync(config.dataDir, { recursive: true });
for (const d of ['cache', 'build', 'uploads']) fs.mkdirSync(path.join(config.dataDir, d), { recursive: true });

const secretFile = path.join(config.dataDir, 'secret.key');
if (!fs.existsSync(secretFile)) {
  fs.writeFileSync(secretFile, crypto.randomBytes(48).toString('hex'), { mode: 0o600 });
}
export const JWT_SECRET = fs.readFileSync(secretFile, 'utf8').trim();

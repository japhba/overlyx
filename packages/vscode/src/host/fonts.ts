/**
 * Google fonts in the VS Code editors, as on overlyx.app (client app/FontPicker.tsx,
 * fonts/googlefont.ts, fonts/myfonts.ts): the bridge (bridge.ts) answers the webviews' /api/fonts/*
 * from the OverLyX server this computer is signed in to (the CLI's and the extension's sign-in,
 * ~/.config/overlyx/hosts.json; overlyx.app first), through its git API (server git.ts: the web app's
 * font routes with that sign-in). What it got is kept on this computer — the font files for good
 * (a file never changes under its name), the catalogue, stylesheets and font descriptions refreshed
 * once a day when the server answers — so a font once shown works offline. The account's My fonts
 * are fetched as soon as their list is read, with every axis and OpenType feature (the server's files
 * are the google/fonts repository's complete ones). Signed in nowhere: the catalogue says `signin`
 * and the font list asks to sign in.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { signedInHosts, syncCredentials } from '../../../cli/bin/overlyx.js';

export interface FontResponse { status: number; type: string; body: Buffer | string; cache?: string }

const DEFAULT_HOST = 'https://overlyx.app';
const DAY = 24 * 3600 * 1000;
const FAMILY = /^[A-Za-z0-9][A-Za-z0-9 ]{0,59}$/;
const slugOf = (family: string) => family.trim().toLowerCase().replace(/\s+/g, '-');
const json = (status: number, v: unknown): FontResponse => ({ status, type: 'application/json; charset=utf-8', body: JSON.stringify(v) });

let known: { at: number; value: Promise<{ host: string; authorization: string } | null> } | null = null;
/** the server to ask and its sign-in (null: signed in nowhere) — looked up again after a minute (a sign-in, a sign-out) */
function account(): Promise<{ host: string; authorization: string } | null> {
  if (!known || Date.now() - known.at > 60000) known = { at: Date.now(), value: lookUp() };
  return known.value;
}
async function lookUp(): Promise<{ host: string; authorization: string } | null> {
  let hosts: { host: string }[] = [];
  try { hosts = signedInHosts(); } catch { /* no CLI configuration */ }
  const host = hosts.find(h => h.host === DEFAULT_HOST)?.host ?? hosts[0]?.host;
  if (!host) return null;
  const auth = await syncCredentials(host, os.homedir());
  return auth ? { host, authorization: 'Basic ' + Buffer.from(`${auth.username}:${auth.token}`, 'utf8').toString('base64') } : null;
}

/**
 * The bridge's /api/fonts/<sub>: `fontService(dir)` keeps what it fetched in `dir`. `sub`: catalog,
 * google.css, google/<slug>/<file>, info, sample (with `?family=`), mine (GET, PUT `body`). `who`:
 * the server and sign-in (tests give their own).
 */
export function fontService(dir: string, who: () => Promise<{ host: string; authorization: string } | null> = account): (method: string, sub: string, search: string, body?: unknown) => Promise<FontResponse> {
  const ask = async (sub: string, search: string, init: RequestInit = {}): Promise<Response | null> => {
    const a = await who();
    if (!a) return null;
    return fetch(`${a.host}/git/api/fonts/${sub}${search}`, { ...init, headers: { ...init.headers as Record<string, string>, Authorization: a.authorization }, signal: AbortSignal.timeout(60000) });
  };
  const write = (file: string, data: Buffer | string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.new', data);
    fs.renameSync(file + '.new', file);
  };
  /** the cached answer when it is younger than `maxAge` (Infinity: whatever its age), else the server's, kept; the stale copy when the server does not answer */
  const cached = async (file: string, maxAge: number, sub: string, search: string): Promise<{ data: Buffer; status: number } | null> => {
    let age = Infinity;
    try { age = Date.now() - fs.statSync(file).mtimeMs; } catch { /* not kept yet */ }
    if (age < maxAge) return { data: fs.readFileSync(file), status: 200 };
    try {
      const r = await ask(sub, search);
      if (r?.ok) { const data = Buffer.from(await r.arrayBuffer()); write(file, data); return { data, status: 200 }; }
      if (r && r.status === 404 && age === Infinity) return { data: Buffer.alloc(0), status: 404 };
    } catch { /* offline */ }
    return age < Infinity ? { data: fs.readFileSync(file), status: 200 } : null;
  };

  /** a family's stylesheet and the files it names: kept, for offline use */
  const fetchFamily = async (family: string) => {
    const css = await cached(path.join(dir, 'css', slugOf(family) + '.css'), DAY, 'google.css', '?family=' + encodeURIComponent(family));
    if (css?.status !== 200) return;
    for (const m of css.data.toString('utf8').matchAll(/url\((?:\/api\/fonts\/)?google\/([a-z0-9-]{1,60})\/([a-z0-9-]{1,80}\.ttf)\)/g)) {
      await cached(path.join(dir, 'files', m[1], m[2]), Infinity, `google/${m[1]}/${m[2]}`, '');
    }
  };
  let fetching: Promise<void> = Promise.resolve();

  return async (method, sub, search, body) => {
    const family = new URLSearchParams(search).get('family') ?? '';
    const q = '?family=' + encodeURIComponent(family);
    if (sub === 'mine') {
      const file = path.join(dir, 'mine.json');
      try {
        const r = await ask('mine', '', method === 'PUT' ? { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) } : {});
        if (!r) return json(401, { error: 'Sign in to OverLyX (OverLyX: Sign In…) to keep fonts in your account' });
        const text = await r.text();
        if (!r.ok) return { status: r.status, type: 'application/json; charset=utf-8', body: text };
        write(file, text);
        // the account's fonts, ready for offline use (one after the other, in the background)
        try { for (const f of (JSON.parse(text) as { fonts?: unknown }).fonts as string[] ?? []) if (typeof f === 'string' && FAMILY.test(f)) fetching = fetching.then(() => fetchFamily(f)).catch(() => {}); } catch { /* not a list */ }
        return { status: 200, type: 'application/json; charset=utf-8', body: text };
      } catch {
        if (method === 'GET' && fs.existsSync(file)) return { status: 200, type: 'application/json; charset=utf-8', body: fs.readFileSync(file) };
        return json(503, { error: 'The OverLyX server does not answer' });
      }
    }
    if (method !== 'GET') return json(405, { error: 'not allowed' });
    if (sub === 'catalog') {
      if (!await who()) return json(200, { axisNames: {}, families: [], signin: true });
      const got = await cached(path.join(dir, 'catalog.json'), DAY, 'catalog', '');
      return got?.status === 200 ? { status: 200, type: 'application/json; charset=utf-8', body: got.data } : json(200, { axisNames: {}, families: [] });
    }
    if (sub === 'google.css') {
      if (!FAMILY.test(family)) return { status: 200, type: 'text/css', body: '' };
      const got = await cached(path.join(dir, 'css', slugOf(family) + '.css'), DAY, 'google.css', q);
      // (an older server names the files from its root: here they are relative to this stylesheet)
      return { status: 200, type: 'text/css', body: got?.status === 200 ? got.data.toString('utf8').replace(/url\(\/api\/fonts\/google\//g, 'url(google/') : '', cache: 'no-cache' };
    }
    const file = /^google\/([a-z0-9-]{1,60})\/([a-z0-9-]{1,80}\.ttf)$/.exec(sub);
    if (file) {
      const got = await cached(path.join(dir, 'files', file[1], file[2]), Infinity, sub, '');
      return got?.status === 200 ? { status: 200, type: 'font/ttf', body: got.data, cache: 'max-age=31536000, immutable' } : json(404, { error: 'no such font file' });
    }
    if (sub === 'info' || sub === 'sample') {
      if (!FAMILY.test(family)) return json(404, { error: 'not a Google font' });
      const got = await cached(path.join(dir, sub, slugOf(family) + (sub === 'info' ? '.json' : '.ttf')), sub === 'info' ? DAY : Infinity, sub, q);
      return got?.status === 200 ? { status: 200, type: sub === 'info' ? 'application/json; charset=utf-8' : 'font/ttf', body: got.data } : json(404, { error: 'not a Google font here' });
    }
    return json(404, { error: 'not found' });
  };
}

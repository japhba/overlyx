/**
 * Google Fonts for markdown documents (core md/typesetting.ts): a family named in the front matter
 * that TeX Live does not have (MD_FONTS) is fetched from Google Fonts once, kept in the data
 * directory, and used from there — by the PDF (copied into the build directory, loaded by file with
 * fontspec: md/latex.ts `fontFiles`) and by the editor (served from this server: the browser never
 * asks Google, and the app's CSP keeps font-src 'self').
 *
 * Google's css2 API answers a client that is no browser with TrueType files, one static file per
 * weight and style: regular, bold, italic and bold italic are asked for, and a family without some
 * of them gets fewer. Only the family's name leaves the server, to fonts.googleapis.com and
 * fonts.gstatic.com (fixed hosts). A name Google does not know is remembered for a day.
 * OVERLYX_GOOGLE_FONTS=off switches it off.
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';

export interface GoogleFontFile { style: 'normal' | 'italic'; weight: number; file: string }
export interface GoogleFont { family: string; slug: string; dir: string; files: GoogleFontFile[] }

const enabled = () => process.env.OVERLYX_GOOGLE_FONTS !== 'off';
const ROOT = () => path.join(config.dataDir, 'cache', 'google-fonts');
const MISSING_MS = 24 * 3600 * 1000;
const MAX_FILE = 12 * 1024 * 1024;

export const validFamily = (name: string) => /^[A-Za-z0-9][A-Za-z0-9 ]{0,59}$/.test(name.trim());
const slugOf = (family: string) => family.trim().toLowerCase().replace(/\s+/g, '-');

/** injectable for tests */
export let fetchImpl: typeof fetch = (input, init) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(15000) });
export function setFetch(f: typeof fetch): void { fetchImpl = f; }

const pending = new Map<string, Promise<GoogleFont | null>>();

/** The family's files (fetched the first time), or null: not a Google font, switched off, or Google did not answer. */
export function googleFont(family: string): Promise<GoogleFont | null> {
  if (!enabled() || !validFamily(family)) return Promise.resolve(null);
  const slug = slugOf(family);
  const running = pending.get(slug);
  if (running) return running;
  const task = load(family.trim(), slug).finally(() => pending.delete(slug));
  pending.set(slug, task);
  return task;
}

async function load(family: string, slug: string): Promise<GoogleFont | null> {
  const dir = path.join(ROOT(), slug);
  const manifest = path.join(dir, 'font.json');
  try {
    const m = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { family: string; files?: GoogleFontFile[]; missingAt?: number };
    if (m.files?.length && m.files.every(f => fs.existsSync(path.join(dir, f.file)))) return { family: m.family, slug, dir, files: m.files };
    if (m.missingAt && Date.now() - m.missingAt < MISSING_MS) return null;
  } catch { /* not fetched yet */ }
  try {
    const q = encodeURIComponent(family).replace(/%20/g, '+');
    let r = await fetchImpl(`https://fonts.googleapis.com/css2?family=${q}:ital,wght@0,400;0,700;1,400;1,700`);
    if (!r.ok) r = await fetchImpl(`https://fonts.googleapis.com/css2?family=${q}`);
    if (!r.ok) { remember(dir, manifest, { family, missingAt: Date.now() }); return null; }
    const css = await r.text();
    const files: GoogleFontFile[] = [];
    for (const block of css.split('@font-face').slice(1)) {
      const style = /font-style:\s*(italic|normal)/.exec(block)?.[1] as 'italic' | 'normal' | undefined;
      const weight = Number(/font-weight:\s*(\d+)/.exec(block)?.[1]);
      const url = /src:\s*url\((https:\/\/fonts\.gstatic\.com\/[^)\s]+\.ttf)\)/.exec(block)?.[1];
      if (!style || !weight || !url || files.some(f => f.style === style && f.weight === weight)) continue;
      const f = await fetchImpl(url);
      if (!f.ok) continue;
      const data = Buffer.from(await f.arrayBuffer());
      if (!data.length || data.length > MAX_FILE) continue;
      const file = `${slug}-${weight}${style === 'italic' ? 'i' : ''}.ttf`;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, file), data);
      files.push({ style, weight, file });
    }
    if (!files.length) { remember(dir, manifest, { family, missingAt: Date.now() }); return null; }
    remember(dir, manifest, { family, files });
    console.log(`[fonts] fetched "${family}" from Google Fonts (${files.length} files)`);
    return { family, slug, dir, files };
  } catch (e) {
    console.warn(`[fonts] "${family}": ${(e as Error).message}`);
    return null;
  }
}

function remember(dir: string, manifest: string, value: unknown): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify(value));
}

/** regular / bold / italic / bold italic of a family (the nearest: what Google has), for fontspec */
export function fontFaces(f: GoogleFont): { regular: string; bold?: string; italic?: string; boldItalic?: string } {
  const pick = (style: 'normal' | 'italic', weight: number) => f.files.find(x => x.style === style && x.weight === weight)?.file;
  const regular = pick('normal', 400) ?? f.files.find(x => x.style === 'normal')?.file ?? f.files[0].file;
  return { regular, bold: pick('normal', 700), italic: pick('italic', 400), boldItalic: pick('italic', 700) };
}

/** The editor's side: @font-face rules for a family (files from this server), and the files. */
export function googleFontRoutes(): express.Router {
  const r = express.Router();
  r.get('/fonts/google.css', async (req, res) => {
    const family = String(req.query.family ?? '');
    const f = validFamily(family) ? await googleFont(family) : null;
    res.type('text/css').setHeader('Cache-Control', 'private, max-age=86400');
    if (!f) { res.send(`/* "${family.replace(/[^\w ]/g, '')}": not a Google font here */`); return; }
    res.send(f.files.map(x => `@font-face { font-family: ${JSON.stringify(f.family)}; font-style: ${x.style}; font-weight: ${x.weight}; font-display: swap; src: url(/api/fonts/google/${f.slug}/${x.file}) format('truetype'); }`).join('\n'));
  });
  r.get('/fonts/google/:slug/:file', (req, res) => {
    const { slug, file } = req.params;
    if (!/^[a-z0-9-]{1,60}$/.test(slug) || !/^[a-z0-9-]{1,70}\.ttf$/.test(file)) { res.status(404).end(); return; }
    const abs = path.join(ROOT(), slug, file);
    if (!fs.existsSync(abs)) { res.status(404).end(); return; }
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.type('font/ttf').sendFile(abs);
  });
  return r;
}

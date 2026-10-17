/**
 * Google Fonts, for markdown documents' typesetting (core md/typesetting.ts) and for fonts by name on
 * runs of text (core fontface.ts, the toolbar's font list). A family is fetched once, kept in the data
 * directory and used from there — by the PDF (copied into the build directory: fontspec loads a
 * typesetting font by file, md/latex.ts `fontFiles`, and \olfont finds a family by name in it,
 * OSFONTDIR) and by the editor (served from this server: the browser never asks Google, and the
 * app's CSP keeps font-src 'self').
 *
 * Which files: Google's catalogue (fonts.google.com/metadata/fonts, kept a week) says which families
 * exist, their axes and weights. A variable family comes as its variable font files (upright and
 * italic) from the google/fonts repository on GitHub — every weight, width, optical size … in one
 * file, which LuaTeX sets by axis like the browser does; a family of static faces as its faces from
 * there too. The repository's files are the complete fonts: the css2 API's TrueType files lack most
 * OpenType features (Inter's: 11 of 43), so it is only the fallback, as when GitHub does not answer.
 * Only a family's name leaves the server, to fixed hosts. A name Google does not know is remembered
 * for a day. OVERLYX_GOOGLE_FONTS=off switches it off.
 *
 *   GET /api/fonts/catalog              the catalogue: families, category, axes, weights, popularity
 *   GET /api/fonts/google.css?family=   @font-face rules for the family's files (variable: weight / width ranges)
 *   GET /api/fonts/google/<slug>/<file> a file
 *   GET /api/fonts/info?family=         its axes and named instances, weights, OpenType features (fontinfo.ts)
 *   GET /api/fonts/sample?family=       the family's name in its own face (a few glyphs: the font list)
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';
import { fontFileInfo, type FontFileInfo } from './fontinfo.ts';

export interface GoogleFontFile { style: 'normal' | 'italic'; weight: number; file: string }
export interface GoogleFont {
  family: string; slug: string; dir: string; files: GoogleFontFile[];
  /** variable font files (one upright, one italic): their axes' ranges */
  axes?: CatalogAxis[];
}
export interface CatalogAxis { t: string; min: number; max: number; d: number }
/** a family of the catalogue: name, category, axes (variable), static weights, italics, popularity rank */
export interface CatalogFamily { f: string; c: string; a: CatalogAxis[]; w: number[]; i: boolean; p: number }
export interface Catalog { at: number; axisNames: Record<string, string>; families: CatalogFamily[] }

const enabled = () => process.env.OVERLYX_GOOGLE_FONTS !== 'off';
const ROOT = () => path.join(config.dataDir, 'cache', 'google-fonts');
const MISSING_MS = 24 * 3600 * 1000;
const CATALOG_MS = 7 * 24 * 3600 * 1000;
const MAX_FILE = 12 * 1024 * 1024;
const MAX_STATIC = 24;
const GITHUB_RAW = 'https://raw.githubusercontent.com/google/fonts/main/';
const GITHUB_API = 'https://api.github.com/repos/google/fonts/contents/';

export const validFamily = (name: string) => /^[A-Za-z0-9][A-Za-z0-9 ]{0,59}$/.test(name.trim());
const slugOf = (family: string) => family.trim().toLowerCase().replace(/\s+/g, '-');

/** injectable for tests */
export let fetchImpl: typeof fetch = (input, init) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(20000) });
export function setFetch(f: typeof fetch): void { fetchImpl = f; catalogMem = null; }

/* ------------------------------------------------------------------ the catalogue */

let catalogMem: Catalog | null = null;
let catalogTask: Promise<Catalog | null> | null = null;

/** Google's catalogue of families (null: not fetched and Google does not answer) */
export async function googleCatalog(): Promise<Catalog | null> {
  if (!enabled()) return null;
  const file = path.join(ROOT(), 'catalog.json');
  if (!catalogMem) { try { catalogMem = JSON.parse(fs.readFileSync(file, 'utf8')) as Catalog; } catch { /* not fetched yet */ } }
  if (catalogMem && Date.now() - catalogMem.at < CATALOG_MS) return catalogMem;
  catalogTask ??= (async () => {
    try {
      const r = await fetchImpl('https://fonts.google.com/metadata/fonts');
      if (!r.ok) return catalogMem;
      let text = await r.text();
      if (text.startsWith(")]}'")) text = text.slice(4);
      const raw = JSON.parse(text) as { axisRegistry?: { tag: string; displayName: string }[]; familyMetadataList?: { family: string; category: string; fonts: Record<string, unknown>; axes?: { tag: string; min: number; max: number; defaultValue: number }[]; popularity?: number }[] };
      const families: CatalogFamily[] = (raw.familyMetadataList ?? []).filter(f => validFamily(f.family)).map(f => {
        const keys = Object.keys(f.fonts ?? {});
        return {
          f: f.family, c: f.category ?? '', p: f.popularity ?? 9999,
          a: (f.axes ?? []).map(a => ({ t: a.tag, min: a.min, max: a.max, d: a.defaultValue })),
          w: [...new Set(keys.map(k => parseInt(k, 10)).filter(n => n > 0))].sort((x, y) => x - y),
          i: keys.some(k => k.endsWith('i')),
        };
      }).sort((x, y) => x.p - y.p);
      const axisNames = Object.fromEntries((raw.axisRegistry ?? []).map(a => [a.tag, a.displayName]));
      catalogMem = { at: Date.now(), axisNames, families };
      fs.mkdirSync(ROOT(), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(catalogMem));
      return catalogMem;
    } catch (e) {
      console.warn(`[fonts] Google's catalogue: ${(e as Error).message}`);
      return catalogMem;
    } finally { catalogTask = null; }
  })();
  return catalogTask;
}

const findFamily = (c: Catalog, family: string) => c.families.find(x => x.f.toLowerCase() === family.trim().toLowerCase()) ?? null;

/* ------------------------------------------------------------------ a family's files */

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

/** `v`: how the files were chosen — a family cached before the variable files (css2's static ones) is fetched again */
interface Manifest { v?: number; family: string; files?: GoogleFontFile[]; axes?: CatalogAxis[]; missingAt?: number }
const MANIFEST_V = 2;

async function load(family: string, slug: string): Promise<GoogleFont | null> {
  const dir = path.join(ROOT(), slug);
  const manifest = path.join(dir, 'font.json');
  try {
    const m = JSON.parse(fs.readFileSync(manifest, 'utf8')) as Manifest;
    if (m.v === MANIFEST_V && m.files?.length && m.files.every(f => fs.existsSync(path.join(dir, f.file)))) return { family: m.family, slug, dir, files: m.files, ...(m.axes ? { axes: m.axes } : {}) };
    if (m.missingAt && Date.now() - m.missingAt < MISSING_MS) return null;
  } catch { /* not fetched yet */ }
  try {
    const catalog = await googleCatalog();
    const entry = catalog ? findFamily(catalog, family) : null;
    if (catalog && !entry) { remember(dir, manifest, { family, missingAt: Date.now() }); return null; }
    const name = entry?.f ?? family;
    let got: { files: GoogleFontFile[]; axes?: CatalogAxis[] } = { files: [] };
    if (entry?.a.length) got = await fromGithubVariable(entry, slug, dir);
    else if (entry) got = await fromGithubStatic(entry, slug, dir);
    if (!got.files.length) got = { files: await fromCss2(name, entry, slug, dir) };
    if (!got.files.length) { remember(dir, manifest, { family: name, missingAt: Date.now() }); return null; }
    remember(dir, manifest, { family: name, ...got });
    console.log(`[fonts] fetched "${name}" (${got.axes ? 'variable, ' : ''}${got.files.length} files)`);
    return { family: name, slug, dir, ...got };
  } catch (e) {
    console.warn(`[fonts] "${family}": ${(e as Error).message}`);
    return null;
  }
}

function remember(dir: string, manifest: string, value: Manifest): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify({ v: MANIFEST_V, ...value }));
}

/** the file's bytes, or null (not there, too big) */
async function download(url: string): Promise<Buffer | null> {
  const r = await fetchImpl(url);
  if (!r.ok) return null;
  const data = Buffer.from(await r.arrayBuffer());
  return data.length && data.length <= MAX_FILE ? data : null;
}

const repoDirs = (entry: CatalogFamily) => ['ofl', 'apache', 'ufl'].map(l => `${l}/${entry.f.toLowerCase().replace(/[^a-z0-9]/g, '')}`);
const rawUrl = (p: string) => GITHUB_RAW + p.split('/').map(encodeURIComponent).join('/');

/** the repository directory's .ttf files (the GitHub API: a request per family, once) */
async function listing(dirPath: string): Promise<string[]> {
  const r = await fetchImpl(GITHUB_API + dirPath, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'OverLyX' } });
  if (!r.ok) return [];
  const items = await r.json() as { name?: string; type?: string }[];
  return Array.isArray(items) ? items.filter(i => i.type === 'file' && /\.ttf$/i.test(i.name ?? '')).map(i => i.name!) : [];
}

/** a variable family: `Family[axes].ttf` and `Family-Italic[axes].ttf` (the repository's names), else what the directory holds */
async function fromGithubVariable(entry: CatalogFamily, slug: string, dir: string): Promise<{ files: GoogleFontFile[]; axes?: CatalogAxis[] }> {
  const base = entry.f.replace(/\s+/g, '');
  const tags = entry.a.map(a => a.t).sort().join(',');
  for (const d of repoDirs(entry)) {
    let names = [`${base}[${tags}].ttf`, ...(entry.i ? [`${base}-Italic[${tags}].ttf`] : [])];
    let upright = await download(rawUrl(`${d}/${names[0]}`));
    if (!upright) {
      const listed = (await listing(d)).filter(n => n.includes('['));
      if (!listed.length) continue;
      names = [listed.find(n => !/italic/i.test(n)) ?? listed[0], ...listed.filter(n => /italic/i.test(n)).slice(0, 1)];
      upright = await download(rawUrl(`${d}/${names[0]}`));
      if (!upright) continue;
    }
    const files: GoogleFontFile[] = [];
    fs.mkdirSync(dir, { recursive: true });
    for (const [k, n] of names.entries()) {
      const data = k === 0 ? upright : await download(rawUrl(`${d}/${n}`));
      if (!data) continue;
      const style = k === 0 ? 'normal' : 'italic';
      const file = `${slug}${style === 'italic' ? '-italic' : ''}-var.ttf`;
      fs.writeFileSync(path.join(dir, file), data);
      files.push({ style, weight: Math.round(entry.a.find(a => a.t === 'wght')?.d ?? 400), file });
    }
    return { files, axes: entry.a };
  }
  return { files: [] };
}

/** a family of static faces: each face of the repository's directory (its weight and style from its OS/2 table) */
async function fromGithubStatic(entry: CatalogFamily, slug: string, dir: string): Promise<{ files: GoogleFontFile[] }> {
  for (const d of repoDirs(entry)) {
    const names = (await listing(d)).filter(n => !n.includes('[')).slice(0, MAX_STATIC);
    if (!names.length) continue;
    const files: GoogleFontFile[] = [];
    fs.mkdirSync(dir, { recursive: true });
    for (const n of names) {
      const data = await download(rawUrl(`${d}/${n}`));
      if (!data) continue;
      const info = fontFileInfo(data);
      const style = info.italic || /italic/i.test(n) ? 'italic' : 'normal';
      const weight = info.weightClass ?? 400;
      if (files.some(f => f.style === style && f.weight === weight)) continue;
      const file = `${slug}-${weight}${style === 'italic' ? 'i' : ''}.ttf`;
      fs.writeFileSync(path.join(dir, file), data);
      files.push({ style, weight, file });
    }
    if (files.length) return { files };
  }
  return { files: [] };
}

/** the css2 API's TrueType files (a client that is no browser gets them): the catalogue's weights, or regular / bold / italic / bold italic */
async function fromCss2(family: string, entry: CatalogFamily | null, slug: string, dir: string): Promise<GoogleFontFile[]> {
  const q = encodeURIComponent(family).replace(/%20/g, '+');
  const weights = entry?.w.length ? entry.w.filter(w => w <= 900) : [400, 700];
  const tuples = [...weights.map(w => `0,${w}`), ...(entry ? (entry.i ? weights.map(w => `1,${w}`) : []) : ['1,400', '1,700'])];
  let r = await fetchImpl(`https://fonts.googleapis.com/css2?family=${q}:ital,wght@${tuples.join(';')}`);
  if (!r.ok) r = await fetchImpl(`https://fonts.googleapis.com/css2?family=${q}`);
  if (!r.ok) return [];
  const css = await r.text();
  const files: GoogleFontFile[] = [];
  for (const block of css.split('@font-face').slice(1)) {
    const style = /font-style:\s*(italic|normal)/.exec(block)?.[1] as 'italic' | 'normal' | undefined;
    const weight = Number(/font-weight:\s*(\d+)/.exec(block)?.[1]);
    const url = /src:\s*url\((https:\/\/fonts\.gstatic\.com\/[^)\s]+\.ttf)\)/.exec(block)?.[1];
    if (!style || !weight || !url || files.some(f => f.style === style && f.weight === weight)) continue;
    const data = await download(url);
    if (!data) continue;
    const file = `${slug}-${weight}${style === 'italic' ? 'i' : ''}.ttf`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, file), data);
    files.push({ style, weight, file });
  }
  return files;
}

/**
 * regular / bold / italic / bold italic of a family for fontspec (md typesetting): the nearest faces
 * Google has; a variable font is its upright and italic file, set by axis (`variable`).
 */
export function fontFaces(f: GoogleFont): { regular: string; bold?: string; italic?: string; boldItalic?: string; variable?: true } {
  if (f.axes) {
    const up = f.files.find(x => x.style === 'normal') ?? f.files[0], it = f.files.find(x => x.style === 'italic');
    const wght = f.axes.find(a => a.t === 'wght');
    const bold = !wght || wght.max >= 700;
    return { regular: up.file, ...(bold ? { bold: up.file } : {}), ...(it ? { italic: it.file, ...(bold ? { boldItalic: it.file } : {}) } : {}), variable: true };
  }
  const pick = (style: 'normal' | 'italic', weight: number) => f.files.find(x => x.style === style && x.weight === weight)?.file;
  const regular = pick('normal', 400) ?? f.files.find(x => x.style === 'normal')?.file ?? f.files[0].file;
  return { regular, bold: pick('normal', 700), italic: pick('italic', 400), boldItalic: pick('italic', 700) };
}

/** the families \olfont / \olfontset name in a LaTeX text (core fontface.ts; text styles' fonts: textstyles.ts) */
export function olfontFamilies(tex: string): string[] {
  const named = [...tex.matchAll(/\\ol(?:font(?:set)?|mainfont)(?:\[[^\]\n]*\]){0,2}\{([^}\n]+)\}/g)].map(m => m[1].trim());
  // (and the document's fonts by name — non-TeX fonts, Text styles' Normal text: \setmainfont)
  const set = [...tex.matchAll(/\\set(?:main|sans|mono)font(?:\[[^\]\n]*\])?\{([^}\n]+)\}/g)].map(m => m[1].trim());
  return [...new Set([...named, ...set].filter(validFamily))];
}

/**
 * The Google fonts a LaTeX text names (\olfont, \olmainfont, \setmainfont …), copied into
 * `<buildDir>/ol-fonts/<slug>/`: the folder the build's OSFONTDIR names, where LuaTeX finds them by
 * name. Returns the folder (null: none of them is a Google font).
 */
export async function provideFaceFonts(tex: string, buildDir: string): Promise<string | null> {
  const families = olfontFamilies(tex);
  if (!families.length) return null;
  const root = path.join(buildDir, 'ol-fonts');
  let provided = 0;
  for (const name of families) {
    const g = await googleFont(name);
    if (!g) continue;
    provided++;
    const sub = path.join(root, g.slug);
    fs.mkdirSync(sub, { recursive: true });
    for (const f of g.files) {
      const dest = path.join(sub, f.file);
      try { if (fs.statSync(dest).size === fs.statSync(path.join(g.dir, f.file)).size) continue; } catch { /* not there */ }
      fs.copyFileSync(path.join(g.dir, f.file), dest);
    }
  }
  return provided ? root : null;
}

/* ------------------------------------------------------------------ what a family offers */

export interface FontInfo {
  family: string; category: string;
  /** a variable font's axes (fvar, with Google's names for the registered ones), else none */
  axes: { tag: string; name: string; min: number; def: number; max: number }[];
  /** named instances (variable) — or one per static weight: the sliders' rungs */
  instances: FontFileInfo['instances'];
  weights: number[];
  italic: boolean;
  features: string[];
}

const infoCache = new Map<string, FontInfo>();

export async function googleFontInfo(family: string): Promise<FontInfo | null> {
  const g = await googleFont(family);
  if (!g) return null;
  const hit = infoCache.get(g.slug);
  if (hit) return hit;
  const catalog = await googleCatalog().catch(() => null);
  const entry = catalog ? findFamily(catalog, g.family) : null;
  const up = g.files.find(f => f.style === 'normal' && (g.axes || f.weight === 400)) ?? g.files.find(f => f.style === 'normal') ?? g.files[0];
  const fi = fontFileInfo(fs.readFileSync(path.join(g.dir, up.file)));
  const weights = g.axes ? [] : [...new Set(g.files.filter(f => f.style === 'normal').map(f => f.weight))].sort((a, b) => a - b);
  const info: FontInfo = {
    family: g.family, category: entry?.c ?? '',
    axes: fi.axes.map(a => ({ ...a, name: catalog?.axisNames[a.tag] ?? a.name })),
    instances: g.axes ? fi.instances.filter(i => i.name) : weights.map(w => ({ name: String(w), coords: { wght: w } })),
    weights, italic: g.files.some(f => f.style === 'italic'), features: fi.features,
  };
  infoCache.set(g.slug, info);
  return info;
}

/** the family's name in its own face: a few glyphs from the css2 API (`text=`), kept */
async function sampleFile(family: string): Promise<string | null> {
  const catalog = await googleCatalog();
  const entry = catalog ? findFamily(catalog, family) : null;
  if (!entry) return null;
  const dir = path.join(ROOT(), 'samples');
  const file = path.join(dir, slugOf(entry.f) + '.ttf');
  if (fs.existsSync(file)) return fs.statSync(file).size ? file : null;
  try {
    const q = encodeURIComponent(entry.f).replace(/%20/g, '+');
    const r = await fetchImpl(`https://fonts.googleapis.com/css2?family=${q}&text=${encodeURIComponent(entry.f)}`);
    const url = r.ok ? /src:\s*url\((https:\/\/fonts\.gstatic\.com\/[^)\s]+)\)/.exec(await r.text())?.[1] : undefined;
    const data = url ? await download(url) : null;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, data ?? '');
    return data ? file : null;
  } catch { return null; }
}

/* ------------------------------------------------------------------ routes */

export function googleFontRoutes(): express.Router {
  const r = express.Router();
  r.get('/fonts/catalog', async (_req, res) => {
    const c = await googleCatalog();
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.json(c ? { axisNames: c.axisNames, families: c.families } : { axisNames: {}, families: [] });
  });
  r.get('/fonts/google.css', async (req, res) => {
    const family = String(req.query.family ?? '');
    const f = validFamily(family) ? await googleFont(family) : null;
    res.type('text/css').setHeader('Cache-Control', 'private, max-age=86400');
    if (!f) { res.send(`/* "${family.replace(/[^\w ]/g, '')}": not a Google font here */`); return; }
    const wght = f.axes?.find(a => a.t === 'wght'), wdth = f.axes?.find(a => a.t === 'wdth');
    res.send(f.files.map(x => {
      const weight = f.axes ? (wght ? `${wght.min} ${wght.max}` : String(x.weight)) : String(x.weight);
      const stretch = wdth ? ` font-stretch: ${wdth.min}% ${wdth.max}%;` : '';
      return `@font-face { font-family: ${JSON.stringify(f.family)}; font-style: ${x.style}; font-weight: ${weight};${stretch} font-display: swap; src: url(/api/fonts/google/${f.slug}/${x.file}) format('truetype'); }`;
    }).join('\n'));
  });
  r.get('/fonts/google/:slug/:file', (req, res) => {
    const { slug, file } = req.params;
    if (!/^[a-z0-9-]{1,60}$/.test(slug) || !/^[a-z0-9-]{1,80}\.ttf$/.test(file)) { res.status(404).end(); return; }
    const abs = path.join(ROOT(), slug, file);
    if (!fs.existsSync(abs)) { res.status(404).end(); return; }
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.type('font/ttf').sendFile(abs);
  });
  r.get('/fonts/info', async (req, res) => {
    const family = String(req.query.family ?? '');
    const info = validFamily(family) ? await googleFontInfo(family) : null;
    if (!info) { res.status(404).json({ error: 'not a Google font here' }); return; }
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.json(info);
  });
  r.get('/fonts/sample', async (req, res) => {
    const family = String(req.query.family ?? '');
    const file = validFamily(family) ? await sampleFile(family) : null;
    if (!file) { res.status(404).end(); return; }
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.type('font/ttf').sendFile(file);
  });
  return r;
}

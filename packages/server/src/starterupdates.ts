/** Refresh known old examples at startup, before any editor can have unsaved live changes.
 * Compare structure, text, math, graphics and CSS, allowing whitespace and author-placeholder edits.
 * Replaced and retired examples are retained as manual versions; customised files stay alone.
 * The examples' folders are named after their designs' labels ("slides-1", "poster-4"); those of
 * before 17 Oct 2026 ("talk", "poster-bernstein-2026") are renamed first, customised or not, with
 * their saved state and history.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as Y from 'yjs';
import { parseSource, parseStyle, type HNode } from '@overlyx/core/html/source.ts';
import { SCIENTIFIC_TEMPLATES, templateFolder, type ScientificTemplate } from '@overlyx/core/html/scientific.ts';
import { db } from './db.ts';
import { resolveProjectPath } from './projects.ts';

const templates = path.resolve(import.meta.dirname, '../templates');
/**
 * Posters that shipped after accounts had received the examples: each is added once to every
 * account's example project (a `web:poster-<id>` marker records it, so a deleted one stays deleted);
 * new accounts get them with the project and are marked at once (access.ts).
 */
export const LATER_POSTERS = ['bernstein-2026', 'icml-2026', 'statement-2026'];

/** a design's example folder before 17 Oct 2026 (and in starters-legacy) */
export const legacyFolder = (t: ScientificTemplate) => t.id === 'research' ? 'talk' : t.id === 'betterposter' ? 'poster' : `${t.kind === 'deck' ? 'talk' : 'poster'}-${t.id}`;
/** each example's folder now, and the one its old versions are kept under (starters-legacy) */
const examples = [...SCIENTIFIC_TEMPLATES.map(t => ({ folder: templateFolder(t), legacy: legacyFolder(t) })), { folder: 'site', legacy: 'site' }];
const oldSources = (folder: string) => ['web', 'scientific-v1', 'mit-v1', 'scientific-v2'].map(version => path.join(templates, 'starters-legacy', version, folder, 'index.html'))
  .filter(file => fs.existsSync(file)).map(file => fs.readFileSync(file, 'utf8'));
const compact = (s: string) => s.replace(/\s+/g, ' ').trim();

function signature(text: string, folder: string): string {
  if (folder === 'site') {
    // Older account seeding personalised both placeholders. They are still the shipped example.
    const byline = /(<p\b[^>]*>)([^<]*?)( · an OverLyX example project page\s*<\/p>)/.exec(text);
    if (byline) {
      text = text.replace(byline[0], `${byline[1]}Your Name${byline[3]}`);
      text = text.replace(/^(\s*author\s*=\s*\{)([^{}\r\n]*)(\},\s*)$/m,
        (line, start, name, end) => compact(name) === compact(byline[2]) ? `${start}Your Name${end}` : line);
    }
  }
  const node = (n: HNode): unknown => {
    if ('value' in n) return compact(n.value) || null;
    if ('tagName' in n) {
      const attrs = n.attrs.filter(a => a.name !== 'data-ol-guides').map(a => [a.name, a.name === 'style'
        ? JSON.stringify(parseStyle(a.value).map(d => [d.prop, compact(d.value)]).sort()) : compact(a.value)]).sort();
      const children = n.childNodes.map(node).filter(n => n !== null);
      // Older copies could have a personalised name in the original example's author placeholder.
      if (n.tagName === 'p' && n.childNodes.every(c => 'value' in c)) {
        const byline = compact(n.childNodes.map(c => 'value' in c ? c.value : '').join(''));
        if (/ · (?:an OverLyX example deck|Department of Atmospheric Optics · an OverLyX example poster)$/.test(byline)) {
          return [n.tagName, attrs, [byline.replace(/^.*? · /, 'Your Name · ')]];
        }
      }
      return [n.tagName, attrs, children];
    }
    // Keep comments: a newly added note or review is a meaningful edit.
    if ('data' in n) return ['comment', compact(n.data)];
    return null;
  };
  return JSON.stringify(parseSource(text).doc.childNodes.map(node).filter(n => n !== null));
}

const oldSignatures = new Map<string, string[]>();
export function isLightlyEditedStarter(text: string, folder: string): boolean {
  let expected = oldSignatures.get(folder);
  if (!expected) { expected = oldSources(folder).map(source => signature(source, folder)); oldSignatures.set(folder, expected); }
  return expected.includes(signature(text, folder));
}

/** `project`'s documents under `from/` are under `to/` now: their saved state, history and per-person view state follow */
function moveDocIds(project: string, from: string, to: string): void {
  const a = `${project}/${from}/`, b = `${project}/${to}/`;
  db.transaction(() => {
    for (const [table, col] of [['ydocs', 'id'], ['versions', 'doc_id'], ['user_doc_state', 'doc_id']] as const) {
      db.prepare(`UPDATE OR IGNORE ${table} SET ${col} = ? || substr(${col}, ?) WHERE substr(${col}, 1, ?) = ?`).run(b, a.length + 1, a.length, a);
    }
  })();
}

export function refreshScientificStarters(dryRun = false): { updated: string[]; added: string[]; removed: string[]; renamed: number; preserved: number; moved: number } {
  const result = { updated: [] as string[], added: [] as string[], removed: [] as string[], renamed: 0, preserved: 0, moved: 0 };
  const rows = db.prepare("SELECT s.project, s.user_id, p.title FROM starter_projects s JOIN projects p ON p.name=s.project AND p.owner_id=s.user_id WHERE s.template='web' AND p.kind='project'").all() as { project: string; user_id: number; title: string | null }[];
  for (const row of rows) {
    let refreshed = false;
    let addVariants = false;
    try {
      const root = resolveProjectPath(row.project, '.');
      if (!fs.existsSync(root) || !fs.lstatSync(root).isDirectory()) continue;
      // the old folder names: "talk", "poster-bernstein-2026" → "slides-1", "poster-4" (the templates' labels)
      // (a dry run leaves them where they are: `at`)
      const at = new Map<string, string>();
      for (const t of SCIENTIFIC_TEMPLATES) {
        const from = path.join(root, legacyFolder(t)), to = path.join(root, templateFolder(t));
        if (!fs.existsSync(path.join(from, 'index.html')) || !fs.lstatSync(from).isDirectory() || fs.existsSync(to)) continue;
        if (!dryRun) { fs.renameSync(from, to); moveDocIds(row.project, legacyFolder(t), templateFolder(t)); }
        else at.set(templateFolder(t), legacyFolder(t));
        result.moved++;
      }
      for (const { folder, legacy } of examples) {
        const file = path.join(root, at.get(folder) ?? folder, 'index.html');
        if (!fs.existsSync(file) || !fs.lstatSync(path.dirname(file)).isDirectory() || !fs.lstatSync(file).isFile()) continue;
        const retire = folder === 'site';
        // An added asset makes the old web-page folder a user's project, even with an untouched index.
        if (retire && fs.readdirSync(path.dirname(file)).some(name => name !== 'index.html')) { result.preserved++; continue; }
        const before = fs.readFileSync(file, 'utf8');
        const replacement = retire ? undefined : fs.readFileSync(path.join(templates, 'starters/web', folder, 'index.html'), 'utf8');
        if (before === replacement) continue;
        if (!isLightlyEditedStarter(before, legacy)) { result.preserved++; continue; }
        const id = `${row.project}/${folder}/index.html`;
        // A process stopped between persisting its CRDT and saving the file can have newer edits.
        const stored = db.prepare('SELECT state FROM ydocs WHERE id=?').get(id) as { state: Buffer } | undefined;
        let persisted = before;
        if (stored) {
          const doc = new Y.Doc();
          try { Y.applyUpdate(doc, stored.state); persisted = doc.getText('html').toString(); }
          finally { doc.destroy(); }
          if (!isLightlyEditedStarter(persisted, legacy)) { result.preserved++; continue; }
        }
        if (!dryRun) {
          const snapshot = db.prepare('INSERT INTO versions (doc_id,name,author,kind,created_at,lyx) VALUES (?,?,?,?,?,?)');
          snapshot.run(id, retire ? 'Before removing web-page example' : 'Before scientific template refresh', 'OverLyX', 'manual', Date.now(), before);
          if (persisted !== before) snapshot.run(id, 'Unsaved state before scientific template refresh', 'OverLyX', 'manual', Date.now(), persisted);
          if (replacement === undefined) {
            fs.unlinkSync(file);
            fs.rmdirSync(path.dirname(file));
          } else {
            const temp = file + '.scientific-refresh.tmp';
            fs.writeFileSync(temp, replacement, { flag: 'wx', mode: fs.statSync(file).mode });
            try { fs.renameSync(temp, file); } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
          }
        }
        if (retire) { result.removed.push(id); continue; }
        result.updated.push(id);
        refreshed = true;
        if (!before.includes('name="overlyx-template"')) addVariants = true;
      }
      if (refreshed && !dryRun) {
        for (const t of addVariants ? SCIENTIFIC_TEMPLATES : []) {
          if (t.id === 'research' || t.id === 'betterposter') continue;
          const folder = templateFolder(t);
          const dest = path.join(root, folder);
          if (!fs.existsSync(dest)) fs.cpSync(path.join(templates, 'starters/web', folder), dest, { recursive: true, errorOnExist: true, force: false });
        }
      }
      // LATER_POSTERS, each recorded on its own so that later starts respect deletions
      // (the markers keep the folders' old names)
      for (const t of SCIENTIFIC_TEMPLATES.filter(x => LATER_POSTERS.includes(x.id))) {
        const marker = `web:${legacyFolder(t)}`, folder = templateFolder(t);
        if (db.prepare('SELECT 1 FROM starter_projects WHERE user_id=? AND template=?').get(row.user_id, marker)) continue;
        const dest = path.join(root, at.get(folder) ?? folder);
        if (!fs.existsSync(dest)) {
          if (!dryRun) fs.cpSync(path.join(templates, 'starters/web', folder), dest, { recursive: true, errorOnExist: true, force: false });
          result.added.push(`${row.project}/${folder}/index.html`);
        }
        if (!dryRun) db.prepare('INSERT OR IGNORE INTO starter_projects (user_id,template,project,created_at) VALUES (?,?,?,?)').run(row.user_id, marker, row.project, Date.now());
      }
      if (['Example: scientific slides and posters', 'Example: slides, poster and web page'].includes(row.title ?? '')) {
        if (!dryRun) db.prepare("UPDATE projects SET title='Example: slides and posters' WHERE name=? AND owner_id=?").run(row.project, row.user_id);
        result.renamed++;
      }
    } catch (e) { console.error('[starters] scientific refresh failed:', row.project, e); }
  }
  if (!dryRun && (result.updated.length || result.added.length || result.removed.length || result.renamed || result.moved)) console.log(`[starters] moved ${result.moved} example folders to their new names; refreshed ${result.updated.length} slide/poster examples; added ${result.added.length} project poster examples; removed ${result.removed.length} web-page examples; renamed ${result.renamed} projects; preserved ${result.preserved} customised files`);
  return result;
}

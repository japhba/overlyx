/** Refresh known old examples at startup, before any editor can have unsaved live changes.
 * Compare structure, text, math, graphics and CSS, allowing whitespace and author-placeholder edits.
 * Every replaced source is retained as a manual version; deleted or customised files stay alone.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as Y from 'yjs';
import { parseSource, parseStyle, type HNode } from '@overlyx/core/html/source.ts';
import { SCIENTIFIC_TEMPLATES } from '@overlyx/core/html/scientific.ts';
import { db } from './db.ts';
import { resolveProjectPath } from './projects.ts';

const templates = path.resolve(import.meta.dirname, '../templates');
const oldSource = (folder: string) => fs.readFileSync(path.join(templates, 'starters-legacy/web', folder, 'index.html'), 'utf8');
const compact = (s: string) => s.replace(/\s+/g, ' ').trim();

function signature(text: string): string {
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

const oldSignatures = new Map<string, string>();
export function isLightlyEditedStarter(text: string, folder: 'talk' | 'poster'): boolean {
  let expected = oldSignatures.get(folder);
  if (!expected) { expected = signature(oldSource(folder)); oldSignatures.set(folder, expected); }
  return signature(text) === expected;
}

export function refreshScientificStarters(dryRun = false): { updated: string[]; preserved: number } {
  const result = { updated: [] as string[], preserved: 0 };
  const rows = db.prepare("SELECT s.project, s.user_id FROM starter_projects s JOIN projects p ON p.name=s.project AND p.owner_id=s.user_id WHERE s.template='web' AND p.kind='project'").all() as { project: string; user_id: number }[];
  for (const row of rows) {
    let refreshed = false;
    try {
      const root = resolveProjectPath(row.project, '.');
      if (!fs.existsSync(root) || !fs.lstatSync(root).isDirectory()) continue;
      for (const folder of ['talk', 'poster'] as const) {
        const file = path.join(root, folder, 'index.html');
        if (!fs.existsSync(file) || !fs.lstatSync(path.dirname(file)).isDirectory() || !fs.lstatSync(file).isFile()) continue;
        const before = fs.readFileSync(file, 'utf8');
        const replacement = fs.readFileSync(path.join(templates, 'starters/web', folder, 'index.html'), 'utf8');
        if (before === replacement) continue;
        if (!isLightlyEditedStarter(before, folder)) { result.preserved++; continue; }
        const id = `${row.project}/${folder}/index.html`;
        // A process stopped between persisting its CRDT and saving the file can have newer edits.
        const stored = db.prepare('SELECT state FROM ydocs WHERE id=?').get(id) as { state: Buffer } | undefined;
        let persisted = before;
        if (stored) {
          const doc = new Y.Doc();
          try { Y.applyUpdate(doc, stored.state); persisted = doc.getText('html').toString(); }
          finally { doc.destroy(); }
          if (!isLightlyEditedStarter(persisted, folder)) { result.preserved++; continue; }
        }
        if (!dryRun) {
          const snapshot = db.prepare('INSERT INTO versions (doc_id,name,author,kind,created_at,lyx) VALUES (?,?,?,?,?,?)');
          snapshot.run(id, 'Before scientific template refresh', 'OverLyX', 'manual', Date.now(), before);
          if (persisted !== before) snapshot.run(id, 'Unsaved state before scientific template refresh', 'OverLyX', 'manual', Date.now(), persisted);
          const temp = file + '.scientific-refresh.tmp';
          fs.writeFileSync(temp, replacement, { flag: 'wx', mode: fs.statSync(file).mode });
          try { fs.renameSync(temp, file); } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
        }
        result.updated.push(id);
        refreshed = true;
      }
      if (refreshed && !dryRun) {
        for (const t of SCIENTIFIC_TEMPLATES) {
          if (t.id === 'research' || t.id === 'betterposter') continue;
          const folder = `${t.kind === 'deck' ? 'talk' : 'poster'}-${t.id}`;
          const dest = path.join(root, folder);
          if (!fs.existsSync(dest)) fs.cpSync(path.join(templates, 'starters/web', folder), dest, { recursive: true, errorOnExist: true, force: false });
        }
        db.prepare("UPDATE projects SET title='Example: scientific slides and posters' WHERE name=? AND owner_id=? AND title='Example: slides, poster and web page'").run(row.project, row.user_id);
      }
    } catch (e) { console.error('[starters] scientific refresh failed:', row.project, e); }
  }
  if (!dryRun && result.updated.length) console.log(`[starters] refreshed ${result.updated.length} scientific examples; preserved ${result.preserved} customised files`);
  return result;
}

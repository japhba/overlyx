import { describe, it, expect } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as Y from 'yjs';

const root = join(tmpdir(), 'overlyx-scientific-starter-updates-test');
rmSync(root, { recursive: true, force: true });
mkdirSync(join(root, 'projects'), { recursive: true });
process.env.OVERLYX_DATA_DIR = join(root, 'data');
process.env.OVERLYX_PROJECTS_DIR = join(root, 'projects');
const { db } = await import('../packages/server/src/db.ts');
const { createUser } = await import('../packages/server/src/auth.ts');
const { registerProject } = await import('../packages/server/src/access.ts');
const { isLightlyEditedStarter, refreshScientificStarters } = await import('../packages/server/src/starterupdates.ts');
const templates = join(import.meta.dirname, '../packages/server/templates');
const original = (folder: string) => readFileSync(join(templates, 'starters-legacy/web', folder, 'index.html'), 'utf8');
const latest = (folder: string) => readFileSync(join(templates, 'starters/web', folder, 'index.html'), 'utf8');

function seed(name: string) {
  const user = createUser(name, 'Your Name', 'pw');
  const project = `${name}/example-web`;
  registerProject(project, user.id, { title: 'Example: slides, poster and web page' });
  db.prepare('INSERT INTO starter_projects (user_id,template,project,created_at) VALUES (?,?,?,?)').run(user.id, 'web', project, Date.now());
  const dir = join(root, 'projects', project);
  for (const folder of ['talk', 'poster']) {
    mkdirSync(join(dir, folder), { recursive: true });
    writeFileSync(join(dir, folder, 'index.html'), original(folder));
  }
  return { dir, project };
}

describe('scientific starter refresh', () => {
  it('allows whitespace, placeholder names and canvas guides, while preserving content, equations, graphics and reviews', () => {
    const old = original('talk');
    expect(isLightlyEditedStarter(old.replace(/\n/g, '\r\n').replace('Your Name', 'A Researcher').replace('<body>', '<body data-ol-guides="x100">'), 'talk')).toBe(true);
    for (const changed of [
      old.replace('Why the sky is blue', 'A new research project'),
      old.replace('lambda^{4}', 'lambda^{5}'),
      old.replace('380 nm', '390 nm'),
      old.replace('#3a86ff', '#ff0000'),
      old.replace('<section class="slide dark">', '<section class="slide dark" data-ol-comments="a review">'),
    ]) {
      expect(changed).not.toBe(old);
      expect(isLightlyEditedStarter(changed, 'talk')).toBe(false);
    }
    const page = original('site').replaceAll('Your Name', 'A Researcher');
    expect(isLightlyEditedStarter(page, 'site')).toBe(true);
    expect(isLightlyEditedStarter(page.replace('Why the sky is blue', 'New research'), 'site')).toBe(false);
    expect(isLightlyEditedStarter(page.replace('author = {A Researcher}', 'author = {Someone Else}'), 'site')).toBe(false);
  });

  it('refreshes eligible examples once, retains versions and adds variants without overwriting an existing folder', () => {
    const { dir, project } = seed('refresh');
    mkdirSync(join(dir, 'talk-dark-seminar'));
    writeFileSync(join(dir, 'talk-dark-seminar/index.html'), 'Custom file');
    expect(refreshScientificStarters(true).updated).toHaveLength(2);
    expect(readFileSync(join(dir, 'talk/index.html'), 'utf8')).toBe(original('talk'));
    expect(refreshScientificStarters().updated).toHaveLength(2);
    expect(readFileSync(join(dir, 'talk/index.html'), 'utf8')).toBe(latest('talk'));
    expect(readFileSync(join(dir, 'poster/index.html'), 'utf8')).toBe(latest('poster'));
    expect(readFileSync(join(dir, 'talk-dark-seminar/index.html'), 'utf8')).toBe('Custom file');
    expect(existsSync(join(dir, 'poster-figure-first/index.html'))).toBe(true);
    const versions = db.prepare('SELECT lyx,kind FROM versions WHERE doc_id=?').all(project + '/talk/index.html');
    expect(versions).toEqual([{ lyx: original('talk'), kind: 'manual' }]);
    expect(refreshScientificStarters().updated).toEqual([]);
    rmSync(dir, { recursive: true });
  });

  it('preserves meaningful persisted edits, deleted files and deleted projects', () => {
    const { dir, project } = seed('keep');
    const doc = new Y.Doc();
    const edited = original('talk').replace('Why the sky is blue', 'New observations');
    doc.getText('html').insert(0, edited);
    db.prepare('INSERT INTO ydocs (id,state,file_hash,updated_at) VALUES (?,?,?,?)').run(project + '/talk/index.html', Buffer.from(Y.encodeStateAsUpdate(doc)), 'old', Date.now());
    doc.destroy();
    rmSync(join(dir, 'poster'), { recursive: true });
    expect(refreshScientificStarters()).toMatchObject({ updated: [], preserved: 1 });
    expect(readFileSync(join(dir, 'talk/index.html'), 'utf8')).toBe(original('talk'));
    expect(existsSync(join(dir, 'poster'))).toBe(false);
    rmSync(dir, { recursive: true });
    expect(refreshScientificStarters().updated).toEqual([]);
    expect(existsSync(dir)).toBe(false);
  });

  it('upgrades pristine first-release scientific variants but keeps edited and deleted variants', () => {
    const { dir } = seed('previous');
    const previous = (folder: string) => readFileSync(join(templates, 'starters-legacy/scientific-v1', folder, 'index.html'), 'utf8');
    for (const folder of ['talk', 'poster', 'talk-dark-seminar', 'poster-figure-first']) {
      mkdirSync(join(dir, folder), { recursive: true });
      writeFileSync(join(dir, folder, 'index.html'), previous(folder));
    }
    const changed = previous('talk-dark-seminar').replace('Stability in two dimensions', 'My own research');
    writeFileSync(join(dir, 'talk-dark-seminar/index.html'), changed);
    expect(refreshScientificStarters().updated).toHaveLength(3);
    expect(readFileSync(join(dir, 'poster-figure-first/index.html'), 'utf8')).toBe(latest('poster-figure-first'));
    expect(readFileSync(join(dir, 'talk-dark-seminar/index.html'), 'utf8')).toBe(changed);
    expect(existsSync(join(dir, 'talk-serif-colloquium'))).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('renames default titles and retires only unchanged web pages, retaining backups, edits and added files', () => {
    const cases = ['retire', 'edited', 'persisted', 'assets'].map(name => seed('site-' + name));
    const html = original('site');
    for (const { dir } of cases) {
      mkdirSync(join(dir, 'site'));
      writeFileSync(join(dir, 'site/index.html'), html);
    }
    const personalised = html.replaceAll('Your Name', 'A Researcher');
    writeFileSync(join(cases[0].dir, 'site/index.html'), personalised);
    const legacyDoc = new Y.Doc();
    legacyDoc.getText('html').insert(0, personalised);
    db.prepare('INSERT INTO ydocs (id,state,file_hash,updated_at) VALUES (?,?,?,?)').run(cases[0].project + '/site/index.html', Buffer.from(Y.encodeStateAsUpdate(legacyDoc)), 'old', Date.now());
    legacyDoc.destroy();
    db.prepare('UPDATE projects SET title=? WHERE name=?').run('Example: scientific slides and posters', cases[0].project);
    db.prepare('UPDATE projects SET title=? WHERE name=?').run('My project', cases[3].project);
    const edited = html.replace('Why the sky is blue', 'My research page');
    writeFileSync(join(cases[1].dir, 'site/index.html'), edited);
    const doc = new Y.Doc();
    doc.getText('html').insert(0, edited);
    db.prepare('INSERT INTO ydocs (id,state,file_hash,updated_at) VALUES (?,?,?,?)').run(cases[2].project + '/site/index.html', Buffer.from(Y.encodeStateAsUpdate(doc)), 'old', Date.now());
    doc.destroy();
    writeFileSync(join(cases[3].dir, 'site/data.csv'), 'my,data');
    const id = cases[0].project + '/site/index.html';
    expect(refreshScientificStarters(true)).toMatchObject({ removed: [id], renamed: 3 });
    expect(existsSync(join(cases[0].dir, 'site/index.html'))).toBe(true);
    expect(db.prepare('SELECT title FROM projects WHERE name=?').get(cases[0].project)).toEqual({ title: 'Example: scientific slides and posters' });
    expect(refreshScientificStarters()).toMatchObject({ removed: [id], renamed: 3 });
    expect(existsSync(join(cases[0].dir, 'site'))).toBe(false);
    expect(db.prepare('SELECT title FROM projects WHERE name=?').get(cases[0].project)).toEqual({ title: 'Example: slides and posters' });
    expect(db.prepare('SELECT title FROM projects WHERE name=?').get(cases[3].project)).toEqual({ title: 'My project' });
    expect(db.prepare('SELECT name,lyx,kind FROM versions WHERE doc_id=?').all(id)).toEqual([{ name: 'Before removing web-page example', lyx: personalised, kind: 'manual' }]);
    expect(readFileSync(join(cases[1].dir, 'site/index.html'), 'utf8')).toBe(edited);
    expect(readFileSync(join(cases[2].dir, 'site/index.html'), 'utf8')).toBe(html);
    expect(readFileSync(join(cases[3].dir, 'site/data.csv'), 'utf8')).toBe('my,data');
    expect(refreshScientificStarters()).toMatchObject({ removed: [], renamed: 0 });
  });
});

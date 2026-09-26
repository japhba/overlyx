/**
 * The folded sections per user and document (userSettings.ts docFolds / setDocFolds, the
 * /api/docs/<id>/folds routes): validated, per user, never dated in the future, removed with the
 * project and with a pruned guest, carried over when a guest signs in.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), 'overlyx-docstate-test');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'projects', 'p'), { recursive: true });
process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');
process.env.OVERLYX_PROJECTS_DIR = join(ROOT, 'projects');

const { createUser } = await import('../packages/server/src/auth.ts');
const { docFolds, setDocFolds, markDocOpened, lastOpenedByProject } = await import('../packages/server/src/userSettings.ts');
const { cleanupProjectData } = await import('../packages/server/src/export.ts');
const { db } = await import('../packages/server/src/db.ts');
const { adoptGuest } = await import('../packages/server/src/access.ts');

const ann = createUser('ann', 'Ann', 'pw-ann-12345');
const ben = createUser('ben', 'Ben', 'pw-ben-12345');
afterAll(() => { rmSync(ROOT, { recursive: true, force: true }); });

describe('folds per user and document', () => {
  it('are kept per user; nothing stored reads as none', () => {
    expect(docFolds(ann.id, 'p/a.tex')).toEqual({ folds: [], at: 0 });
    const r = setDocFolds(ann.id, 'p/a.tex', [{ l: 'Section', t: 'Methods', n: 0 }], 1000);
    expect(r).toEqual({ folds: [{ l: 'Section', t: 'Methods', n: 0 }], at: 1000 });
    expect(docFolds(ann.id, 'p/a.tex')).toEqual(r);
    expect(docFolds(ben.id, 'p/a.tex').folds).toEqual([]);    // Ben's view is his own
    setDocFolds(ann.id, 'p/a.tex', [], 2000);                  // all expanded: stored as such, with its time
    expect(docFolds(ann.id, 'p/a.tex')).toEqual({ folds: [], at: 2000 });
  });
  it('drops malformed entries and never dates a change in the future', () => {
    const r = setDocFolds(ann.id, 'p/b.tex', [{ l: 'Section', t: 'A', n: 1 }, { l: 3, t: 'x', n: 0 }, { l: 'S', t: 'y', n: -1 }, null, 'junk'], Date.now() + 86400e3);
    expect(r.folds).toEqual([{ l: 'Section', t: 'A', n: 1 }]);
    expect(r.at).toBeLessThanOrEqual(Date.now());
    expect(setDocFolds(ann.id, 'p/b.tex', 'nonsense').folds).toEqual([]);
  });
  it('go with a deleted project', () => {
    setDocFolds(ben.id, 'p/c.tex', [{ l: 'Section', t: 'C', n: 0 }]);
    cleanupProjectData('p');
    expect(docFolds(ann.id, 'p/a.tex').at).toBe(0);
    expect(docFolds(ben.id, 'p/c.tex').at).toBe(0);
  });
  it('come along when a guest signs in (the account keeps its own where both have some)', () => {
    db.prepare("INSERT INTO users (username, display_name, color, created_at, is_guest) VALUES ('guest-x', 'Anonymous Otter', '#123456', ?, 1)").run(Date.now());
    const gid = (db.prepare("SELECT id FROM users WHERE username = 'guest-x'").get() as { id: number }).id;
    setDocFolds(gid, 'p/g.tex', [{ l: 'Section', t: 'G', n: 0 }], 500);
    setDocFolds(gid, 'p/both.tex', [{ l: 'Section', t: 'guest', n: 0 }], 600);
    setDocFolds(ann.id, 'p/both.tex', [{ l: 'Section', t: 'ann', n: 0 }], 700);
    adoptGuest({ id: gid, username: 'guest-x', name: 'Anonymous Otter', guest: true } as never, ann.id);
    expect(docFolds(ann.id, 'p/g.tex').folds).toEqual([{ l: 'Section', t: 'G', n: 0 }]);
    expect(docFolds(ann.id, 'p/both.tex').folds).toEqual([{ l: 'Section', t: 'ann', n: 0 }]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM user_doc_state WHERE user_id = ?').get(gid)).toEqual({ n: 0 });
  });
});

describe('last opened, per user', () => {
  it('every open counts (not only one per 10 minutes like the activity log); per project, the newest document open', async () => {
    markDocOpened(ben.id, 'ben/q/a.tex');
    await new Promise(r => setTimeout(r, 5));
    markDocOpened(ben.id, 'ben/q/sub/b.tex');
    const first = lastOpenedByProject(ben.id).get('ben/q')!;
    await new Promise(r => setTimeout(r, 5));
    markDocOpened(ben.id, 'ben/q/a.tex');
    expect(lastOpenedByProject(ben.id).get('ben/q')!).toBeGreaterThan(first);
    expect(lastOpenedByProject(ann.id).get('ben/q')).toBeUndefined();
    // the activity log's older history counts too
    db.prepare("INSERT INTO access_log (project, user_id, action, detail, at) VALUES ('ben/old', ?, 'open', 'x.tex', 12345)").run(ben.id);
    expect(lastOpenedByProject(ben.id).get('ben/old')).toBe(12345);
  });
});

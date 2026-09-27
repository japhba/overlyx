/**
 * Checkpoints of the Agent panel's turns (packages/server/src/agentwork.ts): what a turn changed,
 * taken back exactly — documents as before the turn with everything edited since kept, files
 * restored, created files removed — and the build check that tells whether a turn broke the PDF.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), 'overlyx-agentcheckpoint-test');
rmSync(ROOT, { recursive: true, force: true });
const PROJ = join(ROOT, 'projects', 'owner', 'paper');
mkdirSync(PROJ, { recursive: true });
process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');
process.env.OVERLYX_PROJECTS_DIR = join(ROOT, 'projects');

const aw = await import('../packages/server/src/agentwork.ts');
const { manager } = await import('../packages/server/src/docs.ts');
const { createUser } = await import('../packages/server/src/auth.ts');
const { registerProject } = await import('../packages/server/src/access.ts');
const { db } = await import('../packages/server/src/db.ts');
const { buildIncluding } = await import('../packages/server/src/export.ts');
const { resolveChanges } = await import('../packages/core/src/index.ts');

const P = 'owner/paper', DOC = `${P}/paper.tex`, T = 'thread-cp-1';
const uid = createUser('owner', 'Owner', 'pw').id;
registerProject(P, uid);
db.prepare('INSERT INTO agent_threads (thread_id, project, user_id, created_at, updated_at) VALUES (?,?,?,?,?)').run(T, P, uid, Date.now(), Date.now());

const tex = (body: string) => `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;
writeFileSync(join(PROJ, 'paper.tex'), tex('The alpha paragraph.\n\nThe beta paragraph.\n\nThe gamma paragraph.'));
writeFileSync(join(PROJ, 'refs.bib'), '@article{a, title={A}}\n');

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const copyDir = () => aw.workspaceDir(T, P);
/** the agent patches its copy of `rel` */
const agentEdit = (rel: string, f: (s: string) => string) => {
  const file = join(copyDir(), rel);
  writeFileSync(file, f(readFileSync(file, 'utf8')));
};
const live = async () => (await manager.open(DOC)).toText();
/** somebody edits the live document */
const personEdit = async (f: (s: string) => string) => {
  const doc = await manager.open(DOC);
  doc.loadFromLyx(doc.parse(f(doc.toText())), 'test');
};

describe('agent turn checkpoints', () => {
  it("a turn's changes are taken back exactly; edits made since stay; files are restored, created files removed", async () => {
    await aw.prepareWorkspace(T, P, uid);
    const before = await live();
    agentEdit('paper.tex', s => s.replace('alpha', 'ALPHA'));
    agentEdit('refs.bib', s => s + '@book{b, title={B}}\n');
    writeFileSync(join(copyDir(), 'notes.md'), '# the agent notes\n');
    await aw.syncWorkspace(T, P, uid);
    expect(await live()).toMatch(/\\lyxdeleted\{Agent panel \(MCP\)\}\{[^}]*\}\{alpha\}\\lyxadded\{Agent panel \(MCP\)\}\{[^}]*\}\{ALPHA\}/);
    const cp = (await aw.finishTurn(T, P, uid))!;
    expect(cp.finished).toBe(true);
    expect(cp.files.map(f => `${f.path}:${f.kind}${f.created ? '+' : ''}`).sort()).toEqual(['notes.md:file+', 'paper.tex:doc', 'refs.bib:file']);
    expect(cp.files.find(f => f.path === 'paper.tex')).toMatchObject({ inserted: 5, deleted: 5 });
    expect(aw.listCheckpoints(T).map(c => c.n)).toEqual([cp.n]);

    await personEdit(s => s.replace('gamma', 'gamma edited'));   // after the turn, elsewhere
    const r = await aw.undoCheckpoint(T, P, cp.n, uid);
    expect(r.reverted.sort()).toEqual(['notes.md', 'paper.tex', 'refs.bib']);
    expect(r.kept).toEqual([]);
    expect(await live()).toBe(before.replace('gamma', 'gamma edited'));
    expect(readFileSync(join(PROJ, 'refs.bib'), 'utf8')).toBe('@article{a, title={A}}\n');
    expect(existsSync(join(PROJ, 'notes.md'))).toBe(false);
    // the working copy followed: nothing to take over, nothing re-applied
    expect(readFileSync(join(copyDir(), 'paper.tex'), 'utf8')).toBe(await live());
    expect(existsSync(join(copyDir(), 'notes.md'))).toBe(false);
    expect(await aw.syncWorkspace(T, P, uid)).toEqual([]);
    await expect(aw.undoCheckpoint(T, P, cp.n, uid)).rejects.toThrow(/already/);
    expect(aw.listCheckpoints(T)[0].undone).toMatchObject({ by: uid, kept: [] });
  });

  it("people's edits between the agent's changes survive; a paragraph edited since is left as it is", async () => {
    await aw.prepareWorkspace(T, P, uid);
    agentEdit('paper.tex', s => s.replace('The alpha', 'One alpha'));
    await aw.syncWorkspace(T, P, uid);
    await personEdit(s => s.replace('The beta paragraph.', 'The beta paragraph, by a person.'));   // during the turn
    agentEdit('paper.tex', s => s.replace('gamma edited', 'gamma by the agent'));                // (its copy has the old beta)
    await aw.syncWorkspace(T, P, uid);
    const cp = (await aw.finishTurn(T, P, uid))!;
    // after the turn, a person accepts the agent's change in the alpha paragraph
    const doc = await manager.open(DOC);
    const lyx = doc.toLyxDocument();
    lyx.body = [...resolveChanges(lyx.body.slice(0, 1), true), ...lyx.body.slice(1)];
    doc.loadFromLyx(lyx, 'test');
    const r = await aw.undoCheckpoint(T, P, cp.n, uid);
    expect(r.kept).toEqual([{ path: 'paper.tex', why: 'a paragraph edited since was left as it is' }]);
    const text = await live();
    expect(text).toContain('One alpha paragraph.');                       // accepted since: stays
    expect(text).toContain('The beta paragraph, by a person.');          // the person's edit during the turn
    expect(text).toContain('The gamma edited paragraph.');               // the agent's change taken back
    expect(text).not.toContain('Agent panel');
  });

  it('undo_turn finds the checkpoint of "this turn" and of earlier turns', async () => {
    await aw.prepareWorkspace(T, P, uid);
    expect(() => aw.agentCheckpoint(P, uid, 0)).toThrow(/not changed any file in this turn/);
    expect(() => aw.agentCheckpoint(P, uid, 1)).toThrow(/only 0 earlier/);   // both earlier ones were taken back
    agentEdit('paper.tex', s => s.replace('beta paragraph, by a person', 'beta paragraph, by a person and the agent'));
    await aw.syncWorkspace(T, P, uid);
    const now = aw.agentCheckpoint(P, uid, 0);
    expect(now.tid).toBe(T);
    // taken back mid-turn: later changes of the turn go into a checkpoint of their own
    await aw.undoCheckpoint(T, P, now.n, uid);
    expect(readFileSync(join(copyDir(), 'paper.tex'), 'utf8')).not.toContain('and the agent');
    agentEdit('paper.tex', s => s.replace('The gamma', 'A gamma'));
    await aw.syncWorkspace(T, P, uid);
    expect(aw.agentCheckpoint(P, uid, 0).n).toBe(now.n + 1);
    await aw.finishTurn(T, P, uid);
    await aw.prepareWorkspace(T, P, uid);
    expect(aw.agentCheckpoint(P, uid, 1).n).toBe(now.n + 1);
  });

  it('the build check says whether a turn broke the PDF, and undo repairs it', async () => {
    const seen: string[] = [];
    const off = aw.onCheckpoint((tid, cp) => { if (tid === T) seen.push(cp.builds.map(b => b.status).join() || '-'); });
    expect((await buildIncluding(DOC, 'test', Date.now())).ok).toBe(true);   // it built before
    await aw.prepareWorkspace(T, P, uid);
    agentEdit('paper.tex', s => s.replace('The beta', 'The \\undefinedmacro{} beta'));
    await aw.syncWorkspace(T, P, uid);
    const cp = (await aw.finishTurn(T, P, uid))!;
    expect(cp.builds).toEqual([{ doc: 'paper.tex', status: 'building', before: 'ok', broke: false, errors: [] }]);
    await aw.checkBuilds(T, P, cp.n);
    const checked = aw.listCheckpoints(T).find(c => c.n === cp.n)!;
    expect(checked.builds[0]).toMatchObject({ status: 'error', before: 'ok', broke: true });
    expect(checked.builds[0].errors[0]).toMatch(/paper\.tex:\d+: Undefined control sequence/);
    expect(seen.slice(-2)).toEqual(['building', 'error']);
    await aw.undoCheckpoint(T, P, cp.n, uid);
    expect((await buildIncluding(DOC, 'test', Date.now())).ok).toBe(true);
    off();
  }, 240_000);
});

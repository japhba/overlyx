/**
 * Reading an agent thread from codex 0.17x (server agent.ts readThread): its paginated threads refuse
 * the full read ("invalid paginated history lineage", "… not materialized yet" before the first
 * message), so the turns are paged in; a thread codex has no record of is `lost` — the panel says so
 * in the transcript (usage report: these codex errors were shown raw, again at every reopen).
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = vi.hoisted(() => {
  const root = `${process.env.OVERLYX_SCRATCH ?? process.env.TMPDIR ?? '/tmp'}/overlyx-agent-thread-read-test`;
  process.env.OVERLYX_DATA_DIR = root + '/data';
  process.env.OVERLYX_PROJECTS_DIR = root + '/projects';
  return root;
});
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'data'), { recursive: true });
mkdirSync(join(ROOT, 'projects'), { recursive: true });
const { readThread, LOST_THREAD } = await import('../packages/server/src/agent.ts');
const { config } = await import('../packages/server/src/config.ts');
if (!config.dataDir.startsWith(ROOT)) throw new Error('the test would use the real data directory: ' + config.dataDir);
afterAll(() => { rmSync(ROOT, { recursive: true, force: true }); void tmpdir; });

type Call = [string, Record<string, unknown> | undefined];
const codex = (answer: (method: string, params: any) => unknown) => {
  const calls: Call[] = [];
  const request = async (method: string, params?: any) => { calls.push([method, params]); const r = answer(method, params); if (r instanceof Error) throw r; return r; };
  return { request, calls };
};

describe('reading a thread', () => {
  it('one full read where codex gives it', async () => {
    const c = codex(() => ({ thread: { id: 't', turns: [{ id: 'a', items: [] }] } }));
    expect(await readThread(c.request, 't')).toEqual({ thread: { id: 't', turns: [{ id: 'a', items: [] }] } });
    expect(c.calls).toHaveLength(1);
  });
  it('a paginated thread: metadata, then the turns page by page', async () => {
    const c = codex((m, p) => {
      if (m === 'thread/read') return p.includeTurns ? new Error('invalid paginated history lineage for 0199…: missing parent') : { thread: { id: 't', name: 'x' } };
      if (m === 'thread/turns/list') return p.cursor ? { data: [{ id: 'b' }], nextCursor: null } : { data: [{ id: 'a' }], nextCursor: 'c1' };
      return new Error('unexpected ' + m);
    });
    expect(await readThread(c.request, 't')).toEqual({ thread: { id: 't', name: 'x', turns: [{ id: 'a' }, { id: 'b' }] } });
    expect(c.calls.filter(x => x[0] === 'thread/turns/list').map(x => x[1]?.cursor ?? null)).toEqual([null, 'c1']);
    expect(c.calls[2][1]).toMatchObject({ itemsView: 'full', sortDirection: 'asc' });
  });
  it('a thread before its first message: no turns, no error', async () => {
    const c = codex((m, p) => (m === 'thread/read' && !p.includeTurns ? { thread: { id: 't' } } : new Error('list_turns is not supported yet')));
    expect(await readThread(c.request, 't')).toEqual({ thread: { id: 't', turns: [] } });
  });
  it('a thread codex has no record of is lost, not an error', async () => {
    const c = codex(() => new Error('no rollout found for thread id 0199abcd'));
    expect(await readThread(c.request, 't')).toEqual({ thread: { id: 't', turns: [] }, lost: true });
  });
  it('other failures stay errors', async () => {
    const c = codex(() => new Error('codex is not running'));
    await expect(readThread(c.request, 't')).rejects.toThrow('codex is not running');
  });
  it('knows codex\'s words for a lost thread', () => {
    for (const m of ['no rollout found for thread id 0199', 'invalid paginated history lineage for 0199: x', 'thread not found: 0199']) expect(LOST_THREAD.test(m)).toBe(true);
    expect(LOST_THREAD.test('usage limit reached')).toBe(false);
  });
});

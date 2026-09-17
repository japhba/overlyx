/**
 * Anonymous usage statistics, server side (packages/server/src/usage.ts, usageReport.ts): batches
 * are validated and scrubbed again, stored without the account, refused when switched off, rate
 * limited; the summary finds what went wrong — shortcuts that did nothing, actions undone at once,
 * bursts of the same click, dismissed dialogs, unanswered keys, error templates.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import express from 'express';

const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), 'overlyx-usage-test');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'data'), { recursive: true });
mkdirSync(join(ROOT, 'projects'), { recursive: true });
process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');
process.env.OVERLYX_PROJECTS_DIR = join(ROOT, 'projects');

const { db } = await import('../packages/server/src/db.ts');
const { config } = await import('../packages/server/src/config.ts');
const { createUser, toSessionUser, authMiddleware, requireAuth } = await import('../packages/server/src/auth.ts');
const usage = await import('../packages/server/src/usage.ts');
const { scrubDetail, summarise, formatUsageReport, usageSummary } = await import('../packages/server/src/usageReport.ts');
type UsageRow = import('../packages/server/src/usageReport.ts').UsageRow;
const client = await import('../packages/client/src/usage.ts');

afterAll(() => { rmSync(ROOT, { recursive: true, force: true }); });

const SESSION = 'abcdef0123456789';
const rows = () => db.prepare('SELECT session, at, name, detail, ok, place, dt, version FROM usage_events ORDER BY id').all() as (UsageRow & { version: string | null })[];

describe('storing batches', () => {
  it('validates, scrubs again and stores events without the account; malformed ones are dropped', () => {
    db.exec('DELETE FROM usage_events');
    const now = 1_700_000_000_000;
    const n = usage.storeUsage(SESSION, [
      { ago: 5000, name: 'menu', detail: 'Edit ▸ Text Style ▸ Bold', where: 'text' },
      { ago: 4000, name: 'notice', detail: 'Label “sec:1” not found in thesis/main.tex by jane@example.org', where: 'ui' },
      { ago: 3000, name: 'dialog', detail: 'Citation', ok: false, dt: 812, where: 'dialog' },
      { ago: 2000, name: 'key', detail: 'Mod-e', ok: false, where: 'weird place!' },
      { ago: 1000, name: 'session', detail: 'mac chrome wide' },
      { ago: -50, name: 'undo', detail: '' },
      { ago: 99, name: 'not-a-kind', detail: 'x' },
      'garbage', null, { name: 42 },
      { ago: 10, name: 'view', detail: 'editor', dt: -5, ok: 'yes' },
    ], now);
    expect(n).toBe(7);
    const r = rows();
    expect(r.map(x => x.name)).toEqual(['menu', 'notice', 'dialog', 'key', 'session', 'undo', 'view']);
    expect(r[0]).toMatchObject({ session: SESSION, at: now - 5000, detail: 'Edit ▸ Text Style ▸ Bold', ok: null, place: 'text', dt: null });
    expect(r[1].detail).toBe('Label “…” not found in <file> by <email>');
    expect(r[2]).toMatchObject({ ok: 0, dt: 812, place: 'dialog' });
    expect(r[3]).toMatchObject({ ok: 0, place: null });
    expect(r[4].version).toBeTypeOf('string');         // the app version, on the session row only
    expect(r[0].version).toBeNull();
    expect(r[5].at).toBe(now);                          // a negative "ago" is clamped
    expect(r[6]).toMatchObject({ ok: null, dt: null });
    expect(usage.storeUsage('not a session id', [{ name: 'menu', detail: 'x' }])).toBe(0);
    // the table has no column that could hold the user
    const cols = (db.prepare('PRAGMA table_info(usage_events)').all() as { name: string }[]).map(c => c.name);
    expect(cols).toEqual(['id', 'session', 'at', 'name', 'detail', 'ok', 'place', 'dt', 'version']);
  });

  it('scrubs exactly like the client does', () => {
    for (const s of ['Label “sec:intro” not found', 'paper/main.tex: closed', 'invited jane.doe@example.com', 'line 12 of 34', 'You can now edit "My thesis (draft 3)"', 'a b\tc', 'x'.repeat(500)]) {
      expect(scrubDetail(s)).toBe(client.scrub(s));
    }
  });

  it('prunes rows older than the retention period', () => {
    db.exec('DELETE FROM usage_events');
    const now = Date.now();
    usage.storeUsage(SESSION, [{ ago: 0, name: 'menu', detail: 'new' }], now);
    db.prepare('INSERT INTO usage_events (session, at, name, detail) VALUES (?, ?, ?, ?)').run(SESSION, now - (usage.RETENTION_DAYS + 1) * 86400000, 'menu', 'old');
    expect(usage.pruneUsage(now)).toBe(1);
    expect(rows().map(r => r.detail)).toEqual(['new']);
  });
});

describe('the routes', () => {
  it('need a session, accept a batch, refuse a bad one, answer 204 when switched off, and serve the summary to administrators', async () => {
    db.exec('DELETE FROM usage_events');
    const dave = createUser('dave', 'Dave', 'pw');
    const admin = createUser('root', 'Root', 'pw');
    db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(admin.id);
    let who: ReturnType<typeof toSessionUser> | null = null;
    const app = express();
    app.use(authMiddleware);
    app.use((req, _res, next) => { if (who) req.user = who; next(); });
    const api = express.Router();
    api.use(requireAuth);
    api.use(express.json());
    api.use(usage.usageRoutes());
    app.use('/api', api);
    const srv = http.createServer(app);
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}/api`;
    const post = (body: unknown) => fetch(`${base}/usage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    try {
      expect((await post({ session: SESSION, events: [] })).status).toBe(401);
      who = toSessionUser(dave);
      const ok = await post({ session: SESSION, events: [{ ago: 0, name: 'toolbar', detail: 'emph', where: 'text' }, { name: 'bogus' }] });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ stored: 1 });
      expect((await post({ session: 'nope', events: [] })).status).toBe(400);
      expect((await post({ session: SESSION })).status).toBe(400);
      // stored rows know the session, not dave
      expect(rows()).toHaveLength(1);
      expect(JSON.stringify(rows())).not.toMatch(/dave|Dave/);
      // the summary: administrators only
      expect((await fetch(`${base}/admin/usage`)).status).toBe(403);
      who = toSessionUser({ ...admin, is_admin: 1 });
      const summary = await (await fetch(`${base}/admin/usage?days=7`)).json();
      expect(summary).toMatchObject({ enabled: true, retentionDays: usage.RETENTION_DAYS, sessions: 1, events: 1 });
      expect(summary.actions[0]).toMatchObject({ key: 'toolbar emph', count: 1, where: { text: 1 } });
      // switched off on the server: 204, nothing stored (the client stops sending)
      config.usageStats = false;
      try {
        expect((await post({ session: SESSION, events: [{ name: 'toolbar', detail: 'emph' }] })).status).toBe(204);
        expect(rows()).toHaveLength(1);
      } finally { config.usageStats = true; }
    } finally { srv.close(); }
  });
});

describe('the summary', () => {
  const T = 1_700_000_000_000;
  const row = (session: string, at: number, name: string, detail = '', extra: Partial<UsageRow> = {}): UsageRow => ({ session, at, name, detail, ok: null, place: 'text', dt: null, ...extra });

  it('finds failed shortcuts, actions undone at once, bursts, dismissed dialogs, unanswered keys and error templates', () => {
    const a = 'a1a1a1a1a1a1a1a1', b = 'b2b2b2b2b2b2b2b2';
    const data: UsageRow[] = [
      row(a, T, 'session', 'mac chrome wide', { place: 'ui' }),
      row(a, T + 10, 'view', 'editor', { place: 'ui' }),
      // a shortcut whose command refused twice, then worked once
      row(a, T + 1000, 'key', 'Mod-e', { ok: 0 }), row(a, T + 1500, 'key', 'Mod-e', { ok: 0 }), row(a, T + 2000, 'key', 'Mod-e', { ok: 1 }),
      // an action undone 1.2 s later (through the menu: the Undo entry itself must not count as the action)
      row(a, T + 10_000, 'toolbar', 'l-section'), row(a, T + 11_000, 'menu', 'Edit ▸ Undo'), row(a, T + 11_200, 'undo'),
      // an undo long after anything: not attributed
      row(a, T + 30_000, 'toolbar', 'emph'), row(a, T + 40_000, 'key', 'Mod-z', { ok: 1 }), row(a, T + 40_010, 'undo'),
      // clicking the same button four times in two seconds — one burst
      row(a, T + 50_000, 'toolbar', 'm-frac', { place: 'math' }), row(a, T + 50_500, 'toolbar', 'm-frac', { place: 'math' }), row(a, T + 51_000, 'toolbar', 'm-frac', { place: 'math' }), row(a, T + 51_800, 'toolbar', 'm-frac', { place: 'math' }),
      // a chord: the prefix, then an unknown key
      row(a, T + 60_000, 'chord', 'Alt+P'), row(a, T + 60_300, 'chord', 'Alt+P x', { ok: 0 }),
      // dialogs: applied after 6 s, dismissed at once, dismissed after a while
      row(a, T + 70_000, 'dialog', 'Citation', { ok: 1, dt: 6000, place: 'dialog' }), row(a, T + 71_000, 'dialog', 'Citation', { ok: 0, dt: 700, place: 'dialog' }), row(a, T + 72_000, 'dialog', 'Graphics', { ok: 0, dt: 9000, place: 'dialog' }),
      row(a, T + 80_000, 'key-unbound', 'Ctrl+Shift+K'), row(a, T + 80_100, 'key-unbound', 'Ctrl+Shift+K'), row(a, T + 80_200, 'key-unbound', 'Ctrl+Alt+7'),
      row(a, T + 90_000, 'notice', 'Label “…” not found', { place: 'ui' }), row(a, T + 90_000, 'error', 'Cannot read properties of undefined: …', { place: 'ui' }),
      // a second session: the burst does not continue across sessions, and its undo comes 8 s after the last action
      row(b, T + 51_900, 'toolbar', 'm-frac', { place: 'math' }), row(b, T + 52_000, 'toolbar', 'm-frac', { place: 'math' }),
      row(b, T + 60_000, 'undo'), row(b, T + 61_000, 'key-unbound', 'Ctrl+Shift+K'),
    ];
    const s = summarise(data, { since: T - 1, until: T + 100_000, top: 40 });
    expect(s.sessions).toBe(2);
    expect(s.events).toBe(data.length);
    const action = (key: string) => s.actions.find(x => x.key === key)!;
    expect(action('key Mod-e')).toMatchObject({ count: 3, failed: 2, undone: 0, sessions: 1 });
    expect(action('toolbar l-section')).toMatchObject({ count: 1, undone: 1 });
    expect(action('menu Edit ▸ Undo').undone).toBe(0);
    expect(action('toolbar emph').undone).toBe(0);
    expect(action('toolbar m-frac')).toMatchObject({ count: 6, repeated: 1, sessions: 2, where: { math: 6 } });
    expect(action('chord Alt+P x')).toMatchObject({ count: 1, failed: 1 });
    expect(s.undo).toEqual({ total: 3, soonAfterAction: 1 });
    expect(s.suspicious[0].key).toBe('key Mod-e');
    expect(s.suspicious.map(x => x.key)).toEqual(expect.arrayContaining(['toolbar l-section', 'toolbar m-frac', 'chord Alt+P x']));
    expect(s.suspicious.map(x => x.key)).not.toContain('toolbar emph');
    expect(s.unboundKeys).toEqual([{ key: 'Ctrl+Shift+K', count: 3, sessions: 2 }, { key: 'Ctrl+Alt+7', count: 1, sessions: 1 }]);
    expect(s.dialogs.find(d => d.key === 'Citation')).toMatchObject({ count: 2, applied: 1, dismissed: 1, dismissedQuickly: 1, medianOpenMs: 6000 });
    expect(s.dialogs.find(d => d.key === 'Graphics')).toMatchObject({ count: 1, applied: 0, dismissed: 1, dismissedQuickly: 0, medianOpenMs: null });
    expect(s.notices).toEqual([{ key: 'Label “…” not found', count: 1, sessions: 1 }]);
    expect(s.errors[0].key).toBe('Cannot read properties of undefined: …');
    expect(s.views).toEqual([{ key: 'editor', count: 1, sessions: 1 }]);
    expect(s.clients).toEqual([{ key: 'mac chrome wide', count: 1, sessions: 1 }]);
    const text = formatUsageReport(s);
    expect(text).toContain('2 sessions (page loads)');
    expect(text).toMatch(/key Mod-e\s+3\s+2 67%/);
    expect(text).toContain('Ctrl+Shift+K');
    expect(text).toMatch(/Citation\s+2\s+1\s+1 50%\s+1\s+6\.0 s/);
    expect(text).toContain('Undo: 3 in total, 1 within 5 s of a deliberate action');
  });

  it('reads the stored rows through the database handle (what the script and the admin route use)', () => {
    db.exec('DELETE FROM usage_events');
    const now = Date.now();
    usage.storeUsage(SESSION, [{ ago: 1000, name: 'toolbar', detail: 'emph', where: 'text' }, { ago: 500, name: 'undo' }], now);
    const s = usageSummary(db, { sinceMs: now - 60_000, untilMs: now + 1, top: 10 });
    expect(s.actions[0]).toMatchObject({ key: 'toolbar emph', undone: 1 });
    expect(usageSummary(db, { sinceMs: now + 10, top: 10 }).events).toBe(0);
  });
});

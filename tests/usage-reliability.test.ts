/** Consent-only, fixed-vocabulary reliability telemetry stays anonymous and aggregate-only. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import express from 'express';

const ROOT = mkdtempSync(join(tmpdir(), 'overlyx-usage-reliability-'));
mkdirSync(join(ROOT, 'data'), { recursive: true });
mkdirSync(join(ROOT, 'projects'), { recursive: true });
process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');
process.env.OVERLYX_PROJECTS_DIR = join(ROOT, 'projects');

const { db } = await import('../packages/server/src/db.ts');
const { config } = await import('../packages/server/src/config.ts');
const { createUser, toSessionUser, authMiddleware, requireAuth } = await import('../packages/server/src/auth.ts');
const usage = await import('../packages/server/src/usage.ts');
const { formatUsageReport, usageSummary } = await import('../packages/server/src/usageReport.ts');
const { privacyHtml } = await import('../packages/server/src/privacy.ts');
const { DURATION_BUCKETS, makeReliabilityDetail } = await import('../packages/core/src/reliability.ts');

const SESSION = 'c0ffee1234abcdef';
const T = 1_700_000_000_000;
let who: ReturnType<typeof toSessionUser> | null = null;
let server: http.Server | undefined;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(authMiddleware);
  app.use((req, _res, next) => { if (who) req.user = who; next(); });
  const api = express.Router();
  api.use(requireAuth);
  api.use(express.json());
  api.use(usage.usageRoutes());
  app.use('/api', api);
  const listening = http.createServer(app);
  server = listening;
  await new Promise<void>(resolve => listening.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(listening.address() as { port: number }).port}/api`;
});

afterAll(async () => {
  if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  db.close();
  rmSync(ROOT, { recursive: true, force: true });
});

const rowList = () => db.prepare('SELECT * FROM usage_events ORDER BY id').all() as Record<string, unknown>[];
const post = (body: unknown, headers: Record<string, string> = {}) => fetch(`${base}/usage`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});

describe('consent-only reliability telemetry', () => {
  it('requires auth, explicit reliability consent, and fixed canonical fields; unknown payload fields never persist', async () => {
    db.exec('DELETE FROM usage_events');
    const user = createUser('rel-user', 'Reliability Test User', 'unused');
    const admin = createUser('rel-admin', 'Reliability Test Admin', 'unused');
    db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(admin.id);

    const validDetail = makeReliabilityDetail('gesture.cancelled', 'touch')!;
    const privateMarker = 'PRIVATE-DOCUMENT-ACCOUNT-URL-COORDINATE-MARKER';
    const event = {
      name: 'reliability', detail: validDetail, where: 'deck', dt: 250,
      rawText: privateMarker, account: privateMarker, url: privateMarker, coordinates: { x: 742, y: 91 },
    };
    const batch = { session: SESSION, reliabilityConsent: true, events: [event] };

    who = null;
    expect((await post(batch)).status).toBe(401);

    who = toSessionUser(user);
    expect((await fetch(`${base}/admin/usage`)).status).toBe(403);
    const noConsent = await post({ session: SESSION, events: [
      event,
      { name: 'toolbar', detail: 'emph', where: 'text' },
    ] });
    expect(noConsent.status).toBe(200);
    expect(await noConsent.json()).toEqual({ stored: 1 });

    const consented = await post(batch);
    expect(consented.status).toBe(200);
    expect(await consented.json()).toEqual({ stored: 1 });
    const malformed = await post({ session: SESSION, reliabilityConsent: true, events: [
      { name: 'reliability', detail: `${validDetail} /home/private/report.txt`, where: 'deck', dt: 250 },
      { name: 'reliability', detail: validDetail, where: `deck ${privateMarker}`, dt: 250 },
      { name: 'reliability', detail: validDetail, where: 'deck', dt: 251 },
      { name: 'reliability', detail: validDetail, where: null, dt: 250 },
      { name: 'reliability', detail: validDetail, where: 'deck', dt: null },
      { name: 'reliability', detail: `${privateMarker} ${privateMarker}`, where: 'deck', dt: 250 },
    ] });
    expect(malformed.status).toBe(200);
    expect(await malformed.json()).toEqual({ stored: 0 });

    const rows = rowList();
    expect(rows).toHaveLength(2);
    const diagnostic = rows.find(row => row.name === 'reliability')!;
    expect(diagnostic).toMatchObject({ session: SESSION, detail: validDetail, place: 'deck', dt: 250, ok: null, version: null });
    expect(Object.keys(diagnostic).sort()).toEqual(['at', 'detail', 'dt', 'id', 'name', 'ok', 'place', 'session', 'version']);
    expect(JSON.stringify(rows)).not.toContain(privateMarker);
    expect(JSON.stringify(rows)).not.toMatch(/rel-user|Reliability Test User/);

    const columns = (db.prepare('PRAGMA table_info(usage_events)').all() as { name: string }[]).map(column => column.name);
    expect(columns).toEqual(['id', 'session', 'at', 'name', 'detail', 'ok', 'place', 'dt', 'version']);

    who = toSessionUser({ ...admin, is_admin: 1 });
    const summaryResponse = await fetch(`${base}/admin/usage?days=365`);
    expect(summaryResponse.status).toBe(200);
    const summary = await summaryResponse.json();
    expect(summary).toMatchObject({ retentionDays: 180, reliabilityRetentionDays: 30, byName: { toolbar: 1, reliability: 1 } });
    expect(summary.actions.map((action: { key: string }) => action.key)).toEqual(['toolbar emph']);
    expect(summary.reliability).toEqual({
      events: 1, sessions: 1,
      details: [{ key: validDetail, count: 1, sessions: 1 }],
      contexts: [{ key: 'deck', count: 1, sessions: 1 }],
      durations: [{ key: '250', count: 1, sessions: 1 }],
    });
    expect(JSON.stringify(summary)).not.toContain(privateMarker);
    expect(JSON.stringify(summary)).not.toMatch(/rel-user|Reliability Test User/);
    const textReport = formatUsageReport(usageSummary(db, { sinceMs: 0, untilMs: Date.now() + 1, top: 50 }));
    expect(textReport).toContain('Reliability diagnostics (consent-only, fixed categories)');
    expect(textReport).toContain(`${validDetail} 1`);
    expect(textReport).not.toContain(privateMarker);
    expect(textReport).not.toMatch(/rel-user|Reliability Test User/);

    const notice = privacyHtml();
    expect(notice).toContain('Separate reliability diagnostics are sent only if you give separate consent.');
    expect(notice).toContain('kept for 30 days');
  });

  it('honors server opt-out and Sec-GPC without writing any batch rows', async () => {
    db.exec('DELETE FROM usage_events');
    who = toSessionUser(createUser('rel-optout', 'Opt-out Test', 'unused'));
    const body = { session: SESSION, reliabilityConsent: true, events: [
      { name: 'reliability', detail: makeReliabilityDetail('canvas.timeout', 'pen'), where: 'page', dt: 3000 },
      { name: 'toolbar', detail: 'emph' },
    ] };
    const original = config.usageStats;
    try {
      config.usageStats = false;
      expect((await post(body)).status).toBe(204);
      expect(rowList()).toHaveLength(0);
      config.usageStats = true;
      const gpc = await post(body, { 'Sec-GPC': '1' });
      expect(gpc.status).toBe(204);
      expect(rowList()).toHaveLength(0);
    } finally { config.usageStats = original; }
  });

  it('enforces the existing per-user rate limit', async () => {
    who = toSessionUser(createUser('rel-rate', 'Rate Test', 'unused'));
    const body = { session: SESSION, events: [] };
    let lastStatus = 0;
    for (let i = 0; i < 241; i++) {
      const response = await post(body);
      lastStatus = response.status;
      await response.arrayBuffer();
    }
    expect(lastStatus).toBe(429);
  }, 20_000);

  it('aggregates only fixed duration buckets, keeps legacy retention, and expires reliability after 30 days', () => {
    db.exec('DELETE FROM usage_events');
    const detail = makeReliabilityDetail('keyboard.load-start', 'pen')!;
    const allBuckets = DURATION_BUCKETS.map((dt, i) => ({
      name: 'reliability', detail, where: i % 2 ? 'math' : 'portrait', dt,
    }));
    expect(usage.storeUsage(SESSION, allBuckets, T, true)).toBe(DURATION_BUCKETS.length);
    expect(usage.storeUsage(SESSION, [{ name: 'reliability', detail }], T, true)).toBe(1);
    expect(usage.storeUsage('abcdef0123456789', [{ name: 'reliability', detail }], T)).toBe(0);

    const s = usageSummary(db, { sinceMs: T - 1, untilMs: T + 1, top: 20 });
    expect(s.actions).toEqual([]);
    expect(s.reliability.events).toBe(DURATION_BUCKETS.length + 1);
    expect(s.reliability.durations.map(x => x.key).sort()).toEqual([...DURATION_BUCKETS.map(String), 'unknown'].sort());
    expect(s.reliability.contexts.find(x => x.key === 'unknown')).toMatchObject({ count: 1, sessions: 1 });

    const now = Date.now();
    const oldReliability = now - (usage.RELIABILITY_RETENTION_DAYS * 86400000 + 1);
    const oldLegacy = now - (usage.RETENTION_DAYS * 86400000 + 1);
    const stillRetainedLegacy = now - (usage.RELIABILITY_RETENTION_DAYS * 86400000 + 1);
    db.prepare('INSERT INTO usage_events (session, at, name, detail) VALUES (?, ?, ?, ?)').run(SESSION, oldReliability, 'reliability', detail);
    db.prepare('INSERT INTO usage_events (session, at, name, detail) VALUES (?, ?, ?, ?)').run(SESSION, oldLegacy, 'toolbar', 'emph');
    db.prepare('INSERT INTO usage_events (session, at, name, detail) VALUES (?, ?, ?, ?)').run(SESSION, stillRetainedLegacy, 'toolbar', 'bold');
    expect(usage.pruneUsage(now)).toBe(DURATION_BUCKETS.length + 3);
    expect(rowList().map(row => row.detail)).toEqual(['bold']);
  });
});

/**
 * Anonymous usage statistics: the web client (src/usage.ts) batches what people do — which menu
 * entries, buttons, shortcuts and dialogs, and whether the action did anything, was undone right
 * away or ended in an error message — and posts it here. Separately, consent-only reliability
 * diagnostics accept a fixed event/pointer vocabulary and coarse context/duration buckets. Stored
 * without the user: rows carry only a random per-page-load session id and bounded categories. The
 * user id is used only for the in-memory rate limit, the IP not at all.
 *
 *   POST /api/usage           { session, reliabilityConsent?, events: [{ ago, name, detail, ok?, where?, dt? }] } — 204 when off/GPC
 *   GET  /api/admin/usage     the summary (administrators; ?days=30&top=40) — usageReport.ts
 *
 * OVERLYX_USAGE_STATS=off refuses the batches (the client stops sending for the page load).
 * Legacy rows older than RETENTION_DAYS and reliability rows older than RELIABILITY_RETENTION_DAYS
 * are deleted daily. scripts/usage-report.ts prints the aggregate report.
 */
import express from 'express';
import { db } from './db.ts';
import { config } from './config.ts';
import { allow, appVersion } from './feedback.ts';
import { USAGE_NAMES, scrubDetail, usageSummary, DETAIL_MAX } from './usageReport.ts';
import { isReliabilityContext, isReliabilityDurationBucket, parseReliabilityDetail } from '@overlyx/core/reliability.ts';

db.exec(`CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session TEXT NOT NULL,
  at INTEGER NOT NULL,
  name TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  ok INTEGER,
  place TEXT,
  dt INTEGER,
  version TEXT
);
CREATE INDEX IF NOT EXISTS usage_events_at ON usage_events(at);
CREATE INDEX IF NOT EXISTS usage_events_session ON usage_events(session, at);`);

export const RETENTION_DAYS = 180;
export const RELIABILITY_RETENTION_DAYS = 30;
export const MAX_EVENTS_PER_BATCH = 200;
/** a batch's `ago` cannot reach further back than this (a tab that was asleep) */
const MAX_AGO_MS = 6 * 60 * 60 * 1000;

const NAMES: ReadonlySet<string> = new Set(USAGE_NAMES);
const SESSION_RE = /^[a-f0-9]{8,32}$/;
const WHERE_RE = /^[a-z]{1,12}$/;

const insert = db.prepare('INSERT INTO usage_events (session, at, name, detail, ok, place, dt, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');

/** Validate and store one batch; unknown kinds and malformed events are dropped. Returns how many were stored. */
export const storeUsage = db.transaction((session: string, events: unknown[], now = Date.now(), reliabilityConsent = false): number => {
  if (!SESSION_RE.test(session)) return 0;
  let n = 0;
  for (const raw of events.slice(0, MAX_EVENTS_PER_BATCH)) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown>;
    if (typeof e.name !== 'string' || !NAMES.has(e.name)) continue;
    let detail: string;
    let ok: number | null;
    let place: string | null;
    let dt: number | null;
    if (e.name === 'reliability') {
      if (reliabilityConsent !== true) continue;
      const parsed = parseReliabilityDetail(e.detail);
      if (!parsed) continue;
      if (Object.prototype.hasOwnProperty.call(e, 'where') && !isReliabilityContext(e.where)) continue;
      if (Object.prototype.hasOwnProperty.call(e, 'dt') && !isReliabilityDurationBucket(e.dt)) continue;
      // Do not run diagnostic payloads through the legacy scrubber: accept only the canonical pair.
      detail = `${parsed.event} ${parsed.pointer}`;
      ok = null;
      place = isReliabilityContext(e.where) ? e.where : null;
      dt = isReliabilityDurationBucket(e.dt) ? e.dt : null;
    } else {
      detail = scrubDetail(e.detail, DETAIL_MAX);
      ok = typeof e.ok === 'boolean' ? (e.ok ? 1 : 0) : null;
      place = typeof e.where === 'string' && WHERE_RE.test(e.where) ? e.where : null;
      dt = typeof e.dt === 'number' && Number.isFinite(e.dt) && e.dt >= 0 ? Math.min(Math.round(e.dt), 24 * 60 * 60 * 1000) : null;
    }
    const ago = typeof e.ago === 'number' && Number.isFinite(e.ago) ? Math.min(Math.max(0, e.ago), MAX_AGO_MS) : 0;
    insert.run(session, now - Math.round(ago), e.name, detail, ok, place, dt, e.name === 'session' ? appVersion : null);
    n++;
  }
  return n;
});

/** Delete what is older than the retention period. */
export function pruneUsage(now = Date.now()): number {
  return db.prepare(`DELETE FROM usage_events
    WHERE (name = 'reliability' AND at < ?)
       OR (name <> 'reliability' AND at < ?)`)
    .run(now - RELIABILITY_RETENTION_DAYS * 24 * 60 * 60 * 1000, now - RETENTION_DAYS * 24 * 60 * 60 * 1000).changes;
}
pruneUsage();
setInterval(pruneUsage, 24 * 60 * 60 * 1000).unref();

/** Routes; mounted on the authenticated /api router (JSON already parsed). */
export function usageRoutes(): express.Router {
  const r = express.Router();
  r.post('/usage', (req, res) => {
    if (!config.usageStats || req.get('Sec-GPC') === '1') { res.status(204).end(); return; }
    const u = req.user!;
    if (!allow(`usage:${u.id}`, 240)) { res.status(429).json({ error: 'rate limited' }); return; }
    const b = req.body ?? {};
    if (typeof b.session !== 'string' || !SESSION_RE.test(b.session) || !Array.isArray(b.events)) { res.status(400).json({ error: 'a session id and an events array are required' }); return; }
    res.json({ stored: storeUsage(b.session, b.events, Date.now(), b.reliabilityConsent === true) });
  });
  r.get('/admin/usage', (req, res) => {
    if (!req.user?.isAdmin) { res.status(403).json({ error: 'admin only' }); return; }
    const days = Math.min(365, Math.max(1, Number(req.query.days ?? 30) || 30));
    const top = Math.min(500, Math.max(1, Number(req.query.top ?? 40) || 40));
    res.json({ enabled: config.usageStats, retentionDays: RETENTION_DAYS, reliabilityRetentionDays: RELIABILITY_RETENTION_DAYS,
      ...usageSummary(db, { sinceMs: Date.now() - days * 24 * 60 * 60 * 1000, top }) });
  });
  return r;
}

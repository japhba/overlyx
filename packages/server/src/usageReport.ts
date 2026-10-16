/**
 * Analysis of the anonymous usage events (usage.ts stores them; the web client's src/usage.ts
 * records them). Pure: takes a database handle, so that scripts/usage-report.ts can open the
 * production database read-only while the server runs.
 *
 * What the summary looks for — the traces a counter-intuitive interface leaves behind:
 *   failed        a shortcut whose command returned false (nothing happened), per binding
 *   undone        an action followed by Undo within a few seconds (it did not do what was meant)
 *   repeated      the same action three or more times in a few seconds (clicking again and again)
 *   unbound       modifier combinations pressed in the editor that nothing answers
 *   dismissed     dialogs opened and closed without applying, and how quickly
 *   notices       error messages shown in the status bar, by template
 *   errors        uncaught errors, by template
 */
import { scrubUsageDetail } from '@overlyx/core/usagePayload.ts';
import type Database from 'better-sqlite3';
import { isReliabilityContext, isReliabilityDurationBucket, parseReliabilityDetail } from '@overlyx/core/reliability.ts';
import { parseInteractionDetail, isInteractionTarget, isClientBuildVersion } from '@overlyx/core/interactions.ts';

export const USAGE_NAMES = ['session', 'view', 'menu', 'palette', 'shortcut', 'toolbar', 'key', 'chord', 'key-unbound', 'dialog', 'notice', 'error', 'undo', 'redo', 'reliability', 'interaction'] as const;
export type UsageName = (typeof USAGE_NAMES)[number];
/** the kinds that are an action taken on purpose */
export const ACTION_NAMES: ReadonlySet<string> = new Set(['menu', 'palette', 'shortcut', 'toolbar', 'key', 'chord']);
export const DETAIL_MAX = 120;
/** an Undo this soon after an action counts against the action */
export const UNDO_WINDOW_MS = 5000;
/** identical actions this close together are one burst */
export const REPEAT_WINDOW_MS = 4000;
export const REPEAT_MIN = 3;

/**
 * Legacy usage details are scrubbed client-side and scrubbed again here so a modified client
 * cannot carry names, files or numbers into the table. Reliability details deliberately do not
 * pass through this lossy scrubber: they must exactly match the shared finite schema below.
 * Keep legacy client/server scrubbers in step (tests/usage.test.ts compares them).
 */
export function scrubDetail(s: unknown, max = DETAIL_MAX): string { return scrubUsageDetail(s, max); }

export interface UsageRow { session: string; at: number; name: string; detail: string; ok: number | null; place: string | null; dt: number | null; version?: string | null }

export interface Count { key: string; count: number; sessions: number }
export interface ActionStat extends Count {
  /** the command returned false: nothing happened (shortcuts and chords report this) */
  failed: number;
  /** followed by Undo within UNDO_WINDOW_MS */
  undone: number;
  /** bursts of REPEAT_MIN or more within REPEAT_WINDOW_MS */
  repeated: number;
  /** where it happened, most common first */
  where: Record<string, number>;
}
export interface DialogStat extends Count {
  applied: number;
  dismissed: number;
  /** dismissed within 2 s of opening: opened by mistake, or not what was expected */
  dismissedQuickly: number;
  /** median time open, ms (applied ones) */
  medianOpenMs: number | null;
}
export interface UsageSummary {
  since: number; until: number;
  sessions: number; events: number;
  byName: Record<string, number>;
  /** platform / browser / width / touch of the sessions */
  clients: Count[];
  releases: Count[];
  views: Count[];
  actions: ActionStat[];
  /** actions ranked by how often they went wrong (failed + undone + repeated), for the "what confuses people" list */
  suspicious: ActionStat[];
  unboundKeys: Count[];
  dialogs: DialogStat[];
  notices: Count[];
  errors: Count[];
  undo: { total: number; soonAfterAction: number };
  /** Consent-only fixed-vocabulary diagnostics; never part of action ranking. */
  reliability: { events: number; sessions: number; details: Count[]; contexts: Count[]; durations: Count[] };
  interactions: { events: number; details: Count[]; contexts: Count[]; durations: Count[]; problemTrails: Count[] };
}

const isUndoAction = (name: string, detail: string) => /(^|[^a-z])(undo|redo)([^a-z]|$)/i.test(detail) || (name === 'key' && /^(Shift-)?Mod-[zy]$/.test(detail));

class Counter {
  map = new Map<string, { count: number; sessions: Set<string> }>();
  add(key: string, session: string) {
    const c = this.map.get(key) ?? { count: 0, sessions: new Set<string>() };
    c.count++; c.sessions.add(session);
    this.map.set(key, c);
  }
  list(top: number): Count[] {
    return [...this.map.entries()].map(([key, c]) => ({ key, count: c.count, sessions: c.sessions.size })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)).slice(0, top);
  }
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

/** Summarise the events between `sinceMs` and `untilMs` (default now). */
export function usageSummary(db: Database.Database, opts: { sinceMs: number; untilMs?: number; top?: number }): UsageSummary {
  const until = opts.untilMs ?? Date.now();
  const top = opts.top ?? 40;
  const rows = db.prepare('SELECT session, at, name, detail, ok, place, dt, version FROM usage_events WHERE at >= ? AND at < ? ORDER BY session, at, id').all(opts.sinceMs, until) as UsageRow[];
  return summarise(rows, { since: opts.sinceMs, until, top });
}

/** The same from rows already in memory (tests). */
export function summarise(rows: UsageRow[], o: { since: number; until: number; top: number }): UsageSummary {
  const byName: Record<string, number> = {};
  const sessions = new Set<string>();
  const clients = new Counter(), views = new Counter(), unbound = new Counter(), notices = new Counter(), errors = new Counter();
  const releases = new Counter();
  const reliabilityDetails = new Counter(), reliabilityContexts = new Counter(), reliabilityDurations = new Counter();
  const reliabilitySessions = new Set<string>();
  const interactionDetails = new Counter(), interactionContexts = new Counter(), interactionDurations = new Counter(), trails = new Counter();
  let interactionEvents = 0;
  let trailSession = '';
  let trailClient = 'unknown client', trailBuild = 'unknown build';
  let trail: { at: number; label: string }[] = [];
  let reliabilityEvents = 0;
  const actions = new Map<string, { name: string; detail: string; count: number; sessions: Set<string>; failed: number; undone: number; repeated: number; where: Record<string, number> }>();
  const dialogs = new Map<string, { count: number; sessions: Set<string>; applied: number; dismissed: number; dismissedQuickly: number; open: number[] }>();
  let undoTotal = 0, undoSoon = 0;

  // per session: the last deliberate action (for "undone right after") and the current run of identical actions
  let curSession = '';
  let last: { key: string; at: number } | null = null;
  let run: { key: string; at: number; n: number; counted: boolean } | null = null;

  for (const r of rows) {
    // Defensively validate again at read time: an older or manually altered row must not make
    // free text visible in either the JSON admin summary or the text report.
    const reliabilityDetail = r.name === 'reliability' ? parseReliabilityDetail(r.detail) : null;
    if (r.name === 'reliability' && !reliabilityDetail) continue;
    const interaction = r.name === 'interaction' ? parseInteractionDetail(r.detail) : null;
    if (r.name === 'interaction' && (!interaction || !isInteractionTarget(r.place))) continue;
    if (r.session !== trailSession) { trailSession = r.session; trail = []; trailClient = 'unknown client'; trailBuild = 'unknown build'; }
    if (r.name === 'session') {
      if (/^(ios|android|mac|windows|linux|other) (firefox|edge|chrome|safari|other) (narrow|medium|wide)( touch)?$/.test(r.detail)) trailClient = r.detail;
      const desktop = /^vscode (linux|darwin|win32|freebsd|openbsd|aix|sunos|android) [a-z#0-9]{1,12} (local|remote) (web|desktop)$/.exec(r.detail);
      if (desktop) trailClient = `vscode ${desktop[1]} ${desktop[2]} ${desktop[3]}`;
      if (isClientBuildVersion(r.version) || typeof r.version === 'string' && /^[a-f0-9]{7,40}$/.test(r.version)) trailBuild = r.version;
    }
    const prefix = `[${trailClient}; ${trailBuild}] `;
    trail = trail.filter(t => r.at - t.at <= 30000).slice(-7);
    if (interaction) {
      const label = `${r.place}: ${r.detail}`;
      interactionEvents++;
      interactionDetails.add(label, r.session); interactionContexts.add(r.place!, r.session);
      if (isReliabilityDurationBucket(r.dt)) interactionDurations.add(String(r.dt), r.session);
      trail.push({ at: r.at, label });
      const problem = ['failed', 'denied', 'missing', 'conflict', 'invalid', 'offline'].includes(interaction.outcome)
        || interaction.outcome === 'unchanged' && ['backspace', 'delete', 'cut'].includes(interaction.action);
      const repeated = ['click', 'backspace', 'delete'].includes(interaction.action) && trail.filter(t => t.label === label && r.at - t.at <= REPEAT_WINDOW_MS).length >= REPEAT_MIN;
      if (problem || repeated) trails.add(prefix + trail.map(t => t.label).join(' → '), r.session);
    } else if ((r.name === 'error' || r.name === 'notice' || r.name === 'undo') && trail.length) {
      // Do not copy any legacy free-text error or command label into diagnostic trails.
      trails.add(prefix + [...trail.map(t => t.label), r.name].join(' → '), r.session);
    }
    byName[r.name] = (byName[r.name] ?? 0) + 1;
    sessions.add(r.session);
    if (interaction) continue;
    if (r.name === 'reliability' && reliabilityDetail) {
      reliabilityEvents++;
      reliabilitySessions.add(r.session);
      reliabilityDetails.add(`${reliabilityDetail.event} ${reliabilityDetail.pointer}`, r.session);
      reliabilityContexts.add(isReliabilityContext(r.place) ? r.place : 'unknown', r.session);
      reliabilityDurations.add(isReliabilityDurationBucket(r.dt) ? String(r.dt) : 'unknown', r.session);
      continue;
    }
    if (r.session !== curSession) { curSession = r.session; last = null; run = null; }
    if (r.name === 'session') { clients.add(r.detail, r.session); if (isClientBuildVersion(r.version) || typeof r.version === 'string' && /^[a-f0-9]{7,40}$/.test(r.version)) releases.add(r.version, r.session); continue; }
    if (r.name === 'view') { views.add(r.detail, r.session); continue; }
    if (r.name === 'key-unbound') { unbound.add(r.detail, r.session); continue; }
    if (r.name === 'notice') { notices.add(r.detail, r.session); continue; }
    if (r.name === 'error') { errors.add(r.detail, r.session); continue; }
    if (r.name === 'dialog') {
      const d = dialogs.get(r.detail) ?? { count: 0, sessions: new Set<string>(), applied: 0, dismissed: 0, dismissedQuickly: 0, open: [] };
      d.count++; d.sessions.add(r.session);
      if (r.ok === 1) { d.applied++; if (r.dt !== null) d.open.push(r.dt); }
      else { d.dismissed++; if (r.dt !== null && r.dt < 2000) d.dismissedQuickly++; }
      dialogs.set(r.detail, d);
      continue;
    }
    if (r.name === 'undo' || r.name === 'redo') {
      if (r.name === 'undo') {
        undoTotal++;
        if (last && r.at - last.at <= UNDO_WINDOW_MS) { undoSoon++; actions.get(last.key)!.undone++; last = null; }
      }
      continue;
    }
    if (!ACTION_NAMES.has(r.name)) continue;
    const key = `${r.name} ${r.detail}`;
    const a = actions.get(key) ?? { name: r.name, detail: r.detail, count: 0, sessions: new Set<string>(), failed: 0, undone: 0, repeated: 0, where: {} };
    a.count++; a.sessions.add(r.session);
    if (r.ok === 0) a.failed++;
    if (r.place) a.where[r.place] = (a.where[r.place] ?? 0) + 1;
    actions.set(key, a);
    // a chord prefix on its own ("Alt+P") is the start of a chord, not an action with an outcome
    const deliberate = !(r.name === 'chord' && !r.detail.includes(' '));
    if (deliberate && !isUndoAction(r.name, r.detail)) last = { key, at: r.at };
    if (run && run.key === key && r.at - run.at <= REPEAT_WINDOW_MS) {
      run.n++; run.at = r.at;
      if (run.n >= REPEAT_MIN && !run.counted) { run.counted = true; a.repeated++; }
    } else run = { key, at: r.at, n: 1, counted: false };
  }

  const actionList: ActionStat[] = [...actions.entries()].map(([key, a]) => ({
    key, count: a.count, sessions: a.sessions.size, failed: a.failed, undone: a.undone, repeated: a.repeated,
    where: Object.fromEntries(Object.entries(a.where).sort((x, y) => y[1] - x[1])),
  }));
  const byCount = [...actionList].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  const trouble = (a: ActionStat) => a.failed + a.undone + a.repeated;
  const suspicious = actionList.filter(a => trouble(a) > 0).sort((a, b) => trouble(b) - trouble(a) || trouble(b) / b.count - trouble(a) / a.count || a.key.localeCompare(b.key));
  const dialogList: DialogStat[] = [...dialogs.entries()].map(([key, d]) => ({
    key, count: d.count, sessions: d.sessions.size, applied: d.applied, dismissed: d.dismissed, dismissedQuickly: d.dismissedQuickly, medianOpenMs: median(d.open),
  })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

  return {
    since: o.since, until: o.until, sessions: sessions.size, events: rows.length, byName,
    clients: clients.list(o.top), releases: releases.list(o.top), views: views.list(o.top),
    actions: byCount.slice(0, o.top), suspicious: suspicious.slice(0, o.top),
    unboundKeys: unbound.list(o.top), dialogs: dialogList.slice(0, o.top),
    notices: notices.list(o.top), errors: errors.list(o.top),
    undo: { total: undoTotal, soonAfterAction: undoSoon },
    reliability: {
      events: reliabilityEvents, sessions: reliabilitySessions.size,
      // All are finite schema vocabularies; don't truncate a complete reliability breakdown to the
      // legacy action-report `top` limit.
      details: reliabilityDetails.list(500), contexts: reliabilityContexts.list(500), durations: reliabilityDurations.list(500),
    },
    interactions: { events: interactionEvents, details: interactionDetails.list(o.top), contexts: interactionContexts.list(100), durations: interactionDurations.list(20), problemTrails: trails.list(o.top) },
  };
}

/* ------------------------------------------------------------------ text report */

const pad = (s: string | number, n: number) => String(s).padEnd(n);
const rpad = (s: string | number, n: number) => String(s).padStart(n);
const pct = (part: number, whole: number) => (whole ? `${Math.round((100 * part) / whole)}%` : '–');
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The summary as a plain-text report (scripts/usage-report.ts prints it). */
export function formatUsageReport(s: UsageSummary): string {
  const out: string[] = [];
  const section = (title: string) => { out.push('', title, '-'.repeat(title.length)); };
  out.push(`OverLyX usage ${day(s.since)} – ${day(s.until)}: ${s.sessions} sessions (page loads), ${s.events} events`);
  out.push(Object.entries(s.byName).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', '));

  if (s.suspicious.length) {
    section('Actions that went wrong most often (nothing happened / undone within 5 s / repeated in a burst)');
    out.push(`${pad('action', 60)} ${rpad('uses', 6)} ${rpad('failed', 7)} ${rpad('undone', 7)} ${rpad('repeat', 7)}  where`);
    for (const a of s.suspicious.slice(0, 30)) {
      const where = Object.entries(a.where).slice(0, 3).map(([k, v]) => `${k} ${v}`).join(', ');
      out.push(`${pad(a.key.slice(0, 60), 60)} ${rpad(a.count, 6)} ${rpad(a.failed ? `${a.failed} ${pct(a.failed, a.count)}` : '', 7)} ${rpad(a.undone ? `${a.undone} ${pct(a.undone, a.count)}` : '', 7)} ${rpad(a.repeated || '', 7)}  ${where}`);
    }
  }
  if (s.unboundKeys.length) {
    section('Shortcuts pressed in the editor that nothing answers');
    for (const k of s.unboundKeys.slice(0, 25)) out.push(`${pad(k.key, 30)} ${rpad(k.count, 6)}  in ${k.sessions} session${k.sessions === 1 ? '' : 's'}`);
  }
  if (s.dialogs.length) {
    section('Dialogs: applied vs dismissed');
    out.push(`${pad('dialog', 40)} ${rpad('opened', 7)} ${rpad('applied', 8)} ${rpad('dismissed', 10)} ${rpad('<2s', 5)}  median open`);
    for (const d of s.dialogs) out.push(`${pad(d.key.slice(0, 40), 40)} ${rpad(d.count, 7)} ${rpad(d.applied, 8)} ${rpad(`${d.dismissed} ${pct(d.dismissed, d.count)}`, 10)} ${rpad(d.dismissedQuickly, 5)}  ${d.medianOpenMs === null ? '–' : `${(d.medianOpenMs / 1000).toFixed(1)} s`}`);
  }
  if (s.notices.length) {
    section('Error messages shown (templates)');
    for (const n of s.notices.slice(0, 30)) out.push(`${rpad(n.count, 6)}  ${n.key}  (${n.sessions} session${n.sessions === 1 ? '' : 's'})`);
  }
  if (s.errors.length) {
    section('Uncaught errors (templates)');
    for (const n of s.errors.slice(0, 20)) out.push(`${rpad(n.count, 6)}  ${n.key}  (${n.sessions} session${n.sessions === 1 ? '' : 's'})`);
  }
  if (s.reliability.events) {
    section('Reliability diagnostics (consent-only, fixed categories)');
    out.push(`${s.reliability.events} events in ${s.reliability.sessions} session${s.reliability.sessions === 1 ? '' : 's'}`);
    for (const [label, counts] of [
      ['event / pointer', s.reliability.details], ['context', s.reliability.contexts], ['duration bucket (ms)', s.reliability.durations],
    ] as const) {
      out.push(`${label}: ${counts.map(c => `${c.key} ${c.count}`).join(', ')}`);
    }
  }
  if (s.interactions.events) {
    section('Detailed interactions (fixed categories; 30-day retention)');
    out.push(`${s.interactions.events} events; states: selection, content, display, access, tracking, pointer`);
    for (const d of s.interactions.details) out.push(`${rpad(d.count, 6)}  ${d.key} (${d.sessions} sessions)`);
    out.push('surfaces: ' + s.interactions.contexts.map(c => `${c.key} ${c.count}`).join(', '));
    if (s.interactions.problemTrails.length) {
      section('Action trails before errors or unchanged deletion attempts (up to 8 events within 30 s; signals to investigate)');
      for (const t of s.interactions.problemTrails) out.push(`${rpad(t.count, 6)}  ${t.key} (${t.sessions} sessions)`);
    }
  }
  section(`Undo: ${s.undo.total} in total, ${s.undo.soonAfterAction} within 5 s of a deliberate action`);
  if (s.actions.length) {
    section('Most used actions');
    for (const a of s.actions.slice(0, 40)) out.push(`${rpad(a.count, 6)}  ${pad(a.key.slice(0, 70), 70)} ${a.sessions} session${a.sessions === 1 ? '' : 's'}`);
  }
  if (s.views.length || s.clients.length) {
    section('Screens and clients');
    out.push('screens: ' + s.views.map(v => `${v.key} ${v.count}`).join(', '));
    out.push('clients: ' + s.clients.map(c => `${c.key} ×${c.count}`).join(', '));
    if (s.releases.length) out.push('app builds: ' + s.releases.map(c => `${c.key} ×${c.count}`).join(', '));
  }
  return out.join('\n') + '\n';
}

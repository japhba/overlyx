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
import type Database from 'better-sqlite3';

export const USAGE_NAMES = ['session', 'view', 'menu', 'palette', 'shortcut', 'toolbar', 'key', 'chord', 'key-unbound', 'dialog', 'notice', 'error', 'undo', 'redo'] as const;
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
 * The client scrubs every detail before queueing (src/usage.ts scrub); the server does it again
 * so that nothing a modified client sends can carry a name, a file or a number into the table.
 * Keep the two in step (tests/usage.test.ts compares them).
 */
export function scrubDetail(s: unknown, max = DETAIL_MAX): string {
  return String(s ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/“[^”]*”|"[^"]*"|‘[^’]*’|`[^`]*`|'[^']{2,}'/g, '“…”')
    .replace(/\S+@\S+/g, '<email>')
    .replace(/\S*?(?:\/|\\|\.(?:tex|lyx|bib|pdf|png|jpe?g|svg|gif|eps|md|txt|board|json|zip|csv|sty|cls))\b[^\s:;,!?()[\]]*/gi, '<file>')
    .replace(/\d+(?:[.,]\d+)?/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export interface UsageRow { session: string; at: number; name: string; detail: string; ok: number | null; place: string | null; dt: number | null }

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
  views: Count[];
  actions: ActionStat[];
  /** actions ranked by how often they went wrong (failed + undone + repeated), for the "what confuses people" list */
  suspicious: ActionStat[];
  unboundKeys: Count[];
  dialogs: DialogStat[];
  notices: Count[];
  errors: Count[];
  undo: { total: number; soonAfterAction: number };
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
  const rows = db.prepare('SELECT session, at, name, detail, ok, place, dt FROM usage_events WHERE at >= ? AND at < ? ORDER BY session, at, id').all(opts.sinceMs, until) as UsageRow[];
  return summarise(rows, { since: opts.sinceMs, until, top });
}

/** The same from rows already in memory (tests). */
export function summarise(rows: UsageRow[], o: { since: number; until: number; top: number }): UsageSummary {
  const byName: Record<string, number> = {};
  const sessions = new Set<string>();
  const clients = new Counter(), views = new Counter(), unbound = new Counter(), notices = new Counter(), errors = new Counter();
  const actions = new Map<string, { name: string; detail: string; count: number; sessions: Set<string>; failed: number; undone: number; repeated: number; where: Record<string, number> }>();
  const dialogs = new Map<string, { count: number; sessions: Set<string>; applied: number; dismissed: number; dismissedQuickly: number; open: number[] }>();
  let undoTotal = 0, undoSoon = 0;

  // per session: the last deliberate action (for "undone right after") and the current run of identical actions
  let curSession = '';
  let last: { key: string; at: number } | null = null;
  let run: { key: string; at: number; n: number; counted: boolean } | null = null;

  for (const r of rows) {
    byName[r.name] = (byName[r.name] ?? 0) + 1;
    sessions.add(r.session);
    if (r.session !== curSession) { curSession = r.session; last = null; run = null; }
    if (r.name === 'session') { clients.add(r.detail, r.session); continue; }
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
    clients: clients.list(o.top), views: views.list(o.top),
    actions: byCount.slice(0, o.top), suspicious: suspicious.slice(0, o.top),
    unboundKeys: unbound.list(o.top), dialogs: dialogList.slice(0, o.top),
    notices: notices.list(o.top), errors: errors.list(o.top),
    undo: { total: undoTotal, soonAfterAction: undoSoon },
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
  section(`Undo: ${s.undo.total} in total, ${s.undo.soonAfterAction} within 5 s of a deliberate action`);
  if (s.actions.length) {
    section('Most used actions');
    for (const a of s.actions.slice(0, 40)) out.push(`${rpad(a.count, 6)}  ${pad(a.key.slice(0, 70), 70)} ${a.sessions} session${a.sessions === 1 ? '' : 's'}`);
  }
  if (s.views.length || s.clients.length) {
    section('Screens and clients');
    out.push('screens: ' + s.views.map(v => `${v.key} ${v.count}`).join(', '));
    out.push('clients: ' + s.clients.map(c => `${c.key} ×${c.count}`).join(', '));
  }
  return out.join('\n') + '\n';
}

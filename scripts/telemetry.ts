/**
 * Telemetry for development without users' identities (DOCS.md "Accounts on the server"). Run as root
 * through `sudo overlyx-telemetry …` (deploy/overlyx-telemetry), it prints the anonymous usage summary,
 * the problem reports without who sent them, and the service logs. E-mail addresses and credentials
 * are removed (as for the maintenance worker); every other account and its projects appear under a
 * stable pseudonym (u-…, u-…/p-…), the owner's own (OVERLYX_TELEMETRY_OWNER, default jan) as they are.
 *
 *   telemetry.ts usage [days]        the usage summary (scripts/usage-report.ts), default 30 days
 *   telemetry.ts reports [days]      problem reports, newest first (scripts/reports.ts minus the sender)
 *   telemetry.ts report <id>         one report in full
 *   telemetry.ts logs [hours] [overlyx|autodeploy|maintenance]   a service's log, default 6 hours
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { usageSummary, formatUsageReport } from '../packages/server/src/usageReport.ts';
import { privateText } from './maintenance.ts';

const dataDir = process.env.OVERLYX_DATA_DIR ?? '/root/lyx/overlyx/data';
const projectsDir = process.env.OVERLYX_PROJECTS_DIR ?? '/root/projects';
const owner = process.env.OVERLYX_TELEMETRY_OWNER ?? 'jan';
const [what = 'usage', first, second] = process.argv.slice(2);
const number = (s: string | undefined, fallback: number, max: number) => Math.min(max, Math.max(1, Math.floor(Number(s ?? fallback)) || fallback));
const units: Record<string, string> = { overlyx: 'overlyx', autodeploy: 'overlyx-autodeploy', maintenance: 'overlyx-maintenance' };
const usage = 'usage: telemetry.ts usage [days] | reports [days] | report <id> | logs [hours] [overlyx|autodeploy|maintenance]';

// A keyed hash, so that hashing guessed names does not undo a pseudonym; the key stays root's.
function pseudonymKey(): Buffer {
  const file = path.join(dataDir, 'telemetry-pseudonyms.key');
  try { return fs.readFileSync(file); } catch { /* first use */ }
  try { fs.writeFileSync(file, crypto.randomBytes(32), { mode: 0o600, flag: 'wx' }); } catch { /* written meanwhile */ }
  return fs.readFileSync(file);
}

// as mirror.ts names a project's GitHub mirror (not imported: it opens the database)
const repoNameFor = (project: string) => {
  const n = project.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '') || 'project';
  return /\.git$/i.test(n) ? n.slice(0, -4) + '-git' : n;
};

function folders(dir: string): string[] {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name); } catch { return []; }
}

function anonymizer(db: Database.Database): (text: string) => string {
  const key = pseudonymKey();
  const tag = (kind: string, name: string) => `${kind}-${crypto.createHmac('sha256', key).update(`${kind}:${name}`).digest('hex').slice(0, 6)}`;
  const people = new Map<string, string>();     // a name as it appears in text → its pseudonym
  for (const u of db.prepare('SELECT username, display_name FROM users').all() as { username: string; display_name: string | null }[]) {
    if (u.username === owner) continue;
    people.set(u.username, tag('u', u.username));
    if (u.display_name && u.display_name.trim().length >= 3) people.set(u.display_name.trim(), tag('u', u.username));
  }
  const projects = new Map<string, string>();   // "<owner>/<name>" raw and URL-encoded, and its mirror's name
  for (const ns of folders(projectsDir)) {
    if (ns === owner) continue;
    for (const name of folders(path.join(projectsDir, ns))) {
      const project = `${ns}/${name}`, alias = `${people.get(ns) ?? tag('u', ns)}/${tag('p', project)}`;
      for (const form of [project, encodeURIComponent(project), `${encodeURIComponent(ns)}/${encodeURIComponent(name)}`]) projects.set(form, alias);
      const mirror = repoNameFor(project);   // and its collision-proof variant
      for (const form of [mirror, `${mirror}-${crypto.createHash('sha1').update(project).digest('hex').slice(0, 8)}`]) projects.set(form, alias.replace('/', '-'));
    }
  }
  // longest first, and never inside a longer word (user names may contain dots and dashes); a name
  // followed by "-" is taken too — what is made of it (a mirror's name) belongs to that account
  const pattern = (names: string[], after = '') => names.length ? new RegExp(`(?<![\\w.-])(${names.sort((x, y) => y.length - x.length)
    .map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?!\\w)${after}`, 'g') : null;
  // a project's files too ("<owner>/<name>/<path>"): a file name can say what a document is about —
  // the extension stays, it tells a .tex from a .bib
  const projectNames = pattern([...projects.keys()], `((?:/[^\\s"'\`,;:()\\[\\]<>]+)*)`), personNames = pattern([...people.keys()]);
  const file = (project: string, rel: string) => `/${tag('f', `${project}${rel}`)}${/\.[A-Za-z0-9]{1,8}$/.exec(rel)?.[0] ?? ''}`;
  return text => {
    let s = privateText(text, Infinity);
    if (projectNames) s = s.replace(projectNames, (_m, name: string, rel: string) => projects.get(name)! + (rel ? file(name, rel) : ''));
    if (personNames) s = s.replace(personNames, m => people.get(m)!);
    return s;
  };
}

// The server's own lines carry a [tag]. What has none — output relayed from Codex, the continuation of
// a multi-line message — can be a document's text (a patch Codex failed to apply), and is left out.
function serverLog(log: string, clean: (text: string) => string): string {
  const out: string[] = [];
  let left = 0;
  const note = () => { if (left) out.push(`… ${left} untagged line${left > 1 ? 's' : ''} left out (relayed output may hold document text)`); left = 0; };
  for (const line of log.split('\n')) {
    const m = /^(\S+ \S+ ([\w.-]+)\[\d+\]: )(.*)$/.exec(line);
    if (!m) { if (line) out.push(clean(line)); continue; }
    const [, head, source, message] = m;
    if (source !== 'systemd' && !/^(\[[\w-]+(?: [\w-]+)?\]|\s+at |OverLyX |shutting down|\w*Error\b|\(node:)/.test(message)) { left++; continue; }
    note();
    // Codex's log lines (the Agent panel's, as "[agent <user>]") can quote a document after their first words
    out.push(head + clean(/^\[agent \d+\]/.test(message) ? message.slice(0, 160) : message));
  }
  note();
  return out.join('\n');
}

interface Report { id: number; kind: string; title: string; body: string; version: string; user_agent: string | null; count: number; created_at: number; last_at: number }

function main() {
  if (!['usage', 'reports', 'report', 'logs'].includes(what) || (what === 'logs' && second && !units[second])) { console.error(usage); process.exit(2); }
  const db = new Database(path.join(dataDir, 'overlyx.sqlite'), { readonly: true, fileMustExist: true });
  const clean = anonymizer(db);
  const when = (t: number) => new Date(t).toISOString().replace('T', ' ').slice(0, 16);
  try {
    if (what === 'usage') {
      const days = number(first, 30, 365);
      process.stdout.write(clean(formatUsageReport(usageSummary(db, { sinceMs: Date.now() - days * 86400000, top: 40 }))));
    } else if (what === 'reports' || what === 'report') {
      // never joined with accounts: who sent a report stays root's (scripts/reports.ts); mail is not a report
      const columns = 'id, kind, title, body, version, user_agent, count, created_at, last_at';
      const rows = (what === 'report'
        ? db.prepare(`SELECT ${columns} FROM reports WHERE id = ? AND kind != 'mail'`).all(number(first, 0, 2 ** 31))
        : db.prepare(`SELECT ${columns} FROM reports WHERE last_at >= ? AND kind != 'mail' ORDER BY last_at DESC`).all(Date.now() - number(first, 30, 365) * 86400000)) as Report[];
      if (!rows.length) console.log(what === 'report' ? `no report #${first}` : 'no reports in that time');
      for (const r of rows) {
        const seen = r.count > 1 ? ` · ${r.count}× until ${when(r.last_at)}` : '';
        console.log(clean(`#${r.id} ${when(r.created_at)} [${r.kind}] ${r.title}${seen} · ${r.version}`));
        const body = what === 'report' ? r.body : r.body.split('\n').slice(0, 6).join('\n');
        console.log(clean(body).replace(/^/gm, '    '));
        if (what === 'report' && r.user_agent) console.log(`    browser: ${r.user_agent}`);
        console.log('');
      }
    } else {
      const log = execFileSync('journalctl', ['-u', units[second ?? 'overlyx'], '--since', `-${number(first, 6, 24 * 90)}h`, '-n', '5000', '--no-pager', '-o', 'short-iso'],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      process.stdout.write((second ?? 'overlyx') === 'overlyx' ? serverLog(log, clean) : log.split('\n').map(clean).join('\n'));
    }
  } finally { db.close(); }
}

main();

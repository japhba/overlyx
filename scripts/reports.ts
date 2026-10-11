#!/usr/bin/env -S npx tsx
/**
 * List the problem reports and error records kept on the server (packages/server/src/feedback.ts
 * stores them in the `reports` table; nothing goes to GitHub any more). Newest first; a person's
 * report shows who sent it, so the operator can answer by e-mail. Opens the database read-only, so
 * it is safe next to the running server.
 *
 *   npx tsx scripts/reports.ts                       # the last 30 days, everything
 *   npx tsx scripts/reports.ts --kind feedback       # only what people wrote (or client-error, server-error, vscode-error)
 *   npx tsx scripts/reports.ts --days 7 --full       # with the whole text and stack traces
 *   npx tsx scripts/reports.ts --id 12               # one report in full
 *   npx tsx scripts/reports.ts --json --db /path/to/overlyx.sqlite
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
if (args.includes('--help') || args.includes('-h')) { console.log('usage: reports.ts [--days N] [--kind K] [--id N] [--full] [--json] [--db path]'); process.exit(0); }
const days = Math.max(1, Number(opt('--days') ?? 30) || 30);
const kind = opt('--kind');
const id = opt('--id');
const full = args.includes('--full') || !!id;
const here = path.dirname(fileURLToPath(import.meta.url));
const dbPath = opt('--db') ?? path.join(process.env.OVERLYX_DATA_DIR ?? path.join(here, '..', 'data'), 'overlyx.sqlite');

interface Row { id: number; kind: string; title: string; body: string; version: string; user_agent: string | null; count: number; created_at: number; last_at: number; username: string | null; name: string | null; email: string | null }
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const where = id ? 'r.id = @id' : `r.last_at >= @since${kind ? ' AND r.kind = @kind' : ''}`;
const rows = db.prepare(`SELECT r.*, u.username, u.display_name AS name, u.email FROM reports r LEFT JOIN users u ON u.id = r.user_id
  WHERE ${where} ORDER BY r.last_at DESC`).all({ id: Number(id), since: Date.now() - days * 24 * 60 * 60 * 1000, kind }) as Row[];
db.close();

if (args.includes('--json')) { process.stdout.write(JSON.stringify(rows, null, 2) + '\n'); process.exit(0); }
const when = (t: number) => new Date(t).toISOString().replace('T', ' ').slice(0, 16);
if (!rows.length) console.log(id ? `no report #${id}` : `no reports in the last ${days} days${kind ? ` of kind ${kind}` : ''}`);
for (const r of rows) {
  const who = r.username ? `${r.name} <${r.email ?? r.username}>` : '';
  const seen = r.count > 1 ? ` · ${r.count}× until ${when(r.last_at)}` : '';
  console.log(`#${r.id} ${when(r.created_at)} [${r.kind}] ${r.title}${seen}${who ? ' · ' + who : ''} · ${r.version}`);
  if (full) {
    console.log(r.body.replace(/^/gm, '    '));
    if (r.user_agent) console.log(`    browser: ${r.user_agent}`);
    console.log('');
  }
}

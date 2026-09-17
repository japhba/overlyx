#!/usr/bin/env -S npx tsx
/**
 * Summarise the anonymous usage statistics (packages/server/src/usage.ts stores them, usageReport.ts
 * analyses them): which actions go wrong — a shortcut that did nothing, an action undone right
 * away, a button clicked again and again, a dialog dismissed at once, an error message — and how
 * often. Opens the database read-only, so it is safe next to the running server.
 *
 *   OVERLYX_DATA_DIR=/root/lyx/overlyx/data npx tsx scripts/usage-report.ts            # last 30 days
 *   npx tsx scripts/usage-report.ts --days 7 --top 20                                  # a week, shorter lists
 *   npx tsx scripts/usage-report.ts --json > usage.json                                # the raw summary
 *   npx tsx scripts/usage-report.ts --db /path/to/overlyx.sqlite
 *
 * The same summary is served to administrators at GET /api/admin/usage?days=30.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { usageSummary, formatUsageReport } from '../packages/server/src/usageReport.ts';

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
if (args.includes('--help') || args.includes('-h')) { console.log('usage: usage-report.ts [--days N] [--top N] [--json] [--db path]'); process.exit(0); }
const days = Math.max(1, Number(opt('--days') ?? 30) || 30);
const top = Math.max(1, Number(opt('--top') ?? 40) || 40);
const here = path.dirname(fileURLToPath(import.meta.url));
const dbPath = opt('--db') ?? path.join(process.env.OVERLYX_DATA_DIR ?? path.join(here, '..', 'data'), 'overlyx.sqlite');

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const summary = usageSummary(db, { sinceMs: Date.now() - days * 24 * 60 * 60 * 1000, top });
db.close();
process.stdout.write(args.includes('--json') ? JSON.stringify(summary, null, 2) + '\n' : formatUsageReport(summary));

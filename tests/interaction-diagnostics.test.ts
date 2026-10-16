import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { makeInteractionDetail, parseInteractionDetail, apiInteraction } from '../packages/core/src/interactions.ts';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overlyx-interactions-'));
process.env.OVERLYX_DATA_DIR = root;
const { db } = await import('../packages/server/src/db.ts');
const { storeUsage, pruneUsage, vscodeUsageRoutes } = await import('../packages/server/src/usage.ts');
const { usageSummary, formatUsageReport } = await import('../packages/server/src/usageReport.ts');
afterAll(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

describe('detailed interaction storage and reports', () => {
  it('accepts VS Code batches without an account and validates runtime metadata independently', async () => {
    db.exec('DELETE FROM usage_events');
    const app = express(); app.use(vscodeUsageRoutes());
    const server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/vscode-usage`;
    const body = { schema: 1, session: 'abcdef0123456789', extensionVersion: '1.2.3', vscodeVersion: '1.99.0', platform: 'linux', arch: 'x64', remote: 'remote', uiKind: 'desktop', user: 'private',
      events: [{ name: 'session', detail: 'private identity' }, { name: 'interaction', detail: makeInteractionDetail('extension-build', 'failed'), where: 'ui', path: '/private/main.tex' }] };
    const post = (b: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    try {
      const response = await post(body);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ stored: 2 });
      const rows = db.prepare('SELECT * FROM usage_events ORDER BY id').all();
      expect(rows[0]).toMatchObject({ detail: 'vscode linux x# remote desktop', version: 'vscode:1.2.3;code:1.99.0' });
      expect(JSON.stringify(rows)).not.toMatch(/private|main\.tex/);
      expect((await post({ ...body, remote: 'secret-hostname' })).status).toBe(400);
      expect((await post({ ...body, extensionVersion: 'private-project' })).status).toBe(400);
      const gpc = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'Sec-GPC': '1' }, body: JSON.stringify(body) });
      expect(gpc.status).toBe(204);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it('independently validates bounded categories and drops private or malformed fields', () => {
    db.exec('DELETE FROM usage_events');
    const detail = makeInteractionDetail('delete', 'unchanged', { selection: 'caret', content: 'empty', display: 'collapsed', access: 'view' })!;
    expect(parseInteractionDetail(detail)).not.toBeNull();
    expect(parseInteractionDetail(detail + ' secret')).toBeNull();
    const stored = storeUsage('abcdef0123456789', [
      { name: 'interaction', detail, where: 'note', dt: 500, user: 'private', document: 'secret.tex' },
      { name: 'interaction', detail: 'private note content', where: 'note' },
      { name: 'interaction', detail, where: 'secret-project' },
      { name: 'interaction', detail, where: 'note', dt: 1234 },
    ]);
    expect(stored).toBe(1);
    const rows = db.prepare('SELECT * FROM usage_events').all();
    expect(JSON.stringify(rows)).not.toMatch(/private|secret/);
    expect(rows[0]).toMatchObject({ dt: 500 });
  });

  it('reports bounded action trails without crossing page-load sessions or copying free text', () => {
    db.exec('DELETE FROM usage_events');
    const now = Date.now();
    storeUsage('aaaaaaaaaaaaaaaa', [
      { name: 'interaction', ago: 1000, detail: makeInteractionDetail('click', 'attempt'), where: 'note' },
      { name: 'interaction', ago: 500, detail: makeInteractionDetail('delete', 'unchanged', { content: 'empty' }), where: 'note' },
      { name: 'notice', detail: 'an unquoted private value' },
    ], now);
    storeUsage('bbbbbbbbbbbbbbbb', [{ name: 'interaction', detail: makeInteractionDetail('api-import', 'failed'), where: 'api' }], now);
    const summary = usageSummary(db, { sinceMs: now - 30000, untilMs: now + 1 });
    expect(summary.interactions.events).toBe(3);
    expect(summary.interactions.problemTrails.some(t => /note: click.* → note: delete/.test(t.key))).toBe(true);
    const other = summary.interactions.problemTrails.find(t => t.key.includes('api-import'))!;
    expect(other.key).not.toContain('note:');
    expect(JSON.stringify(summary.interactions)).not.toMatch(/private|aaaaaaaa|bbbbbbbb/);
    expect(formatUsageReport(summary)).toContain('Action trails');
    expect(apiInteraction('POST', '/api/import/lyx?filename=secret.lyx')).toBe('api-import');
    expect(apiInteraction('POST', '/api/usage')).toBeNull();
  });

  it('expires detailed events after 30 days while retaining ordinary aggregate events', () => {
    db.exec('DELETE FROM usage_events');
    const now = Date.now();
    storeUsage('aaaaaaaaaaaaaaaa', [{ name: 'interaction', detail: makeInteractionDetail('click', 'attempt'), where: 'note' }, { name: 'menu', detail: 'File' }], now - 31 * 86400000);
    expect(pruneUsage(now)).toBe(1);
    expect(db.prepare('SELECT name FROM usage_events').all()).toEqual([{ name: 'menu' }]);
  });
});

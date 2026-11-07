/**
 * My fonts (server myfonts.ts, userSettings.ts `fonts`): Google fonts kept in the account — valid
 * family names only, no duplicates, at most MY_FONTS_MAX; guests and read-only sign-ins can't change them.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import http from 'node:http';
import { rmSync } from 'node:fs';

const ROOT = vi.hoisted(() => {
  const r = require('node:path').join(process.env.OVERLYX_SCRATCH ?? require('node:os').tmpdir(), 'overlyx-myfonts-test');
  require('node:fs').rmSync(r, { recursive: true, force: true });
  process.env.OVERLYX_DATA_DIR = require('node:path').join(r, 'data');
  process.env.OVERLYX_PROJECTS_DIR = require('node:path').join(r, 'projects');
  process.env.OVERLYX_GOOGLE_FONTS = 'off';
  return r;
});
const express = (await import('express')).default;
const { config } = await import('../packages/server/src/config.ts');
const { createUser } = await import('../packages/server/src/auth.ts');
const { userSettings, setUserSettings, MY_FONTS_MAX } = await import('../packages/server/src/userSettings.ts');
const { myFontRoutes } = await import('../packages/server/src/myfonts.ts');

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const uid = createUser('fonts', 'Fonts', 'pw').id;
let as: Record<string, unknown> = { id: uid };
const app = express();
app.use((req, _res, next) => { req.user = { username: 'fonts', name: 'Fonts', color: '#000', isAdmin: false, ...as } as never; next(); });
app.use('/api', myFontRoutes());
const server = http.createServer(app);
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
afterAll(() => server.close());
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/fonts/mine`;
const put = (fonts: unknown) => fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fonts }) });

describe('My fonts', () => {
  it('uses the scratch data directory', () => { expect(config.dataDir.startsWith(ROOT)).toBe(true); });

  it('keeps valid family names once each, in their order, at most MY_FONTS_MAX', () => {
    expect(userSettings(uid).fonts).toEqual([]);
    expect(setUserSettings(uid, { fonts: ['Inter', ' Lora ', 'inter', 'bad/name', 3, ''] as never }).fonts).toEqual(['Inter', 'Lora']);
    expect(userSettings(uid).paragraphSkip).toBe(false);
    expect(setUserSettings(uid, { fonts: Array.from({ length: 300 }, (_, i) => `Font ${i}`) }).fonts).toHaveLength(MY_FONTS_MAX);
    expect(setUserSettings(uid, { paragraphSkip: true }).fonts).toHaveLength(MY_FONTS_MAX);
  });

  it('GET and PUT /api/fonts/mine', async () => {
    as = { id: uid };
    const r = await put(['Roboto Slab', 'Inter']);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ fonts: ['Roboto Slab', 'Inter'] });
    expect(await (await fetch(url)).json()).toEqual({ fonts: ['Roboto Slab', 'Inter'] });
    expect((await put('Inter')).status).toBe(400);
  });

  it('guests and read-only sign-ins cannot change them', async () => {
    as = { id: uid, scope: { projects: null, readonly: true } };
    expect((await put([])).status).toBe(403);
    as = { id: uid, guest: true };
    expect((await put([])).status).toBe(403);
    expect(await (await fetch(url)).json()).toEqual({ fonts: [] });
    as = { id: uid };
    expect(await (await fetch(url)).json()).toEqual({ fonts: ['Roboto Slab', 'Inter'] });
  });
});

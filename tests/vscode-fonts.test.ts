/**
 * Google fonts in the VS Code editors (vscode host/fonts.ts): the bridge asks the server's git API
 * with the sign-in, keeps what it got — font files for good, the rest a day — answers from that when
 * the server is away, and fetches My fonts' files as soon as the list is read.
 */
import { describe, it, expect, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fontService } from '../packages/vscode/src/host/fonts.ts';

const dir = fs.mkdtempSync(path.join(process.env.OVERLYX_SCRATCH ?? os.tmpdir(), 'overlyx-vscode-fonts-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const asked: string[] = [];
let mine = ['Inter'];
let down = false;
const server = http.createServer((req, res) => {
  const u = new URL(req.url!, 'http://x');
  asked.push(`${req.method} ${u.pathname}${u.search}`);
  if (down || req.headers.authorization !== 'Basic dGVzdA==') { res.statusCode = down ? 502 : 401; res.end(); return; }
  const p = u.pathname.replace('/git/api/fonts/', '');
  if (p === 'catalog') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ axisNames: {}, families: [{ f: 'Inter' }] })); return; }
  if (p === 'google.css') { res.end(`@font-face { font-family: "Inter"; src: url(google/inter/inter-var.ttf) format('truetype'); }`); return; }
  if (p === 'google/inter/inter-var.ttf') { res.end(Buffer.from([0, 1, 0, 0])); return; }
  if (p === 'mine') {
    if (req.method === 'PUT') { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { mine = JSON.parse(b).fonts; res.end(JSON.stringify({ fonts: mine })); }); return; }
    res.end(JSON.stringify({ fonts: mine })); return;
  }
  res.statusCode = 404; res.end();
});
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
afterAll(() => server.close());
const host = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const fonts = fontService(dir, async () => ({ host, authorization: 'Basic dGVzdA==' }));
const text = (r: { body: Buffer | string }) => r.body.toString();

describe('the bridge\'s fonts', () => {
  it('passes the stylesheet on, its files relative to it, and keeps the files', async () => {
    const css = await fonts('GET', 'google.css', '?family=Inter');
    expect(css.status).toBe(200);
    expect(text(css)).toContain('url(google/inter/inter-var.ttf)');
    const file = await fonts('GET', 'google/inter/inter-var.ttf', '');
    expect(file).toMatchObject({ status: 200, type: 'font/ttf' });
    expect(fs.existsSync(path.join(dir, 'files/inter/inter-var.ttf'))).toBe(true);
  });

  it('answers from what it kept while the server is away', async () => {
    down = true;
    try {
      expect(text(await fonts('GET', 'google/inter/inter-var.ttf', ''))).toBe('\0\u0001\0\0');
      expect(text(await fonts('GET', 'google.css', '?family=Inter'))).toContain('inter-var.ttf');
      expect((await fonts('GET', 'google/inter/other.ttf', '')).status).toBe(404);
    } finally { down = false; }
  });

  it('reads and changes My fonts, fetching their files', async () => {
    fs.rmSync(path.join(dir, 'files'), { recursive: true, force: true });
    fs.rmSync(path.join(dir, 'css'), { recursive: true, force: true });
    expect(JSON.parse(text(await fonts('GET', 'mine', '')))).toEqual({ fonts: ['Inter'] });
    for (let i = 0; i < 50 && !fs.existsSync(path.join(dir, 'files/inter/inter-var.ttf')); i++) await new Promise(r => setTimeout(r, 20));
    expect(fs.existsSync(path.join(dir, 'files/inter/inter-var.ttf'))).toBe(true);
    expect(JSON.parse(text(await fonts('PUT', 'mine', '', { fonts: ['Inter', 'Lora'] })))).toEqual({ fonts: ['Inter', 'Lora'] });
    expect(mine).toEqual(['Inter', 'Lora']);
  });

  it('signed in nowhere: the catalogue says so', async () => {
    const none = fontService(dir, async () => null);
    expect(JSON.parse(text(await none('GET', 'catalog', '')))).toMatchObject({ families: [], signin: true });
    expect((await none('GET', 'mine', '')).status).toBe(401);
  });
});

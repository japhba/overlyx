import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import zlib from 'node:zlib';
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { boxedFetch, fetchBoxAvailable, fetchCommand, FETCH_UID } from '../packages/server/src/fetchbox.ts';
import { guardedFetch, setResolver } from '../packages/server/src/netguard.ts';

const haveBwrap = process.platform === 'linux' && ['/usr/bin/bwrap', '/usr/local/bin/bwrap'].some(existsSync);
// as root the fetcher is FETCH_UID, which deploy/overlyx-fetch.nft keeps off 127.0.0.1: the
// round trips to the local test server run as an ordinary user
const roundTrips = haveBwrap && process.getuid?.() !== 0;

const text = 'Attention is all you need. '.repeat(200);
let server: http.Server;
let port = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/br') { res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'br' }); res.end(zlib.brotliCompressSync(text)); }
    else if (req.url === '/gzip') { res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' }); res.end(zlib.gzipSync(text)); }
    else if (req.url === '/moved') { res.writeHead(302, { location: '/br' }); res.end(); }
    else if (req.url === '/big') { res.writeHead(200); res.end(Buffer.alloc(5000, 97)); }
    else if (req.url === '/echo') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ host: req.headers.host, ua: req.headers['user-agent'] })); }
    else if (req.url === '/slow') { /* never answers */ }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => { server.closeAllConnections(); server.close(); });

const at = (p: string, host = 'paper.test') => new URL(`http://${host}:${port}${p}`);

describe('the fetch sandbox (fetchbox.ts)', () => {
  it.skipIf(!haveBwrap)('runs node in bubblewrap with no files of the server, no environment, and as root an uid of its own', () => {
    const { cmd, args } = fetchCommand();
    const all = [cmd, ...args];
    const b = all.slice(all.indexOf('bwrap') + 1, all.indexOf('--', all.indexOf('bwrap')));
    for (const f of ['--unshare-all', '--unshare-user', '--share-net', '--disable-userns', '--clearenv', '--die-with-parent']) expect(b).toContain(f);
    expect(b.slice(b.indexOf('--cap-drop'), b.indexOf('--cap-drop') + 2)).toEqual(['--cap-drop', 'ALL']);
    // only system directories, read-only
    const bound = b.flatMap((x, i) => (x === '--ro-bind' || x === '--bind' ? [b[i + 1]] : []));
    expect(b).not.toContain('--bind');
    for (const d of bound) expect(d).toMatch(/^\/(usr|lib|lib64|lib32|bin|etc\/ld\.so\.cache)$/);
    if (process.getuid?.() === 0) expect(all.slice(0, 4)).toEqual(['setpriv', `--reuid=${FETCH_UID}`, `--regid=${FETCH_UID}`, '--clear-groups']);
    else expect(cmd).toBe('bwrap');
  });

  it.skipIf(!roundTrips)('decodes Brotli and gzip answers inside the sandbox', async () => {
    expect(fetchBoxAvailable()).toBe(true);
    for (const p of ['/br', '/gzip']) {
      const r = await boxedFetch(at(p), {}, ['127.0.0.1']);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toBe('text/plain');
      expect(await r.text()).toBe(text);
      expect(r.url).toBe(at(p).href);
    }
  });

  it.skipIf(!roundTrips)('connects to the checked address and never resolves the name itself', async () => {
    const r = await boxedFetch(at('/echo', 'does-not-resolve.invalid'), {}, ['127.0.0.1'], undefined, { headers: { 'user-agent': 'OverLyX test' } });
    expect(await r.json()).toEqual({ host: `does-not-resolve.invalid:${port}`, ua: 'OverLyX test' });
  });

  it.skipIf(!roundTrips)('hands a redirect back instead of following it', async () => {
    const r = await boxedFetch(at('/moved'), {}, ['127.0.0.1']);
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/br');
  });

  it.skipIf(!roundTrips)('cuts a body one byte past maxBytes', async () => {
    const r = await boxedFetch(at('/big'), {}, ['127.0.0.1'], 1000);
    expect((await r.arrayBuffer()).byteLength).toBe(1001);
  });

  it.skipIf(!roundTrips)('gives up when the signal says so, and fails like fetch() when nothing answers', async () => {
    await expect(boxedFetch(at('/slow'), { signal: AbortSignal.timeout(1500) }, ['127.0.0.1'])).rejects.toThrow();
    const closed = http.createServer();
    await new Promise<void>(r => closed.listen(0, '127.0.0.1', r));
    const gone = (closed.address() as AddressInfo).port;
    await new Promise<void>(r => closed.close(() => r()));
    await expect(boxedFetch(new URL(`http://paper.test:${gone}/`), {}, ['127.0.0.1'])).rejects.toThrow(TypeError);
  });

  it('calls a stand-in fetch that is not marked as going to the network, and checks every hop', async () => {
    setResolver(async host => (host === 'intranet.example' ? ['10.1.2.3'] : ['93.184.216.34']));
    const seen: string[] = [];
    const standIn = (async (input: any) => {
      seen.push(String(input));
      return String(input).endsWith('/start') ? new Response(null, { status: 302, headers: { location: 'http://intranet.example/secret' } }) : new Response('ok');
    }) as typeof fetch;
    await expect(guardedFetch('https://public.example/start', {}, standIn)).rejects.toThrow(/refused to fetch http:\/\/intranet\.example/);
    expect(seen).toEqual(['https://public.example/start']);
  });
});

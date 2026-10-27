/**
 * A URL that came from a user (netguard.ts) is fetched by a throwaway process in a sandbox of its
 * own, never by the server itself: the HTTP parser, TLS and the decoders (gzip, Brotli, zstd) read
 * whatever a stranger's server sends, and a crafted answer is where such a parser runs code —
 * CVE-2026-111497, an out-of-bounds write in Node's Brotli decoder (October 2026). In the server
 * that code would run as root, with every project, the database and the secrets in reach.
 *
 * The process is `node` running FETCHER (below) in bubblewrap — as root, under uid FETCH_UID (its
 * own, no entry in /etc/passwd, like the agent uids): no files but the system's libraries, an empty
 * environment, its own user, PID, IPC and UTS namespaces, no capabilities. It shares the host's
 * network to reach the internet; `deploy/overlyx-fetch.nft` refuses that uid every loopback,
 * private and link-local address (this server's ports, Caddy's admin API, the cloud's metadata
 * service). It connects only to the addresses netguard checked — it resolves no name itself, so a
 * name that resolves differently by the time of the request (DNS rebinding) cannot point it
 * inward — follows no redirect, and hands back the status, the headers and the decoded body: at
 * most `maxBytes` + 1 bytes, so a caller's own limit notices an answer that was cut. What it hands
 * back is read as untrusted data (a process that was taken over can say anything a server could).
 *
 * Without bubblewrap (macOS, OVERLYX_SANDBOX=none) netguard fetches in-process, as before.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import { sandboxAvailable } from './sandbox.ts';

/** The fetching process's uid when the server is root: just below the agents' (agentusers.ts AGENT_ID_BASE); deploy/overlyx-fetch.nft names it. */
export const FETCH_UID = 2_099_999;
/** the most a fetch hands back unless the caller says less: the largest PDF pdffetch.ts takes */
export const FETCH_MAX_BYTES = 64 * 1024 * 1024;
/** how long a fetch may take when neither the caller nor its fetch's defaults say */
const DEFAULT_TIMEOUT_MS = 60_000;
/** the sandboxed process gives up by itself after this, whatever the caller's signal */
const HARD_TIMEOUT_MS = 120_000;
const ACCEPT_ENCODING = typeof (zlib as { createZstdDecompress?: unknown }).createZstdDecompress === 'function' ? 'gzip, deflate, br, zstd' : 'gzip, deflate, br';

/** What a fetch that goes to the network adds to every request (netguard.ts networkFetch): a user agent, a timeout. */
export interface NetworkDefaults { headers?: Record<string, string>; timeoutMs?: number }

/**
 * The sandboxed process: one request from stdin (JSON), the answer on stdout — a JSON line
 * (status, status text, raw header pairs; or `error`), then the decoded body. Plain JavaScript
 * for `node --eval` (no file to bind in, nothing of the checkout to read).
 */
const FETCHER = String.raw`
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
const input = [];
for await (const c of process.stdin) input.push(c);
const q = JSON.parse(Buffer.concat(input).toString('utf8'));
let done = false;
const finish = (meta, body) => {
  if (done) return;
  done = true;
  process.stdout.write(JSON.stringify(meta) + '\n');
  if (body && body.length) process.stdout.write(body);
  process.stdout.end(() => process.exit(0));
};
const fail = (e) => finish({ error: String((e && (e.code || e.message)) || e) });
setTimeout(() => fail('timed out'), q.timeoutMs).unref();
const url = new URL(q.url);
const lookup = (_host, opts, cb) => (opts && opts.all) ? cb(null, q.addresses) : cb(null, q.addresses[0].address, q.addresses[0].family);
const decoders = { gzip: () => zlib.createGunzip(), 'x-gzip': () => zlib.createGunzip(), deflate: () => zlib.createInflate(), br: () => zlib.createBrotliDecompress() };
if (zlib.createZstdDecompress) decoders.zstd = () => zlib.createZstdDecompress();
const meta = (res) => {
  const headers = [];
  for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) headers.push([res.rawHeaders[i], res.rawHeaders[i + 1]]);
  return { status: res.statusCode, statusText: res.statusMessage || '', headers };
};
const req = (url.protocol === 'https:' ? https : http).request(url, { method: q.method, headers: q.headers, lookup, agent: false }, (res) => {
  // decoded here, in the sandbox; a coding nobody knows stays as it came (as fetch() leaves it)
  const codings = String(res.headers['content-encoding'] || '').split(',').map(s => s.trim().toLowerCase()).filter(s => s && s !== 'identity').reverse();
  const chain = [res];
  if (codings.every(c => decoders[c])) for (const c of codings) chain.push(chain[chain.length - 1].pipe(decoders[c]()));
  for (const s of chain) s.on('error', fail);
  const chunks = [];
  let n = 0;
  chain[chain.length - 1].on('data', (c) => {
    if (done) return;
    chunks.push(c);
    n += c.length;
    if (n > q.maxBytes) { finish(meta(res), Buffer.concat(chunks).subarray(0, q.maxBytes + 1)); res.destroy(); }
  });
  chain[chain.length - 1].on('end', () => finish(meta(res), Buffer.concat(chunks)));
});
req.on('error', fail);
req.end();
`;

let available: boolean | null = null;

/** Whether user URLs are fetched in the sandbox (decided once; as root, warns once when its firewall is not loaded). */
export function fetchBoxAvailable(): boolean {
  if (available === null) {
    try { available = sandboxAvailable(); } catch { available = false; }
    if (available && process.getuid?.() === 0 && spawnSync('nft', ['list', 'table', 'inet', 'overlyx_fetch'], { stdio: 'ignore', timeout: 5000 }).status !== 0) {
      console.warn('[fetchbox] the firewall table inet overlyx_fetch is not loaded (deploy/overlyx-fetch.nft): fetches of user URLs can reach this machine\'s own services');
    }
  }
  return available;
}

/** The command line of the sandboxed fetcher (exported for the tests). */
export function fetchCommand(): { cmd: string; args: string[] } {
  const node = process.execPath;
  const b = ['bwrap'];
  const ro = ['/usr', '/lib', '/lib64', '/lib32', '/bin', '/etc/ld.so.cache'];
  if (!node.startsWith('/usr/')) ro.push(path.dirname(node));
  for (const d of ro) if (fs.existsSync(d)) b.push('--ro-bind', d, d);
  b.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    '--unshare-all', '--unshare-user', '--share-net', '--disable-userns', '--cap-drop', 'ALL', '--die-with-parent', '--new-session',
    '--clearenv', '--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'HOME', '/tmp', '--setenv', 'LANG', 'C.UTF-8',
    '--', node, '--max-old-space-size=256', '--input-type=module', '--eval', FETCHER);
  // as root, an unprivileged uid of its own first (bwrap then gets its user namespace through the
  // overlyx-bwrap AppArmor profile, deploy/apparmor-overlyx-userns)
  const all = process.getuid?.() === 0 ? ['setpriv', `--reuid=${FETCH_UID}`, `--regid=${FETCH_UID}`, '--clear-groups', '--', ...b] : b;
  return { cmd: all[0], args: all.slice(1) };
}

const lower = (h: HeadersInit | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  new Headers(h).forEach((v, k) => { out[k] = v; });
  return out;
};
const reason = (s: unknown) => (typeof s === 'string' && /^[\t\x20-\x7e]*$/.test(s) ? s : '');

/** The sandboxed process's answer as a Response (throws on its `error`, or on anything malformed). */
function toResponse(raw: Buffer, u: URL, method: string): Response {
  const nl = raw.indexOf(10);
  if (nl < 0) throw new Error('no answer');
  const meta = JSON.parse(raw.subarray(0, nl).toString('utf8'));
  if (meta.error) throw new Error(String(meta.error));
  const headers = new Headers();
  for (const [k, v] of Array.isArray(meta.headers) ? meta.headers : []) {
    try { headers.append(String(k), String(v)); } catch { /* a header fetch() would refuse too */ }
  }
  const empty = method === 'HEAD' || [204, 205, 304].includes(meta.status);
  const r = new Response(empty ? null : raw.subarray(nl + 1), { status: meta.status, statusText: reason(meta.statusText), headers });
  Object.defineProperty(r, 'url', { value: u.href });
  return r;
}

/**
 * One request (GET or HEAD, no redirect followed) to `u` in the sandbox, connecting to one of
 * `addresses` (checked by netguard). Rejects like fetch(): with the signal's reason when it is
 * aborted, a TypeError when nothing usable came back.
 */
export async function boxedFetch(u: URL, init: RequestInit, addresses: string[], maxBytes = FETCH_MAX_BYTES, defaults: NetworkDefaults = {}): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase();
  if (init.body != null || (method !== 'GET' && method !== 'HEAD')) throw new Error('the fetch sandbox sends GET and HEAD requests only');
  if (!addresses.length) throw new TypeError('fetch failed: no address');
  const headers = { 'user-agent': 'node', 'accept-encoding': ACCEPT_ENCODING, ...lower(defaults.headers), ...lower(init.headers) };
  const signal = init.signal ?? AbortSignal.timeout(defaults.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  signal.throwIfAborted();
  const request = JSON.stringify({
    url: u.href, method, headers, timeoutMs: HARD_TIMEOUT_MS, maxBytes,
    addresses: addresses.map(a => ({ address: a, family: net.isIPv6(a) ? 6 : 4 })),
  });
  const { cmd, args } = fetchCommand();
  return new Promise<Response>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' } });
    const out: Buffer[] = [];
    // the body, one byte more, and room for the status line and headers
    const cap = maxBytes + 1 + 1024 * 1024;
    let n = 0;
    let err = '';
    const onAbort = () => { child.kill('SIGKILL'); reject(signal.reason); };
    signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (c: Buffer) => {
      n += c.length;
      if (n > cap) { child.kill('SIGKILL'); return; }
      out.push(c);
    });
    child.stderr.on('data', (c: Buffer) => { if (err.length < 4000) err += c.toString(); });
    child.stdin.on('error', () => { /* it ended first: 'close' says why */ });
    child.on('error', e => { signal.removeEventListener('abort', onAbort); reject(e); });
    child.on('close', () => {
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) return;
      try { resolve(toResponse(Buffer.concat(out), u, method)); }
      catch (e) {
        const why = err.trim().split('\n').pop();
        reject(new TypeError(`fetch failed: ${(e as Error).message}${why ? ` (${why})` : ''}`));
      }
    });
    child.stdin.end(request);
  });
}

/**
 * Fetching a URL that came from a user (a bibliography entry's url, a deck's CDN link): only hosts
 * on the public internet, and every redirect checked again — never the server's own ports, the
 * cloud's metadata address or the local network (server-side request forgery). A redirect is
 * followed by hand (at most a few), each hop resolved and checked before it is fetched — by the
 * sandboxed fetcher (fetchbox.ts), which connects to exactly the addresses checked here and keeps
 * the parsing and decoding of the answer out of the server.
 */
import dns from 'node:dns';
import net from 'node:net';
import { boxedFetch, fetchBoxAvailable, FETCH_MAX_BYTES, type NetworkDefaults } from './fetchbox.ts';

const v4 = (ip: string): number[] => ip.split('.').map(Number);

/** loopback, private, link-local, carrier-grade NAT, multicast, reserved, unspecified (v4 and v6) */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = v4(ip);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 192 && b === 0 && v4(ip)[2] === 0) || (a === 198 && (b === 18 || b === 19));
  }
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase();
    // an IPv4 address inside (mapped, NAT64): judged as that one
    const m = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (m) return isPrivateAddress(m[1]);
    if (s === '::' || s === '::1') return true;
    const first = parseInt(s.split(':')[0] || '0', 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00 || s.startsWith('::ffff:');
  }
  return true;
}

let resolver = async (host: string): Promise<string[]> => (await dns.promises.lookup(host, { all: true, verbatim: true })).map(a => a.address);
/** (tests) how host names resolve */
export function setResolver(f: (host: string) => Promise<string[]>): void { resolver = f; }

/** The addresses of the URL's host when it is a public one (http or https only); null when it is not. */
export async function publicAddresses(u: URL): Promise<string[] | null> {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host || /^localhost$/i.test(host) || /\.localhost$/i.test(host)) return null;
  if (net.isIP(host)) return isPrivateAddress(host) ? null : [host];
  let ips: string[];
  try { ips = await resolver(host); } catch { return null; }
  return ips.length > 0 && ips.every(ip => !isPrivateAddress(ip)) ? ips : null;
}

/** Whether the URL's host is a public one (http or https only). */
export async function isPublicUrl(u: URL): Promise<boolean> { return (await publicAddresses(u)) !== null; }

const network = new WeakMap<object, NetworkDefaults>();
/**
 * Mark `f` as a fetch that goes to the network (bibsearch.ts's fetchImpl; the global fetch is one
 * too): guardedFetch then sends the request to the sandboxed fetcher with `defaults` instead of
 * calling `f`. A stand-in a test installs is not marked, and is called as it is.
 */
export function networkFetch<F extends typeof fetch>(f: F, defaults: NetworkDefaults = {}): F {
  network.set(f, defaults);
  return f;
}

/**
 * fetch(), refusing hosts that are not public (and those `allow` refuses) at the start and after
 * every redirect. Throws when a hop is refused or there are too many. `maxBytes`: the sandboxed
 * fetcher hands back at most one byte more of a body (default FETCH_MAX_BYTES).
 */
export async function guardedFetch(url: string | URL, init: RequestInit, fetcher: typeof fetch = fetch, opts: { maxHops?: number; allow?: (u: URL) => boolean; maxBytes?: number } = {}): Promise<Response> {
  let u = new URL(url);
  const hops = opts.maxHops ?? 5;
  const defaults = fetcher === globalThis.fetch ? {} : network.get(fetcher);
  const boxed = defaults !== undefined && fetchBoxAvailable();
  for (let hop = 0; hop <= hops; hop++) {
    const addresses = opts.allow && !opts.allow(u) ? null : await publicAddresses(u);
    if (!addresses) throw new Error(`refused to fetch ${u.protocol}//${u.host}`);
    const r = boxed ? await boxedFetch(u, init, addresses, opts.maxBytes ?? FETCH_MAX_BYTES, defaults) : await fetcher(u.href, { ...init, redirect: 'manual' });
    const loc = r.status >= 300 && r.status < 400 ? r.headers.get('location') : null;
    if (!loc) return r;
    try { await r.body?.cancel(); } catch { /* nothing to drain */ }
    u = new URL(loc, u);
  }
  throw new Error('too many redirects');
}

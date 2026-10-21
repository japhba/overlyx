// LessWrong's OAuth as ForumMagnum serves it (app/oauth/*): registration, a consent page whose form
// POSTs, Allow answered with a 307 (Next.js NextResponse.redirect's default), PKCE + resource
// checked at the token exchange. For scratch/lw-connect-probe.mts. Usage: node scratch/lw-oauth-fake.mjs 3005
import http from 'node:http';
import crypto from 'node:crypto';
const port = Number(process.argv[2] ?? 3005), base = `http://localhost:${port}`;
const clients = new Map(), codes = new Map();
const body = req => new Promise(r => { let b = ''; req.on('data', c => (b += c)); req.on('end', () => r(b)); });
http.createServer(async (req, res) => {
  const u = new URL(req.url, base);
  const send = (status, type, text, headers = {}) => { res.writeHead(status, { 'content-type': type, ...headers }); res.end(text); };
  console.log(req.method, u.pathname);
  if (req.method === 'POST' && u.pathname === '/oauth/register') {
    const b = JSON.parse(await body(req));
    const id = 'client' + clients.size, secret = crypto.randomBytes(8).toString('hex');
    clients.set(id, { secret, redirectUris: b.redirect_uris });
    return send(201, 'application/json', JSON.stringify({ client_id: id, client_secret: secret, redirect_uris: b.redirect_uris }));
  }
  if (req.method === 'GET' && u.pathname === '/oauth/authorize') {
    const q = u.searchParams, c = clients.get(q.get('client_id'));
    if (!c) return send(400, 'text/html', 'Unknown client');
    if (!c.redirectUris.includes(q.get('redirect_uri'))) return send(400, 'text/html', 'Invalid redirect_uri');
    if (!q.get('code_challenge') || q.get('code_challenge_method') !== 'S256') return send(400, 'text/html', 'PKCE with S256 is required');
    const hidden = [...q].map(([k, v]) => `<input type="hidden" name="${k}" value="${v.replace(/"/g, '&quot;')}">`).join('');
    return send(200, 'text/html', `<h1>Authorize OverLyX</h1><form method="POST" action="/oauth/authorize">${hidden}<button name="decision" value="allow">Allow</button><button name="decision" value="deny">Deny</button></form>`);
  }
  if (req.method === 'POST' && u.pathname === '/oauth/authorize') {
    const f = new URLSearchParams(await body(req));
    const back = new URL(f.get('redirect_uri'));
    if (f.get('decision') !== 'allow') { back.searchParams.set('error', 'access_denied'); back.searchParams.set('state', f.get('state')); return send(302, 'text/plain', '', { location: back.toString() }); }
    const code = crypto.randomBytes(8).toString('hex');
    codes.set(code, { challenge: f.get('code_challenge'), clientId: f.get('client_id'), redirectUri: f.get('redirect_uri'), resource: f.get('resource') });
    back.searchParams.set('code', code); back.searchParams.set('state', f.get('state'));
    return send(307, 'text/plain', '', { location: back.toString() });   // NextResponse.redirect: 307
  }
  if (req.method === 'POST' && u.pathname === '/oauth/token') {
    const f = new URLSearchParams(await body(req)), c = codes.get(f.get('code'));
    const bad = d => send(400, 'application/json', JSON.stringify({ error: 'invalid_grant', error_description: d }));
    if (!c) return bad('unknown code');
    if (clients.get(f.get('client_id'))?.secret !== f.get('client_secret')) return bad('client authentication failed');
    if (f.get('redirect_uri') !== c.redirectUri) return bad('redirect_uri mismatch');
    if (crypto.createHash('sha256').update(f.get('code_verifier')).digest('base64url') !== c.challenge) return bad('PKCE verification failed');
    if (c.resource && f.get('resource') !== c.resource) return bad('resource mismatch');
    codes.delete(f.get('code'));
    return send(200, 'application/json', JSON.stringify({ access_token: 'tok-' + crypto.randomBytes(6).toString('hex'), token_type: 'Bearer', expires_in: 7776000, scope: 'lesswrong:access' }));
  }
  send(404, 'text/plain', 'not here');
}).listen(port, () => console.log('fake LessWrong OAuth on ' + base));

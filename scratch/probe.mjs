/**
 * Latency probe: two idle connections in their own process; A inserts a character every 200 ms,
 * B measures when it arrives (server round trip only — no other work in this process). Run it next
 * to scratch/stress.mjs to see the server's latency under load.
 *   BASE=http://127.0.0.1:3011 CREDS=… DOC=recurrent_feature/small.lyx DURATION=20 npx tsx scratch/probe.mjs
 */
import fs from 'node:fs';
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3011';
const CREDS = process.env.CREDS ?? '/tmp/claude-0/-root-lyx/8ebcee3e-6b5f-4e44-823e-783414ef012b/scratchpad/stress/data/credentials.txt';
const DOC = process.env.DOC ?? 'recurrent_feature/small.lyx';
const DURATION = Number(process.env.DURATION ?? 20);
const pw = fs.readFileSync(CREDS, 'utf8').split('\n').filter(l => l.startsWith('admin\t')).pop().split('\t')[1];
const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: pw }) });
const cookie = r.headers.get('set-cookie').split(';')[0];

function client() {
  const ydoc = new Y.Doc();
  const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws?doc=' + encodeURIComponent(DOC), { headers: { cookie } });
  ws.binaryType = 'arraybuffer';
  const synced = new Promise((resolve) => {
    ws.on('open', () => { const e = encoding.createEncoder(); encoding.writeVarUint(e, 0); syncProtocol.writeSyncStep1(e, ydoc); ws.send(encoding.toUint8Array(e)); });
    ws.on('message', (data) => {
      const dec = decoding.createDecoder(new Uint8Array(data)); const type = decoding.readVarUint(dec);
      if (type !== 0) return;
      const mt = decoding.peekVarUint(dec); const enc = encoding.createEncoder(); encoding.writeVarUint(enc, 0);
      syncProtocol.readSyncMessage(dec, enc, ydoc, 'remote'); if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
      if (mt === 1) resolve();
    });
  });
  ydoc.on('update', (u, origin) => { if (origin === 'local' && ws.readyState === WebSocket.OPEN) { const e = encoding.createEncoder(); encoding.writeVarUint(e, 0); syncProtocol.writeUpdate(e, u); ws.send(encoding.toUint8Array(e)); } });
  return { ydoc, ws, synced };
}

const A = client(), B = client();
await Promise.all([A.synced, B.synced]);
// a private paragraph for the probe
let probePar;
A.ydoc.transact(() => { probePar = new Y.XmlElement('paragraph'); probePar.setAttribute('layout', 'Standard'); probePar.setAttribute('depth', 0); const t = new Y.XmlText(); probePar.insert(0, [t]); t.insert(0, 'PROBE-'); A.ydoc.getXmlFragment('prosemirror').insert(0, [probePar]); }, 'local');
const lat = [];
const sent = [];
B.ydoc.on('update', (u, origin) => {
  if (origin !== 'remote') return;
  const now = performance.now();
  const { structs } = Y.decodeUpdate(u);
  for (const s of structs) if (s.id.client === A.ydoc.clientID) { while (sent.length && sent[0].clock <= s.id.clock + s.length) lat.push(now - sent.shift().t); }
});
const t0 = performance.now();
while (performance.now() - t0 < DURATION * 1000) {
  A.ydoc.transact(() => { const t = probePar.toArray()[0]; t.insert(t.length, 'x'); }, 'local');
  sent.push({ clock: Y.getState(A.ydoc.store, A.ydoc.clientID), t: performance.now() });
  await new Promise(r => setTimeout(r, 200));
}
await new Promise(r => setTimeout(r, 1000));
const p = (q) => { const s = [...lat].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]?.toFixed(1); };
console.log(`probe: ${lat.length} samples, server round trip p50 ${p(0.5)} ms, p95 ${p(0.95)} ms, p99 ${p(0.99)} ms, max ${p(1)} ms`);
A.ydoc.transact(() => { const f = A.ydoc.getXmlFragment('prosemirror'); const i = f.toArray().indexOf(probePar); if (i >= 0) f.delete(i, 1); }, 'local');
await new Promise(r => setTimeout(r, 300));
A.ws.close(); B.ws.close();
process.exit(0);

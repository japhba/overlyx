// measures how long the server takes to answer sync step 1 with the full document (sync step 2)
import fs from 'node:fs';
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
const BASE = process.env.BASE ?? 'http://127.0.0.1:3001';
const DOC = process.env.DOC ?? 'recurrent_feature/main.lyx';
const password = fs.readFileSync(process.env.CREDS, 'utf8').trim().split('\n').filter(l => l.startsWith('admin\t')).pop().split('\t')[1];
const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password }) });
const cookie = r.headers.get('set-cookie').split(';')[0];
for (let round = 0; round < 3; round++) {
  const t0 = performance.now();
  const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws?doc=' + encodeURIComponent(DOC), { headers: { cookie } });
  ws.binaryType = 'arraybuffer';
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  const tOpen = performance.now();
  const ydoc = new Y.Doc();
  let tStep1Sent = 0;
  await new Promise((resolve) => {
    ws.on('message', (data) => {
      const dec = decoding.createDecoder(new Uint8Array(data));
      const type = decoding.readVarUint(dec);
      if (type === 2) { decoding.readVarString(dec); return; }
      if (type !== 0) return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      const mt = decoding.peekVarUint(dec);
      if (mt === 0) {
        // server step1 -> answer with our step1 + step2
        const e1 = encoding.createEncoder(); encoding.writeVarUint(e1, 0); syncProtocol.writeSyncStep1(e1, ydoc);
        tStep1Sent = performance.now();
        ws.send(encoding.toUint8Array(e1));
        syncProtocol.readSyncMessage(dec, enc, ydoc, 'x');
        if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
      } else if (mt === 1) {
        const tRecv = performance.now();
        const ta = performance.now();
        syncProtocol.readSyncMessage(dec, enc, ydoc, 'x');
        console.log(`round ${round}: open ${Math.round(tOpen - t0)}ms, step2 after ${Math.round(tRecv - tStep1Sent)}ms, ${data.byteLength} bytes, applyUpdate ${Math.round(performance.now() - ta)}ms`);
        resolve();
      }
    });
  });
  ws.close();
}

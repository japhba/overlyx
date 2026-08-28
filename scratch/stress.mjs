/**
 * Headless multi-user stress harness for OverLyX (run with `npx tsx scratch/stress.mjs`).
 *
 *   BASE=http://127.0.0.1:3011 CREDS=<credentials.txt> PROJECTS=<projects dir> \
 *   N=8 DURATION=20 RATE=6 BURST=40 DOC=recurrent_feature/small.lyx SCENARIO=basic npx tsx scratch/stress.mjs
 *
 * N clients (each logged in as a different user) connect to the same document over the Yjs
 * WebSocket protocol and perform random concurrent edits directly on the 'prosemirror' XmlFragment
 * (text inserts/deletes in random paragraphs, paragraph inserts/deletes, formula edits, awareness
 * cursors). Measures update propagation latency (client -> server -> other clients), server RSS,
 * and checks convergence of all clients, the .lyx file written by the server (parse + round trip)
 * and that a fresh client receives the same state.
 *
 * SCENARIO: basic | reconnect (one client drops mid-burst, edits offline, reconnects) |
 *           external (the .lyx is rewritten on disk while others type) | twodocs (also runs a
 *           second document concurrently and checks no cross-contamination)
 */
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { parseLyx, writeLyx } from '../packages/core/src/index.ts';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const BASE = process.env.BASE ?? 'http://127.0.0.1:3011';
const CREDS = process.env.CREDS ?? '/tmp/claude-0/-root-lyx/8ebcee3e-6b5f-4e44-823e-783414ef012b/scratchpad/stress/data/credentials.txt';
const PROJECTS = process.env.PROJECTS ?? '/tmp/claude-0/-root-lyx/8ebcee3e-6b5f-4e44-823e-783414ef012b/scratchpad/stress/projects';
const N = Number(process.env.N ?? 8);
const DURATION = Number(process.env.DURATION ?? 20);      // seconds of editing
const RATE = Number(process.env.RATE ?? 6);               // ops/s per client (normal typing)
const BURST = Number(process.env.BURST ?? 40);            // ops/s per client during bursts
const DOC = process.env.DOC ?? 'recurrent_feature/small.lyx';
const DOC2 = process.env.DOC2 ?? 'recurrent_feature/main.lyx';
const SCENARIO = process.env.SCENARIO ?? 'basic';
const SEED = Number(process.env.SEED ?? 1);
const SERVER_PID = process.env.SERVER_PID ?? findServerPid();

/* ------------------------------------------------------------------ utils */
let rngState = SEED;
function rnd() { rngState = (rngState * 1664525 + 1013904223) >>> 0; return rngState / 2 ** 32; }
const ri = (n) => Math.floor(rnd() * n);
const pick = (a) => a[ri(a.length)];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'network', 'feature', 'recurrent', 'neuron', 'kernel', 'field', 'theory', 'chaos', 'bayes', 'ünïcödé', '数学', 'x', 'y', 'z', ' ', ' ', ' '];

function findServerPid() {
  try {
    const out = require('node:child_process').execSync(`ss -ltnp | grep ':${new URL(BASE).port} '`, { encoding: 'utf8' });
    const m = /pid=(\d+)/.exec(out);
    return m ? m[1] : null;
  } catch { return null; }
}

function rss() {
  if (!SERVER_PID) return NaN;
  try { const m = /VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${SERVER_PID}/status`, 'utf8')); return m ? Number(m[1]) / 1024 : NaN; } catch { return NaN; }
}

function credentials() {
  const lines = fs.readFileSync(CREDS, 'utf8').split('\n').filter(l => l && !l.startsWith('#'));
  const map = new Map();
  for (const l of lines) { const [u, p] = l.split('\t'); map.set(u, p); }
  return map;
}

async function login(username, password) {
  const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  if (!r.ok) throw new Error('login failed for ' + username + ': ' + r.status);
  return r.headers.get('set-cookie').split(';')[0];
}

function pct(arr, p) { if (!arr.length) return NaN; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; }

/* ------------------------------------------------------------------ latency bookkeeping */
/** clientID -> [{ clock: endClock, t }] (all clients live in this process, so performance.now() is shared) */
const sentAt = new Map();
const latencies = [];
const awarenessLat = [];

/* ------------------------------------------------------------------ client */
class Client {
  constructor(name, cookie, docId) {
    this.name = name; this.cookie = cookie; this.docId = docId;
    this.ydoc = new Y.Doc();
    this.awareness = new awarenessProtocol.Awareness(this.ydoc);
    this.awareness.setLocalStateField('user', { name, color: '#' + ((ri(0xffffff) | 0x404040) >>> 0).toString(16).padStart(6, '0'), username: name });
    this.ws = null; this.synced = false; this.epoch = null; this.saved = 0; this.ops = 0; this.errors = [];
    this.connectedOnce = false;
    this.ydoc.on('update', (update, origin) => {
      if (origin === 'local') {
        const clock = Y.getState(this.ydoc.store, this.ydoc.clientID);
        if (!sentAt.has(this.ydoc.clientID)) sentAt.set(this.ydoc.clientID, { recs: [], next: new Map() });
        sentAt.get(this.ydoc.clientID).recs.push({ clock, t: performance.now() });
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          const enc = encoding.createEncoder(); encoding.writeVarUint(enc, 0); syncProtocol.writeUpdate(enc, update); this.ws.send(encoding.toUint8Array(enc));
        }
      } else if (origin === 'remote') {
        // latency: each struct in the update belongs to a sender; look up when it was sent
        const now = performance.now();
        try {
          const { structs } = Y.decodeUpdate(update);
          const seen = new Map();
          for (const s of structs) { const end = s.id.clock + s.length; if ((seen.get(s.id.client) ?? -1) < end) seen.set(s.id.client, end); }
          for (const [client, end] of seen) {
            const entry = sentAt.get(client); if (!entry) continue;
            // records are in clock order: advance this receiver's cursor over everything now covered
            let i = entry.next.get(this.ydoc.clientID) ?? 0;
            while (i < entry.recs.length && entry.recs[i].clock <= end) { latencies.push(now - entry.recs[i].t); i++; }
            entry.next.set(this.ydoc.clientID, i);
          }
        } catch { /* ignore */ }
      }
    });
    this.awareness.on('update', ({ added, updated, removed }, origin) => {
      if (origin !== 'local') {
        const now = performance.now();
        for (const c of [...added, ...updated]) { const st = this.awareness.getStates().get(c); if (st?.cursor?.t) awarenessLat.push(now - st.cursor.t); }
        return;
      }
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        const enc = encoding.createEncoder(); encoding.writeVarUint(enc, 1);
        encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...added, ...updated, ...removed]));
        this.ws.send(encoding.toUint8Array(enc));
      }
    });
  }

  get fragment() { return this.ydoc.getXmlFragment('prosemirror'); }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws?doc=' + encodeURIComponent(this.docId), { headers: { cookie: this.cookie } });
      ws.binaryType = 'arraybuffer';
      this.ws = ws; this.synced = false;
      const t0 = performance.now();
      ws.on('error', (e) => { this.errors.push('ws error ' + e.message); reject(e); });
      ws.on('close', (code, reason) => { if (code !== 1000 && code !== 1005) this.errors.push(`ws close ${code} ${reason}`); });
      ws.on('open', () => {
        // our sync step 1 (so the server sends us what we miss), plus our awareness
        const e1 = encoding.createEncoder(); encoding.writeVarUint(e1, 0); syncProtocol.writeSyncStep1(e1, this.ydoc); ws.send(encoding.toUint8Array(e1));
        const e2 = encoding.createEncoder(); encoding.writeVarUint(e2, 1); encoding.writeVarUint8Array(e2, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.ydoc.clientID])); ws.send(encoding.toUint8Array(e2));
      });
      ws.on('message', (data) => {
        const dec = decoding.createDecoder(new Uint8Array(data));
        const type = decoding.readVarUint(dec);
        switch (type) {
          case 0: {
            const enc = encoding.createEncoder(); encoding.writeVarUint(enc, 0);
            const mt = decoding.peekVarUint(dec);
            syncProtocol.readSyncMessage(dec, enc, this.ydoc, 'remote');
            if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
            if (mt === 1 && !this.synced) { this.synced = true; this.syncMs = performance.now() - t0; this.connectedOnce = true; resolve(); }
            break;
          }
          case 1: awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(dec), 'remote'); break;
          case 2: { const e = decoding.readVarString(dec); if (this.epoch && this.epoch !== e) this.errors.push('epoch changed'); this.epoch = e; break; }
          case 3: this.saved = decoding.readVarUint(dec); decoding.readVarUint8Array(dec); break;
          default: this.errors.push('unknown message type ' + type);
        }
      });
    });
  }

  disconnect() { if (this.ws) { try { this.ws.close(1000); } catch { /* ignore */ } this.ws = null; } }

  /* ---- random operations on the fragment, always inside a transaction with origin 'local' */
  paragraphs() { return this.fragment.toArray().filter(n => n instanceof Y.XmlElement && n.nodeName === 'paragraph'); }

  textOf(par) { return par.toArray().find(c => c instanceof Y.XmlText) ?? null; }

  /** paragraphs holding check markers are never touched by random edits (so the checks stay meaningful) */
  static protectedPar(par) { return /MARK-|OFFLINE-|EXTERNAL-/.test(par.toString()); }

  randomOp(kind) {
    const pars = this.paragraphs().filter(p => !Client.protectedPar(p));
    if (!pars.length) return;
    const r = kind ?? rnd();
    this.ydoc.transact(() => {
      if (r < 0.55) {            // type some characters into a random paragraph
        const par = pick(pars);
        let txt = this.textOf(par);
        if (!txt) { txt = new Y.XmlText(); par.insert(par.length, [txt]); }
        const s = pick(WORDS) + (rnd() < 0.3 ? ' ' : '');
        const attrs = rnd() < 0.08 ? { [pick(['emph', 'series', 'noun'])]: { value: rnd() < 0.5 ? 'on' : 'bold' } } : undefined;
        txt.insert(ri(txt.length + 1), s, attrs);
      } else if (r < 0.8) {      // delete a few characters
        const par = pick(pars);
        const txt = this.textOf(par);
        if (txt && txt.length > 3) { const from = ri(txt.length - 2); txt.delete(from, 1 + ri(Math.min(4, txt.length - from - 1))); }
      } else if (r < 0.88) {     // new paragraph
        const p = new Y.XmlElement('paragraph');
        p.setAttribute('layout', pick(['Standard', 'Standard', 'Itemize', 'Section']));
        p.setAttribute('depth', 0);
        const t = new Y.XmlText(); p.insert(0, [t]);
        t.insert(0, `Paragraph by ${this.name} #${this.ops} ` + pick(WORDS));
        this.fragment.insert(ri(this.fragment.length + 1), [p]);
      } else if (r < 0.92) {     // delete a paragraph (keep a few)
        if (pars.length > 4) { const p = pick(pars); const idx = this.fragment.toArray().indexOf(p); if (idx >= 0) this.fragment.delete(idx, 1); }
      } else if (r < 0.97) {     // insert / edit an inline formula
        const par = pick(pars);
        const maths = par.toArray().filter(c => c instanceof Y.XmlElement && c.nodeName === 'math_inline');
        if (maths.length && rnd() < 0.6) { const m = pick(maths); m.setAttribute('latex', `$\\alpha_{${ri(9)}}+${pick(['x', 'y', 'z'])}^{${ri(9)}}$`); }
        else { const m = new Y.XmlElement('math_inline'); m.setAttribute('latex', `$x_{${this.name}}^{${this.ops}}$`); m.setAttribute('delim', '$'); m.setAttribute('marks', '[]'); par.insert(ri(par.length + 1), [m]); }
      } else {                   // move the cursor (awareness)
        const par = pick(pars); const txt = this.textOf(par);
        if (txt) { const pos = ri(txt.length + 1); const rel = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(txt, pos)); this.awareness.setLocalStateField('cursor', { anchor: rel, head: rel, t: performance.now() }); }
      }
    }, 'local');
    this.ops++;
  }

  /** a new paragraph with the marker (random edits leave marker paragraphs alone) */
  markerInsert(marker) {
    this.ydoc.transact(() => {
      const p = new Y.XmlElement('paragraph'); p.setAttribute('layout', 'Standard'); p.setAttribute('depth', 0);
      const t = new Y.XmlText(); p.insert(0, [t]); t.insert(0, marker);
      this.fragment.insert(ri(this.fragment.length + 1), [p]);
    }, 'local');
    this.ops++;
  }

  plainText() { return this.paragraphs().map(p => p.toArray().map(c => c instanceof Y.XmlText ? c.toString().replace(/<[^>]+>/g, '') : c instanceof Y.XmlElement ? `[${c.nodeName}:${c.getAttribute('latex') ?? ''}]` : '').join('')).join('\n'); }
}

/* ------------------------------------------------------------------ scenario driver */
async function waitConverged(clients, timeoutMs = 20000) {
  const t0 = performance.now();
  while (performance.now() - t0 < timeoutMs) {
    const svs = clients.map(c => Buffer.from(Y.encodeStateVector(c.ydoc)).toString('hex'));
    if (svs.every(s => s === svs[0])) return true;
    await sleep(100);
  }
  return false;
}

function checkConverged(clients, label) {
  const svs = clients.map(c => Buffer.from(Y.encodeStateVector(c.ydoc)).toString('hex'));
  const json = clients.map(c => JSON.stringify(c.fragment.toJSON()));
  const sameSv = svs.every(s => s === svs[0]);
  const sameJson = json.every(s => s === json[0]);
  if (!sameSv || !sameJson) {
    console.log(`  !! ${label}: NOT converged (state vectors equal: ${sameSv}, content equal: ${sameJson})`);
    for (let i = 0; i < clients.length; i++) if (json[i] !== json[0]) console.log(`     client ${clients[i].name}: ${json[i].length} chars vs ${json[0].length}`);
  }
  return sameSv && sameJson;
}

async function waitSaved(clients, timeoutMs = 15000) {
  // wait until the server reports a save whose state vector covers everything the clients have
  const t0 = performance.now();
  const before = Date.now();
  while (performance.now() - t0 < timeoutMs) {
    if (clients.some(c => c.saved >= before - 3000)) { await sleep(400); return true; }
    await sleep(200);
  }
  return false;
}

function checkFile(docId, markers = []) {
  const file = path.join(PROJECTS, docId);
  const text = fs.readFileSync(file, 'utf8');
  let ok = true;
  try {
    const parsed = parseLyx(text);
    const again = writeLyx(parsed);
    if (again !== text) { ok = false; console.log('  !! file does not round-trip (write(parse(x)) != x)'); fs.writeFileSync(file + '.rt-diff-a', text); fs.writeFileSync(file + '.rt-diff-b', again); }
  } catch (e) { ok = false; console.log('  !! file does not parse: ' + e.message); }
  const missing = markers.filter(m => !text.includes(m));
  if (missing.length) { ok = false; console.log(`  !! ${missing.length}/${markers.length} markers missing from the file`); }
  return { ok, size: text.length };
}

async function runScenario() {
  const creds = credentials();
  const users = [...creds.keys()].filter(u => u !== 'admin');
  const cookies = new Map();
  for (const u of ['admin', ...users]) cookies.set(u, await login(u, creds.get(u)));
  const userFor = (i) => users.length ? users[i % users.length] : 'admin';

  const rss0 = rss();
  console.log(`scenario=${SCENARIO} doc=${DOC} N=${N} duration=${DURATION}s rate=${RATE}/s burst=${BURST}/s server pid=${SERVER_PID} rss=${rss0.toFixed(1)} MB`);

  const clients = [];
  const tConnect = performance.now();
  for (let i = 0; i < N; i++) { const c = new Client(userFor(i), cookies.get(userFor(i)), DOC); clients.push(c); }
  await Promise.all(clients.map(c => c.connect()));
  console.log(`  ${N} clients synced in ${Math.round(performance.now() - tConnect)} ms (sync: ${clients.map(c => Math.round(c.syncMs)).join('/')} ms), ${clients[0].paragraphs().length} paragraphs, users seen by client 0: ${[...clients[0].awareness.getStates().values()].filter(s => s.user).length}`);

  let clients2 = [];
  if (SCENARIO === 'twodocs') {
    for (let i = 0; i < Math.max(2, N >> 1); i++) clients2.push(new Client(userFor(i + 1), cookies.get(userFor(i + 1)), DOC2));
    await Promise.all(clients2.map(c => c.connect()));
    console.log(`  second document ${DOC2}: ${clients2.length} clients, ${clients2[0].paragraphs().length} paragraphs`);
  }

  const markers = [];
  const tStart = performance.now();
  let totalOps = 0;
  const rssSamples = [];
  const offline = SCENARIO === 'reconnect' ? clients[N - 1] : null;
  let offlineMarker = null;
  let externalText = null;

  const loops = [...clients, ...clients2].map(async (c, i) => {
    const phaseLen = 2000 + ri(3000);
    while (performance.now() - tStart < DURATION * 1000) {
      const burst = ((performance.now() - tStart + i * 700) % (phaseLen * 2)) > phaseLen;   // alternate normal typing / bursts
      const rate = burst ? BURST : RATE;
      if (c.ws || c === offline) { try { c.randomOp(); totalOps++; } catch (e) { c.errors.push('op failed: ' + e.message); } }
      await sleep(1000 / rate * (0.5 + rnd()));
    }
  });

  const side = (async () => {
    // markers: every client writes a unique marker once (checked in the file at the end)
    await sleep(DURATION * 300);
    for (const c of clients) { const m = `MARK-${c.name}-${SEED}-${c.ydoc.clientID}`; markers.push(m); c.markerInsert(m); if (process.env.DEBUG) console.log(`  marker ${m} inserted; visible locally: ${c.plainText().includes(m)}`); }
    if (process.env.DEBUG) { await sleep(1000); console.log(`  markers visible in client 0 after 1 s: ${markers.filter(m => clients[0].plainText().includes(m)).length}/${markers.length}`); }
    if (SCENARIO === 'reconnect') {
      await sleep(DURATION * 150);
      console.log(`  client ${offline.name} disconnects and edits offline …`);
      offline.disconnect();
      await sleep(DURATION * 200);
      offlineMarker = `OFFLINE-${offline.name}-${SEED}`; markers.push(offlineMarker); offline.markerInsert(offlineMarker);
      await sleep(DURATION * 150);
      console.log(`  client ${offline.name} reconnects (${Y.getState(offline.ydoc.store, offline.ydoc.clientID)} local ops)`);
      await offline.connect();
    } else if (SCENARIO === 'external') {
      await sleep(DURATION * 200);
      // desktop LyX saves the file: change one paragraph on disk
      await waitSaved(clients, 6000);
      const file = path.join(PROJECTS, DOC);
      const text = fs.readFileSync(file, 'utf8');
      const doc = parseLyx(text);
      externalText = `EXTERNAL-EDIT-${SEED}-${Date.now()}`;
      // rewrite: append a paragraph at the end of the body (a change LyX could have made)
      const idx = text.lastIndexOf('\\end_body');
      const newText = text.slice(0, idx) + `\\begin_layout Standard\n${externalText}\n\\end_layout\n\n` + text.slice(idx);
      void doc;
      fs.writeFileSync(file + '.tmp', newText); fs.renameSync(file + '.tmp', file);
      console.log(`  external change written to ${DOC}`);
    }
  })();

  const saveTimes = new Set();
  const sampler = (async () => { while (performance.now() - tStart < DURATION * 1000) { rssSamples.push(rss()); try { saveTimes.add(fs.statSync(path.join(PROJECTS, DOC)).mtimeMs); } catch { /* being renamed */ } await sleep(500); } })();
  await Promise.all([...loops, side, sampler]);
  const elapsed = (performance.now() - tStart) / 1000;

  // let everything settle
  const conv = await waitConverged(clients, 30000);
  const rssEnd = rss();
  console.log(`  ${totalOps} ops in ${elapsed.toFixed(1)} s = ${(totalOps / elapsed).toFixed(0)} ops/s; latency p50 ${pct(latencies, 0.5).toFixed(1)} ms, p95 ${pct(latencies, 0.95).toFixed(1)} ms, p99 ${pct(latencies, 0.99).toFixed(1)} ms, max ${pct(latencies, 1).toFixed(0)} ms (${latencies.length} samples); awareness p50 ${pct(awarenessLat, 0.5).toFixed(1)} ms p95 ${pct(awarenessLat, 0.95).toFixed(1)} ms`);
  console.log(`  server RSS ${rss0.toFixed(0)} -> ${rssEnd.toFixed(0)} MB (max during run ${Math.max(...rssSamples).toFixed(0)} MB); .lyx written ${Math.max(0, saveTimes.size - 1)}× during the ${DURATION} s of continuous editing`);
  const converged = conv && checkConverged(clients, 'main doc');
  console.log(`  convergence: ${converged ? 'yes' : 'NO'} (${clients[0].paragraphs().length} paragraphs, ${clients[0].plainText().length} chars)`);
  const errors = clients.flatMap(c => c.errors.map(e => c.name + ': ' + e));
  if (errors.length) console.log('  client errors:\n    ' + errors.slice(0, 10).join('\n    '));

  // file on disk
  const savedOk = await waitSaved(clients, 15000);
  const f = checkFile(DOC, markers);
  console.log(`  file saved (server MSG_SAVED): ${savedOk}; file valid & round-trips: ${f.ok} (${f.size} bytes), markers present: ${markers.every(m => fs.readFileSync(path.join(PROJECTS, DOC), 'utf8').includes(m))}`);

  if (externalText) {
    const t0 = performance.now();
    let seen = false;
    while (performance.now() - t0 < 10000) { if (clients.every(c => c.plainText().includes(externalText))) { seen = true; break; } await sleep(200); }
    console.log(`  external change visible in all clients: ${seen}; markers still present in clients: ${markers.every(m => clients[0].plainText().includes(m))}`);
    // the server must not have overwritten the external change with stale content
    const onDisk = fs.readFileSync(path.join(PROJECTS, DOC), 'utf8');
    console.log(`  external change still on disk after the server's next save: ${onDisk.includes(externalText)}`);
  }

  // a fresh client must receive exactly the same state
  const fresh = new Client('admin', cookies.get('admin'), DOC);
  await fresh.connect();
  await waitConverged([clients[0], fresh], 10000);
  const freshOk = JSON.stringify(fresh.fragment.toJSON()) === JSON.stringify(clients[0].fragment.toJSON());
  console.log(`  fresh client gets identical content: ${freshOk} (sync ${Math.round(fresh.syncMs)} ms)`);
  fresh.disconnect();

  // the server's own view (through the .lyx file) must contain the same paragraph texts as the clients
  const parsedDisk = parseLyx(fs.readFileSync(path.join(PROJECTS, DOC), 'utf8'));
  const diskPars = parsedDisk.body.filter(p => p.type === 'paragraph' || p.layout).length;
  console.log(`  paragraphs: clients ${clients[0].paragraphs().length}, file ${diskPars}`);

  let twodocsOk = true;
  if (clients2.length) {
    const conv2 = await waitConverged(clients2, 20000) && checkConverged(clients2, 'second doc');
    const text1 = clients[0].plainText(), text2 = clients2[0].plainText();
    const leak = markers.some(m => text2.includes(m)) || text1.includes('Paragraph by ' + clients2[0].name + ' #') && !clients.some(c => c.name === clients2[0].name);
    const f2 = checkFile(DOC2);
    twodocsOk = conv2 && !leak && f2.ok;
    console.log(`  second doc converged: ${conv2}, cross-contamination: ${leak ? 'YES' : 'no'}, file valid: ${f2.ok}`);
  }

  for (const c of [...clients, ...clients2]) c.disconnect();
  await sleep(300);
  const log = fs.existsSync(path.dirname(CREDS) + '/../server.log') ? fs.readFileSync(path.dirname(CREDS) + '/../server.log', 'utf8') : '';
  const logErrors = log.split('\n').filter(l => /error|Error|failed|exception/i.test(l) && !/ExperimentalWarning/.test(l));
  console.log(`  server log error lines: ${logErrors.length}${logErrors.length ? '\n    ' + logErrors.slice(-5).join('\n    ') : ''}`);
  const ok = converged && f.ok && freshOk && !errors.length && twodocsOk && logErrors.length === 0;
  console.log(`RESULT ${SCENARIO} N=${N}: ${ok ? 'PASS' : 'FAIL'}`);
  process.exit(ok ? 0 : 1);
}

runScenario().catch(e => { console.error(e); process.exit(2); });

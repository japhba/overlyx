/**
 * After each start: the server opens a .tex document, a markdown file, an HTML deck and a whiteboard
 * over its own websocket, as their editors do (core collab/connect.ts) and as a dedicated account,
 * and each must arrive. GET /api/health's `docs` says how it went (scripts/docs-check.sh waits for
 * it after a deploy); a failure is logged for the maintenance worker. For 27 hours (19–20 Oct 2026)
 * no deck or whiteboard opened, and nothing said so: the server held them without a word.
 *
 * On in production (NODE_ENV=production) or with OVERLYX_SELF_CHECK=1; OVERLYX_SELF_CHECK=0 turns it
 * off. The account has no password and its project is of kind 'check' (not mirrored, mirror.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import * as Y from 'yjs';
import { WebSocket } from 'ws';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { connectParams } from '@overlyx/core/collab/connect.ts';
import { BODY } from '@overlyx/core/collab/model.ts';
import { db, type UserRow } from './db.ts';
import { config } from './config.ts';
import { createUser, toSessionUser, signSession } from './auth.ts';
import { registerProject } from './access.ts';

const ACCOUNT = 'overlyx-check';
const PROJECT = `${ACCOUNT}/docs`;
const TIMEOUT_MS = 30000;
const WORDS = 'Deploy check';

/** each document, and what of it must have arrived */
const DOCS: { file: string; text: string; arrived: (d: Y.Doc) => boolean }[] = [
  { file: 'main.tex', text: `\\documentclass{article}\n\\begin{document}\n${WORDS}: a document opens.\n\\end{document}\n`, arrived: d => d.getText(BODY).toString().includes(WORDS) },
  { file: 'notes.md', text: `# ${WORDS}\n\nA markdown file opens.\n`, arrived: d => d.getText(BODY).toString().includes(WORDS) },
  { file: 'deck/index.html', text: `<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<meta name="overlyx" content="deck">\n<title>${WORDS}</title>\n</head>\n<body>\n<section class="slide"><h1>${WORDS}</h1></section>\n</body>\n</html>\n`, arrived: d => d.getText('html').toString().includes(`<h1>${WORDS}</h1>`) },
  { file: 'board.board', text: `{"overlyx":"board","v":1,"objects":{"check":{"kind":"text","text":"${WORDS}"}}}\n`, arrived: d => d.getMap('objects').has('check') },
];

export function selfCheckEnabled(): boolean {
  const v = process.env.OVERLYX_SELF_CHECK;
  return v === undefined ? process.env.NODE_ENV === 'production' : v === '1';
}

export type SelfCheck = { docs: 'off' | 'pending' | 'ok' | 'failed'; detail?: string };
// (pending from the start: a deploy asking before the check has begun must wait for it)
let state: SelfCheck = { docs: selfCheckEnabled() ? 'pending' : 'off' };
export const selfCheckState = (): SelfCheck => state;

/** the account and its project, the documents as they should be */
function prepare(): UserRow {
  let user = db.prepare('SELECT * FROM users WHERE username = ?').get(ACCOUNT) as UserRow | undefined;
  // (a person who chose the name — before this account existed — is not signed in as)
  if (user?.password_hash || user?.email || user?.google_sub) throw new Error(`the account name ${ACCOUNT} belongs to a person`);
  user ??= createUser(ACCOUNT, WORDS, null);
  registerProject(PROJECT, user.id, { title: WORDS, kind: 'check' });
  const dir = path.join(config.projectsDir, ACCOUNT, 'docs');
  for (const d of DOCS) {
    const file = path.join(dir, d.file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let cur: string | null = null;
    try { cur = fs.readFileSync(file, 'utf8'); } catch { /* not yet */ }
    if (cur !== d.text) fs.writeFileSync(file, d.text);
  }
  return user;
}

/** one document opened as its editor opens it: what is missing when it has not arrived */
function open(port: number, cookie: string, doc: (typeof DOCS)[number], timeoutMs: number): Promise<string | null> {
  const id = `${PROJECT}/${doc.file}`;
  const host = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
  const ydoc = new Y.Doc();
  const ws = new WebSocket(`ws://${host}:${port}/ws?${new URLSearchParams(connectParams(id))}`, { headers: { cookie } });
  ws.binaryType = 'arraybuffer';
  return new Promise<string | null>((resolve) => {
    let finished = false;
    const done = (missing: string | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* gone */ }
      ydoc.destroy();
      resolve(missing);
    };
    const timer = setTimeout(() => done(`${doc.file}: nothing arrived within ${timeoutMs / 1000} s`), timeoutMs);
    ws.on('open', () => { const enc = encoding.createEncoder(); encoding.writeVarUint(enc, 0); syncProtocol.writeSyncStep1(enc, ydoc); ws.send(encoding.toUint8Array(enc)); });
    ws.on('message', (data: ArrayBuffer) => {
      const dec = decoding.createDecoder(new Uint8Array(data));
      if (decoding.readVarUint(dec) !== 0) return;
      try {
        if (syncProtocol.readSyncMessage(dec, encoding.createEncoder(), ydoc, 'selfcheck') !== syncProtocol.messageYjsSyncStep2) return;
      } catch (e) { done(`${doc.file}: ${(e as Error).message}`); return; }
      done(doc.arrived(ydoc) ? null : `${doc.file}: synced, but without its text`);
    });
    ws.on('unexpected-response', (_req, res) => done(`${doc.file}: the server answered ${res.statusCode}`));
    ws.on('close', (code) => done(`${doc.file}: the connection closed (${code})`));
    ws.on('error', (e) => done(`${doc.file}: ${e.message}`));
  });
}

/** run once the server listens on `port` */
export async function runSelfCheck(port: number, timeoutMs = TIMEOUT_MS): Promise<SelfCheck> {
  state = { docs: 'pending' };
  try {
    const cookie = `ol_session=${signSession(toSessionUser(prepare()))}`;
    const missing = (await Promise.all(DOCS.map(d => open(port, cookie, d, timeoutMs)))).filter((m): m is string => !!m);
    state = missing.length ? { docs: 'failed', detail: missing.join('; ') } : { docs: 'ok' };
  } catch (e) {
    state = { docs: 'failed', detail: (e as Error).message };
  }
  if (state.docs === 'ok') console.log('[selfcheck] a .tex document, a markdown file, a deck and a whiteboard open');
  else console.error(`[selfcheck] FAILED: documents do not open — ${state.detail}`);
  return state;
}

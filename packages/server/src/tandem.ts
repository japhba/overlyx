/**
 * Tandem (DOCS.md "Tandem: two devices of one account as one"): the screens of one account that have
 * the same project open — an iPad and a laptop — tell each other what they show and hold (the open
 * file, the slide or the place in the text, the drawing tool, presenting). Each screen renders on its
 * own; only that small state travels, and only between the screens of the same account: the room is
 * the signed-in user and the project, so nothing reaches anyone else, and nothing of the project's
 * contents goes through here (the documents travel as always, through their own connections).
 *
 * `GET /api/projects/:project/tandem?c=<screen>&d=<device>&n=<name>` is the screen's stream (server-
 * sent events): `{kind:'peers', peers:[{c,d,n,s}]}` at once, then `{kind:'join',c,d,n}`,
 * `{kind:'state',c,s}` and `{kind:'leave',c}` of the account's other screens in the project.
 * `POST /api/projects/:project/tandem {c, s}` hands this screen's state to them. Kept in memory only;
 * capped (a state of at most STATE_MAX characters, ROOM_MAX screens, POSTS_PER_S states a second).
 * End-to-end encrypted projects have none (the file names are not the server's to know).
 */
import type express from 'express';
import { isE2eProject } from './e2e/store.ts';

interface Screen { c: string; d: string; n: string; res: express.Response; s: string | null; posts: number[] }

const rooms = new Map<string, Map<string, Screen>>();
const STATE_MAX = 4096;
const ROOM_MAX = 8;
const POSTS_PER_S = 25;
const ID = /^[A-Za-z0-9_-]{6,40}$/;

const roomKey = (req: express.Request) => `${req.user!.id}\u0000${String(req.params.project)}`;
// A write to a stream that has ended does not throw: Node emits 'error' on the response a tick later,
// and with no listener that crashed the whole server (ten times, 14–20 Nov — a screen reconnecting
// was ended below and then still sent the "join"). So never write to an ended stream, and every
// stream has an error listener.
const write = (res: express.Response, text: string) => { if (!res.writableEnded && !res.destroyed) res.write(text); };
const send = (to: Screen, data: string) => write(to.res, `data: ${data}\n\n`);
const cleanName = (v: unknown) => String(v ?? '').replace(/[^\p{L}\p{N} ()._-]/gu, '').slice(0, 32) || 'Another screen';

export function mountTandem(api: express.Router, guard: express.RequestHandler): void {
  api.get('/projects/:project/tandem', guard, (req, res) => {
    const c = String(req.query.c ?? ''), d = String(req.query.d ?? '');
    if (req.user!.guest || !ID.test(c) || !ID.test(d) || isE2eProject(String(req.params.project))) { res.status(404).json({ error: 'not found' }); return; }
    const key = roomKey(req);
    let room = rooms.get(key);
    if (!room) rooms.set(key, room = new Map());
    if (room.size >= ROOM_MAX && !room.has(c)) { res.status(429).json({ error: 'Too many screens' }); return; }
    // The same screen connecting again (a reload, a dropped connection): its old stream ends and
    // leaves the room before the others are told, so nothing is sent to it any more.
    const old = room.get(c);
    if (old) { room.delete(c); old.res.end(); }
    res.on('error', () => { /* the client went away; 'close' tidies up */ });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const me: Screen = { c, d, n: cleanName(req.query.n), res, s: null, posts: [] };
    const others = [...room.values()];
    write(res, `data: ${JSON.stringify({ kind: 'peers', peers: others.map(o => ({ c: o.c, d: o.d, n: o.n, s: o.s ? JSON.parse(o.s) : null })) })}\n\n`);
    const hello = JSON.stringify({ kind: 'join', c, d, n: me.n });
    for (const o of others) send(o, hello);
    room.set(c, me);
    const hb = setInterval(() => write(res, ': hb\n\n'), 20000);
    req.on('close', () => {
      clearInterval(hb);
      const r = rooms.get(key);
      if (!r || r.get(c) !== me) return;
      r.delete(c);
      if (!r.size) { rooms.delete(key); return; }
      const bye = JSON.stringify({ kind: 'leave', c });
      for (const o of r.values()) send(o, bye);
    });
  });

  api.post('/projects/:project/tandem', guard, (req, res) => {
    const me = rooms.get(roomKey(req))?.get(String(req.body?.c ?? ''));
    if (!me) { res.status(404).json({ error: 'not connected' }); return; }
    const now = Date.now();
    me.posts = me.posts.filter(t => now - t < 1000);
    if (me.posts.length >= POSTS_PER_S) { res.status(429).json({ error: 'slow down' }); return; }
    me.posts.push(now);
    const s = req.body?.s;
    const text = s && typeof s === 'object' && !Array.isArray(s) ? JSON.stringify(s) : null;
    if (!text || text.length > STATE_MAX) { res.status(400).json({ error: 'bad state' }); return; }
    me.s = text;
    const msg = `{"kind":"state","c":${JSON.stringify(me.c)},"s":${text}}`;
    for (const o of rooms.get(roomKey(req))!.values()) if (o !== me) send(o, msg);
    res.json({ ok: true });
  });
}

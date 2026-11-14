/**
 * Tandem: two devices of one account working as one (DOCS.md "Tandem: two devices of one account as
 * one"). When an iPad and a laptop have the same project open, a chip offers "Tandem with iPad"
 * (app/TandemChip.tsx); with it on on both, each follows what the other does — the file opened, the
 * slide or the place in the text, the drawing tool and the pen's colour and width, presenting — while
 * each renders at its own size and zoom. The documents themselves travel as always (Yjs); this is the
 * interface's state, relayed by the server between the screens of one account in one project only
 * (server tandem.ts: the room is the signed-in user and the project — never anyone else).
 *
 * Who leads when both move: whoever moved last. Each kind of state (the place, the tool, presenting)
 * has a clock — a move made here takes the highest number seen plus one, with this screen's id — and a
 * screen follows the newer move of a screen in tandem. Following is not a move (no echo): a change that
 * only carries out what was followed, or that comes while a followed file or slide settles, or a scroll
 * without this person's hand on this device (a pointer, wheel, touch or key just before), is not
 * counted. A screen that turns tandem on joins: it goes where the screens already in tandem are; the
 * first one on leads. Presenting follows too: when one screen presents, the other presents the same
 * deck, Linked (app/presentshare.ts) — a touch screen with only the drawing tools on the slide
 * (presentkit.ts setInkOnly) and the presenter view one tap away, anything else as a second screen
 * does (presenter view). Leaving the presentation on the screen that followed into it ends it there
 * only.
 *
 * A device has a random id kept in this browser and a readable name from its user agent ("iPad",
 * "Mac"): nothing private. End-to-end encrypted projects have no tandem (their file names are not the
 * server's to know); nor has the VS Code extension (it is no second screen of the web app's sort).
 */
import type { EditorView } from 'prosemirror-view';
import { API_BASE } from '../api';
import { isE2eProject } from '../e2e/known';
import { loadDeckInk, patchDeckInk, saveDeckInk, subscribeDeckInk, type DeckPen } from '../deliverable/deckink';

/** a move's place on a clock: its number and the screen that made it */
type Key = [number, string];

/** the drawing tool in hand and the pen's settings (decks' Draw: deliverable/deckink.ts) */
export interface TandemTool { t?: string; pen?: string; c?: string; w?: number }

/** what one screen tells the account's other screens in the project */
export interface TandemState {
  v: 1;
  /** in tandem (its chip on) */
  on: boolean;
  /** a touch screen (it presents with the drawing tools when following) */
  touch?: 1;
  /** the file shown: the address's id ("<owner>/<project>/<path>", "text:…", "pdf:…"), without "raw:" */
  doc: string | null;
  /** a deck: the slide shown (the editor's index) */
  slide?: number;
  /** a document: the place at the top of the window (the editor's position) */
  top?: number;
  tool?: TandemTool;
  /** presenting the deck shown */
  pres?: 0 | 1;
  /** the clocks of the place (doc, slide, top), the tool, presenting */
  k: { p: Key; t: Key; r: Key };
}

export interface TandemPeer { c: string; d: string; name: string; s: TandemState | null }

/** what the chip shows */
export interface TandemView { project: string | null; on: boolean; name: string; others: { c: string; name: string; on: boolean }[] }

/** a document editor's window (App.tsx) */
export interface TandemText { scroller(): HTMLElement | null; view(): EditorView | null }
/** a deck open in the editor (deliverable/DeliverableEditor.tsx) */
export interface TandemDeck {
  doc: string;
  current(): number;
  goto(slide: number): void;
  tool(): string;
  setTool(t: string): void;
  presenting(): boolean;
  /** start presenting the slide shown, as a screen in tandem does (`inkOnly`: only the drawing tools), or stop */
  present(on: boolean, inkOnly: boolean): void;
}

/* ------------------------------------------------------------------ the device */

const randomId = (n = 12) => {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return Array.from(a, b => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[b % 62]).join('');
};

/** this browser's id (random, kept in it) */
function deviceId(): string {
  try {
    let v = localStorage.getItem('ol.deviceId');
    if (!v || !/^[A-Za-z0-9_-]{6,40}$/.test(v)) localStorage.setItem('ol.deviceId', v = randomId());
    return v;
  } catch { return SCREEN; }
}

/** A readable name for a device from its user agent: "iPad", "iPhone", "Android tablet", "Mac", "Windows PC", … */
export function deviceName(ua: string, touchPoints: number): string {
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)) return 'iPad';
  if (/iPhone|iPod/.test(ua)) return 'iPhone';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
  if (/CrOS/.test(ua)) return 'Chromebook';
  if (/Macintosh|Mac OS X/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/Linux/.test(ua)) return 'Linux PC';
  return 'Computer';
}

/** this page's id among the screens (a second tab of the same browser is a screen of its own, but no tandem partner) */
const SCREEN = randomId();
const nav = typeof navigator !== 'undefined' ? navigator : null;
const DEVICE = typeof localStorage !== 'undefined' ? deviceId() : SCREEN;
const NAME = nav ? deviceName(nav.userAgent, nav.maxTouchPoints ?? 0) : 'Computer';
const TOUCH = !!nav && (nav.maxTouchPoints ?? 0) > 0;

/* ------------------------------------------------------------------ state */

const ZERO: Key = [-1, ''];
const me: TandemState = { v: 1, on: false, doc: null, k: { p: ZERO, t: ZERO, r: ZERO }, ...(TOUCH ? { touch: 1 as const } : {}) };
let project: string | null = null;
let es: EventSource | null = null;
const peers = new Map<string, TandemPeer>();
let maxN = 0;
const subs = new Set<(v: TandemView) => void>();

let text: TandemText | null = null;
let deck: TandemDeck | null = null;

/** what was followed last, per field: a change here to exactly that carries it out (not a move); used once */
const followed: { doc?: string; slide?: number; tool?: string; pres?: boolean } = {};
/** until when a followed file or slide settles here (no move is counted) */
let settleUntil = 0;
/** until when a scroll here is the one tandem made */
let scrollQuietUntil = 0;
/** when this person last put a hand on this device (a scroll is a move only just after) */
let lastInput = 0;
/** this screen began presenting because the other did */
let presentedByTandem = false;
/** a followed place still to be reached (the file opens, the deck loads) */
let pending: { doc: string; slide?: number; top?: number; pres?: boolean; until: number } | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | undefined;

const plain = (id: string | null | undefined) => (id ? id.replace(/^raw:/, '') : null);
const newer = (a: Key, b: Key) => a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);
const bump = (ch: 'p' | 't' | 'r') => { maxN = Math.max(maxN, me.k.p[0], me.k.t[0], me.k.r[0]) + 1; me.k = { ...me.k, [ch]: [maxN, SCREEN] }; };
const storeKey = (p: string) => 'ol.tandem:' + p;

function view(): TandemView {
  const others = [...peers.values()].filter(p => p.d !== DEVICE).map(p => ({ c: p.c, name: p.name, on: !!p.s?.on }));
  return { project, on: me.on, name: NAME, others };
}
const emit = () => { const v = view(); for (const fn of subs) { try { fn(v); } catch (e) { console.error('tandem listener failed', e); } } };
export function subscribeTandem(fn: (v: TandemView) => void): () => void { subs.add(fn); fn(view()); return () => { subs.delete(fn); }; }

/* ------------------------------------------------------------------ the connection */

let postTimer: ReturnType<typeof setTimeout> | undefined;
let lastPost = 0;
/** this screen's state to the others: at most every POST_MS (a moving scroll, a stroke's tool) */
const POST_MS = 150;
function publish(): void {
  if (!project || !es) return;
  clearTimeout(postTimer);
  const wait = lastPost + POST_MS - Date.now();
  if (wait > 0) { postTimer = setTimeout(publish, wait); return; }
  lastPost = Date.now();
  const p = project;
  void fetch(`${API_BASE}/api/projects/${encodeURIComponent(p)}/tandem`, {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ c: SCREEN, s: me }),
  }).catch(() => { /* offline: the next state goes */ });
}

function checked(s: unknown): TandemState | null {
  if (!s || typeof s !== 'object') return null;
  const o = s as Record<string, unknown>;
  const key = (v: unknown): Key => (Array.isArray(v) && Number.isInteger(v[0]) && typeof v[1] === 'string' ? [v[0] as number, (v[1] as string).slice(0, 40)] : ZERO);
  const k = (o.k && typeof o.k === 'object' ? o.k : {}) as Record<string, unknown>;
  const int = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) < 1e8 ? (v as number) : undefined);
  const t = o.tool && typeof o.tool === 'object' ? o.tool as Record<string, unknown> : null;
  return {
    v: 1, on: o.on === true, ...(o.touch === 1 ? { touch: 1 as const } : {}),
    doc: typeof o.doc === 'string' && o.doc.length < 1000 ? o.doc : null,
    slide: int(o.slide), top: int(o.top), pres: o.pres === 1 ? 1 : 0,
    tool: t ? { t: typeof t.t === 'string' ? t.t.slice(0, 20) : undefined, pen: typeof t.pen === 'string' ? t.pen.slice(0, 20) : undefined, c: typeof t.c === 'string' && /^#[0-9a-fA-F]{6}$/.test(t.c) ? t.c : undefined, w: typeof t.w === 'number' && t.w > 0 && t.w < 200 ? t.w : undefined } : undefined,
    k: { p: key(k.p), t: key(k.t), r: key(k.r) },
  };
}

function onMessage(m: MessageEvent): void {
  let ev: { kind?: string; c?: string; d?: string; n?: string; s?: unknown; peers?: { c: string; d: string; n: string; s: unknown }[] };
  try { ev = JSON.parse(String(m.data)); } catch { return; }
  if (ev.kind === 'peers' && Array.isArray(ev.peers)) {
    peers.clear();
    for (const p of ev.peers) peers.set(p.c, { c: p.c, d: p.d, name: p.n, s: checked(p.s) });
    lastPost = 0;
    publish();
    for (const p of peers.values()) consider(p);
  } else if (ev.kind === 'join' && ev.c && ev.d) {
    peers.set(ev.c, { c: ev.c, d: ev.d, name: ev.n || 'Another screen', s: null });
    lastPost = 0;
    publish();
  } else if (ev.kind === 'state' && ev.c) {
    const p = peers.get(ev.c);
    if (!p) return;
    p.s = checked(ev.s);
    consider(p);
  } else if (ev.kind === 'leave' && ev.c) peers.delete(ev.c);
  emit();
}

/** Connect to the project shown (null: none). */
export function tandemProject(p: string | null): void {
  if (p && isE2eProject(p)) p = null;
  if (p === project) return;
  es?.close();
  es = null;
  peers.clear();
  project = p;
  me.on = false;
  if (p && typeof EventSource !== 'undefined') {
    try { me.on = localStorage.getItem(storeKey(p)) === '1'; } catch { /* private window */ }
    if (me.on) bump('p');
    listenInput();
    es = new EventSource(`${API_BASE}/api/projects/${encodeURIComponent(p)}/tandem?c=${SCREEN}&d=${encodeURIComponent(DEVICE)}&n=${encodeURIComponent(NAME)}`);
    es.onmessage = onMessage;
  }
  emit();
}

/** Turn tandem on or off on this screen (the chip). On: it goes where the screens already in tandem are; none: it leads. */
export function setTandemOn(on: boolean): void {
  if (!project) return;
  me.on = on;
  try { localStorage.setItem(storeKey(project), on ? '1' : '0'); } catch { /* private window */ }
  if (on) {
    const lead = [...peers.values()].filter(p => p.d !== DEVICE && p.s?.on);
    if (lead.length) { me.k = { p: ZERO, t: ZERO, r: ZERO }; for (const p of lead) consider(p); }
    else { bump('p'); bump('t'); bump('r'); }
  }
  publish();
  emit();
}

/* ------------------------------------------------------------------ following */

function consider(p: TandemPeer): void {
  const s = p.s;
  if (!s) return;
  maxN = Math.max(maxN, s.k.p[0], s.k.t[0], s.k.r[0]);
  if (!me.on || !s.on || p.d === DEVICE) return;
  if (newer(s.k.p, me.k.p)) { me.k = { ...me.k, p: s.k.p }; followPlace(s); }
  if (newer(s.k.t, me.k.t)) { me.k = { ...me.k, t: s.k.t }; followTool(s); }
  if (newer(s.k.r, me.k.r)) { me.k = { ...me.k, r: s.k.r }; followPresenting(s); }
}

function followPlace(s: TandemState): void {
  const doc = plain(s.doc);
  if (!doc) return;
  if (doc !== plain(me.doc)) {
    settleUntil = Date.now() + 3000;
    followed.doc = doc;
    location.hash = '#/' + doc;
  } else settleUntil = Math.max(settleUntil, Date.now() + 700);
  pending = { doc, slide: s.slide, top: s.top, pres: pending?.doc === doc ? pending.pres : undefined, until: Date.now() + 4000 };
  reach();
}

function followTool(s: TandemState): void {
  const t = s.tool;
  if (!t) return;
  if (deck && t.t && deck.tool() !== t.t) { followed.tool = t.t; deck.setTool(t.t); }
  if (t.pen === 'pen' || t.pen === 'highlighter') {
    const ink = loadDeckInk(), set = ink.pens[t.pen as DeckPen];
    if (ink.pen !== t.pen || (t.c && set.color !== t.c) || (t.w && set.width !== t.w)) {
      applyingInk = true;
      try { saveDeckInk(patchDeckInk(ink, { pen: t.pen as DeckPen, ...(t.c ? { color: t.c } : {}), ...(t.w ? { width: t.w } : {}) })); } finally { applyingInk = false; }
    }
  }
}

function followPresenting(s: TandemState): void {
  const on = s.pres === 1, doc = plain(s.doc);
  if (on && doc) {
    if (pending && pending.doc === doc) pending.pres = true;
    else pending = { doc, pres: true, until: Date.now() + 5000 };
    reach();
  } else if (!on && deck?.presenting() && presentedByTandem) {
    followed.pres = false;
    presentedByTandem = false;
    deck.present(false, false);
  }
}

/** Go on towards the place followed: the file opens and loads in its time (tried again for a few seconds). */
function reach(): void {
  clearTimeout(pendingTimer);
  const p = pending;
  if (!p) return;
  if (Date.now() > p.until) { pending = null; return; }
  let done = plain(me.doc) === p.doc;
  if (done && deck && plain(deck.doc) === p.doc) {
    if (p.slide !== undefined && !deck.presenting() && deck.current() !== p.slide) { followed.slide = p.slide; deck.goto(p.slide); done = false; }
    if (p.pres && !deck.presenting()) {
      followed.pres = true;
      presentedByTandem = true;
      deck.present(true, TOUCH);
      p.pres = false;
    }
  } else if (done && text && p.top !== undefined) {
    if (!scrollTextTo(p.top)) done = false;
    else if (Date.now() < p.until - 3000) done = false;   // (once more as the document settles)
  } else if (done && (p.slide !== undefined || p.pres)) done = false;   // (the deck is still loading)
  if (done && !p.pres) { pending = null; return; }
  pendingTimer = setTimeout(reach, 350);
}

/* ------------------------------------------------------------------ the document's place */

const TOP_PAD = 12;
function textTop(): number | undefined {
  const sc = text?.scroller(), v = text?.view();
  if (!sc || !v || !v.dom.isConnected) return undefined;
  const r = sc.getBoundingClientRect(), vr = v.dom.getBoundingClientRect();
  if (vr.top >= r.top + TOP_PAD) return 0;
  try { return v.posAtCoords({ left: vr.left + Math.min(60, vr.width / 2), top: r.top + TOP_PAD })?.pos ?? undefined; } catch { return undefined; }
}
function scrollTextTo(pos: number): boolean {
  const sc = text?.scroller(), v = text?.view();
  if (!sc || !v || !v.dom.isConnected) return false;
  try {
    const at = v.coordsAtPos(Math.max(0, Math.min(pos, v.state.doc.content.size)));
    const dy = at.top - (sc.getBoundingClientRect().top + TOP_PAD);
    if (Math.abs(dy) > 2) { scrollQuietUntil = Date.now() + 500; sc.scrollTop += dy; }
    return true;
  } catch { return false; }
}

let inputOn = false;
function listenInput(): void {
  if (inputOn || typeof window === 'undefined') return;
  inputOn = true;
  const mark = () => { lastInput = Date.now(); };
  for (const t of ['pointerdown', 'wheel', 'keydown', 'touchstart'] as const) window.addEventListener(t, mark, { capture: true, passive: true });
}

/* ------------------------------------------------------------------ what happens here */

/** a change here: a move (made by this person) unless it carries out what was followed */
function change(ch: 'p' | 't' | 'r', move: boolean): void {
  if (move && me.on) bump(ch);
  publish();
}
const settling = () => Date.now() < settleUntil;
/** one use of what was followed: this change carries it out */
function carriesOut<K extends keyof typeof followed>(k: K, v: (typeof followed)[K]): boolean {
  if (followed[k] === undefined) return false;
  const same = followed[k] === v;
  delete followed[k];
  return same;
}

/** The file shown here (the address's id), or none. */
export function tandemShow(id: string | null): void {
  const doc = plain(id);
  if (doc === me.doc) return;
  me.doc = doc;
  me.slide = undefined;
  me.top = undefined;
  if (!project) return;
  change('p', !carriesOut('doc', doc ?? undefined) && !settling());
}

/** The document editor's window (App.tsx): its scroll is the place followed. */
export function bindTandemText(b: TandemText): () => void {
  text = b;
  let sc: HTMLElement | null = null, raf = 0;
  const onScroll = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const top = textTop();
      if (top === undefined || top === me.top) return;
      me.top = top;
      const now = Date.now();
      change('p', now >= scrollQuietUntil && !settling() && now - lastInput < 1200);
    });
  };
  const attach = () => {
    const next = b.scroller();
    if (next === sc) return;
    sc?.removeEventListener('scroll', onScroll);
    sc = next;
    sc?.addEventListener('scroll', onScroll, { passive: true });
  };
  attach();
  const iv = setInterval(attach, 1000);
  return () => { clearInterval(iv); sc?.removeEventListener('scroll', onScroll); if (text === b) text = null; };
}

/** A deck open in the editor: its slide, tool and presenting are followed. */
export function bindTandemDeck(b: TandemDeck): () => void {
  deck = b;
  setTimeout(reach, 0);
  return () => { if (deck === b) deck = null; };
}

/** The slide shown in the deck editor. */
export function tandemSlide(slide: number): void {
  if (me.slide === slide) return;
  me.slide = slide;
  if (!project) return;
  change('p', !carriesOut('slide', slide) && !settling());
}

/** The deck editor's tool. */
export function tandemTool(t: string): void {
  if (me.tool?.t === t) return;
  me.tool = { ...inkTool(), t };
  if (!project) return;
  change('t', !carriesOut('tool', t));
}

/** The deck is presented here (or no longer). */
export function tandemPresenting(on: boolean): void {
  if (!!me.pres === on) return;
  me.pres = on ? 1 : 0;
  if (!project) return;
  const followedHere = carriesOut('pres', on);
  // (leaving a presentation this screen followed into ends it here only)
  const move = !followedHere && (on || !presentedByTandem);
  if (!on) presentedByTandem = false;
  change('r', move);
}

let applyingInk = false;
function inkTool(): TandemTool {
  try { const ink = loadDeckInk(), set = ink.pens[ink.pen]; return { pen: ink.pen, c: set?.color, w: set?.width }; } catch { return {}; }
}
if (typeof window !== 'undefined') {
  subscribeDeckInk(() => {
    const next = { ...me.tool, ...inkTool() };
    if (next.pen === me.tool?.pen && next.c === me.tool?.c && next.w === me.tool?.w) return;
    me.tool = next;
    if (project) change('t', !applyingInk);
  });
}

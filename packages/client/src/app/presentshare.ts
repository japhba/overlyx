/**
 * Presenting on several screens at once: the same document presented on an iPad and on a Mac, or by
 * two people. What is drawn on the slides (app/presentkit.ts: the pen, the highlighter, the eraser, a
 * slide cleared), the laser pointer and, while "Linked", the slide shown go from each screen to the
 * others, live. They travel in the document's awareness, the presence states its collaboration already
 * relays (HTML decks: the deliverable editor's, layout and beamer documents: the text editor's). No
 * server of its own.
 *
 * Each presenter's state (the field `present`, PresentState) holds:
 * - `at`: the slide and step it shows, whether it is linked, and `n`, a Lamport clock of the moves. A
 *   move made here takes the highest `n` seen plus one. A linked screen follows the linked screen of
 *   the same account (someone else presenting the document at the same time, an audience member, does
 *   not turn its slides) with the highest (n, id) when that is ahead of what it has, and following is
 *   not a move (no echo), so whichever screen moves takes the others along. Of screens that have not
 *   moved by themselves (n = −1) the one presenting first leads: one joining late follows the others
 *   rather than taking them to its first slide;
 * - `ink`: its strokes, per slide (by the slide's index, so screens of any size line up), in slide
 *   units (presentkit SLIDE_UNITS across). Points are in quarter units, each written as the step from
 *   the one before, and simplified. Beyond `INK_CAP` characters the oldest are left out (the newest
 *   and those of the slide shown first): the server relays no state over 256 KB (core awareness.ts).
 *   `iv` counts the changes, so the others decode them again only when they changed. A presenter
 *   joining late gets them all from the others' states;
 * - `gone`: the strokes erased here, anyone's (a slide cleared erases all of its): every screen hides
 *   them, their owner stops sharing them;
 * - `live`: the stroke being drawn (it shows on the others while it is drawn), `laser`: the laser's dot
 *   with its recent trail, or its held trace.
 *
 * The strokes of a presenter that stops presenting are kept by the others (and shared on by them), so
 * the drawings stay with the presentation. Everything another client sends is checked: sizes capped,
 * colours `#rrggbb` (the kit draws only its palette's), numbers whole and in range.
 */
import type { Awareness } from 'y-protocols/awareness';
import type { InkStroke } from './presentkit';

export type Pt = [number, number];

/** the awareness field a presenter's state goes in */
export const PRESENT_FIELD = 'present';
/** the most characters of strokes one presenter shares (the rest stay on its own screen) */
export const INK_CAP = 48_000;
/** points are shared in quarters of a slide unit (a 1000th of the slide's width) */
const Q = 4;
/** the most points of one stroke, of an encoded stroke's characters, of strokes one presenter shares */
const MAX_PTS = 4000;
const MAX_CHARS = 40_000;
const MAX_STROKES = 2000;
/** how far from a slide a point may be (slide units) */
const BOUND = 20_000;
/** the erased strokes a presenter tells of (the newest) */
export const GONE_CAP = 400;
/** the moving laser's trail shared (its newest points), the held trace's most points */
export const TRAIL_PTS = 24;
export const HELD_PTS = 600;
/** how far a shared stroke may stray from the drawn one (slide units: half a px on a 1500 px wide slide) */
const SIMPLIFY = 0.35;

/** another client's `present` state as its awareness has it (unchecked), and whether it is a screen of this account (`mine`: Linked follows only those) */
export interface PresenterState { client: number; state: unknown; mine?: boolean }

/** a stroke with its id: the presenter that drew it, and its number there */
export type SharedStroke = InkStroke & { id: string };

export interface PresentAt {
  slide: number;
  step: number;
  /** the Lamport clock of the moves (−1: this screen has not moved by itself) */
  n: number;
  /** it follows the others' moves and takes them along with its own */
  linked: boolean;
  /** when it began presenting (ms since 1970): of screens that have not moved, the first leads */
  t0: number;
}

/** what one presenter shares */
export interface PresentState {
  v: 1;
  /** the screen's id (strokes' ids begin with it; it breaks ties between moves) */
  id: string;
  at: PresentAt;
  /** the strokes' version (changed whenever `ink` or `gone` did) */
  iv: number;
  /** its strokes, per slide */
  ink: Record<string, string[]>;
  /** strokes erased here, anyone's */
  gone: string[];
  /** the stroke being drawn, on the slide `k` */
  live: { k: string; s: string } | null;
  /** the laser on the slide `k`: its points (`n`: the number of the first, counted since the laser came on), held or moving */
  laser: { k: string; n: number; pts: string; held: boolean } | null;
}

/** another presenter's state, checked and decoded */
export interface PeerPresent {
  client: number;
  /** a screen of this account */
  mine: boolean;
  id: string;
  at: PresentAt;
  iv: number;
  ink: Map<string, SharedStroke[]>;
  gone: string[];
  live: { k: string; stroke: InkStroke } | null;
  laser: { k: string; n: number; pts: Pt[]; held: boolean } | null;
}

/* ------------------------------------------------------------------ encoding */

const isId = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9.]{1,24}$/.test(v);
/** a slide's key: "s3" (the fourth slide), or the presenter's position text where it has no index */
const isKey = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 24 && /^[\w ./-]+$/.test(v);
const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= lo && v <= hi;

/** the points in quarter units, each as the step from the one before: "x0,y0,dx1,dy1,…" */
export function encodePts(pts: readonly (readonly [number, number])[]): string {
  let out = '', px = 0, py = 0;
  const n = Math.min(pts.length, MAX_PTS);
  for (let i = 0; i < n; i++) {
    const x = Math.round(pts[i][0] * Q), y = Math.round(pts[i][1] * Q);
    out += (i ? ',' : '') + (x - px) + ',' + (y - py);
    px = x; py = y;
  }
  return out;
}

/** encodePts read back; null when it is not what encodePts writes (or too long, or far off the slide) */
export function decodePts(s: unknown): Pt[] | null {
  if (typeof s !== 'string' || s.length > MAX_CHARS || !/^[-\d,]*$/.test(s)) return null;
  if (!s) return [];
  const parts = s.split(',');
  if (parts.length % 2 || parts.length / 2 > MAX_PTS) return null;
  const out: Pt[] = [];
  let x = 0, y = 0;
  for (let i = 0; i < parts.length; i += 2) {
    if (!/^-?\d{1,9}$/.test(parts[i]) || !/^-?\d{1,9}$/.test(parts[i + 1])) return null;
    x += Number(parts[i]); y += Number(parts[i + 1]);
    if (Math.abs(x) > BOUND * Q || Math.abs(y) > BOUND * Q) return null;
    out.push([x / Q, y / Q]);
  }
  return out;
}

/** Douglas–Peucker: the points that keep the line within `tol` of where it was */
export function simplifyPts(pts: readonly Pt[], tol = SIMPLIFY): Pt[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a], [bx, by] = pts[b], dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let far = -1, fd = tol;
    for (let i = a + 1; i < b; i++) {
      const t = l2 ? Math.max(0, Math.min(1, ((pts[i][0] - ax) * dx + (pts[i][1] - ay) * dy) / l2)) : 0;
      const d = Math.hypot(pts[i][0] - ax - t * dx, pts[i][1] - ay - t * dy);
      if (d > fd) { fd = d; far = i; }
    }
    if (far >= 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/** a stroke as shared: "id;marker;colour;width;points" (its points simplified) */
export function encodeStroke(s: SharedStroke): string {
  return `${s.id};${s.marker ? 1 : 0};${s.color};${Math.round(s.w * 100) / 100};${encodePts(simplifyPts(s.pts))}`;
}

/** encodeStroke read back (`live`: no id needed), null when it is not a stroke */
export function decodeStroke(v: unknown): SharedStroke | null {
  if (typeof v !== 'string' || v.length > MAX_CHARS + 64) return null;
  const parts = v.split(';');
  if (parts.length !== 5) return null;
  const [id, m, color, w, p] = parts;
  const width = Number(w);
  if (!isId(id) || (m !== '0' && m !== '1') || !/^#[0-9a-fA-F]{6}$/.test(color) || !(width > 0 && width <= 400)) return null;
  const pts = decodePts(p);
  if (!pts || !pts.length) return null;
  return { id, marker: m === '1', color, w: width, pts };
}

function readAt(v: unknown): PresentAt | null {
  const a = v as Partial<PresentAt> | null;
  if (!a || typeof a !== 'object' || !isInt(a.slide, 0, 1e5) || !isInt(a.step, 1, 1e5) || !isInt(a.n, -1, 1e12) || typeof a.linked !== 'boolean' || !isInt(a.t0, 0, 1e15)) return null;
  return { slide: a.slide, step: a.step, n: a.n, linked: a.linked, t0: a.t0 };
}

/**
 * Whether the presenter at `a` (id `aid`) leads the one at `b`: it moved last (a higher clock); of two
 * that have not moved yet, it began presenting first; else the higher id (two moves at once).
 */
export function leads(a: PresentAt, aid: string, b: PresentAt, bid: string): boolean {
  if (a.n !== b.n) return a.n > b.n;
  if (a.n < 0 && a.t0 !== b.t0) return a.t0 < b.t0;
  return aid > bid;
}

/** a presenter's strokes, checked (at most MAX_STROKES, of slides with proper keys); null when not strokes at all */
function readInk(v: unknown): Map<string, SharedStroke[]> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out = new Map<string, SharedStroke[]>();
  let n = 0;
  for (const [k, list] of Object.entries(v as Record<string, unknown>)) {
    if (!isKey(k) || !Array.isArray(list)) continue;
    const strokes: SharedStroke[] = [];
    for (const s of list) {
      if (n >= MAX_STROKES) break;
      const st = decodeStroke(s);
      if (st) { strokes.push(st); n++; }
    }
    if (strokes.length) out.set(k, strokes);
  }
  return out;
}

const readGone = (v: unknown): string[] => (Array.isArray(v) ? v.slice(-GONE_CAP).filter(isId) : []);

function readLive(v: unknown): PeerPresent['live'] {
  const l = v as { k?: unknown; s?: unknown } | null;
  if (!l || typeof l !== 'object' || !isKey(l.k)) return null;
  const stroke = decodeStroke(l.s);
  return stroke ? { k: l.k, stroke } : null;
}

function readLaser(v: unknown): PeerPresent['laser'] {
  const l = v as { k?: unknown; n?: unknown; pts?: unknown; held?: unknown } | null;
  if (!l || typeof l !== 'object' || !isKey(l.k) || !isInt(l.n, 0, 1e12) || typeof l.held !== 'boolean') return null;
  const pts = decodePts(l.pts);
  if (!pts || !pts.length || pts.length > HELD_PTS) return null;
  return { k: l.k, n: l.n, pts, held: l.held };
}

/**
 * Another client's `present` state checked and decoded; null when it is not one (it is not
 * presenting). `cached`: that client's state as last decoded — its strokes are taken over when its
 * `iv` (and id) did not change, not decoded again.
 */
export function readPresent(raw: unknown, client: number, cached?: PeerPresent | null, mine = false): PeerPresent | null {
  const s = raw as Partial<PresentState> | null;
  if (!s || typeof s !== 'object' || s.v !== 1 || !isId(s.id) || !isInt(s.iv, 0, 1e12)) return null;
  const at = readAt(s.at);
  if (!at) return null;
  const same = cached && cached.id === s.id && cached.iv === s.iv;
  const ink = same ? cached.ink : readInk(s.ink);
  if (!ink) return null;
  return { client, mine, id: s.id, at, iv: s.iv, ink, gone: same ? cached.gone : readGone(s.gone), live: readLive(s.live), laser: readLaser(s.laser) };
}

/**
 * A presenter's state as its own frame sent it (the deck's page runs in that frame too: it is checked
 * before it goes out), rebuilt from what passed — null when it is not one. Its strokes are checked
 * again only when `iv` changed since `prev`.
 */
export function checkedPresent(raw: unknown, prev: { iv: number; id: string; ink: Record<string, string[]>; gone: string[] } | null = null): PresentState | null {
  const s = raw as Partial<PresentState> | null;
  if (!s || typeof s !== 'object' || s.v !== 1 || !isId(s.id) || !isInt(s.iv, 0, 1e12)) return null;
  const at = readAt(s.at);
  if (!at) return null;
  let ink: Record<string, string[]>, gone: string[];
  if (prev && prev.iv === s.iv && prev.id === s.id) ({ ink, gone } = prev);
  else {
    const read = readInk(s.ink);
    if (!read) return null;
    ink = {};
    let size = 0;
    for (const [k, list] of read) {
      const enc = list.map(encodeStroke).filter(e => (size += e.length) <= INK_CAP * 1.25);
      if (enc.length) ink[k] = enc;
    }
    gone = readGone(s.gone);
  }
  const live = readLive(s.live), laser = readLaser(s.laser);
  return {
    v: 1, id: s.id, at, iv: s.iv, ink, gone,
    live: live ? { k: live.k, s: (s.live as { s: string }).s } : null,
    laser: laser ? { k: laser.k, n: laser.n, pts: (s.laser as { pts: string }).pts, held: laser.held } : null,
  };
}

/* ------------------------------------------------------------------ one screen's share */

/** a move to follow: a linked presenter ahead of this screen */
export interface Follow { slide: number; step: number; n: number }

/**
 * The presenting state one screen shares, and what it knows of the others': ids for its strokes, the
 * strokes erased anywhere, the moves' clock, the strokes kept from presenters that stopped.
 */
export class PresentShare {
  /** this screen's id among the presenters */
  readonly id: string;
  private seq = 0;
  at: PresentAt = { slide: 0, step: 1, n: -1, linked: true, t0: Date.now() };
  /** the strokes' version shared (bumped by `inkChanged`) */
  private iv = 0;
  /** the strokes erased here (anyone's), newest last, and every stroke erased anywhere */
  private gone: string[] = [];
  private goneAll = new Set<string>();
  private peers = new Map<number, PeerPresent>();
  /** strokes of presenters that stopped presenting, per slide by id: kept here, shared on from here */
  private kept = new Map<string, Map<string, SharedStroke>>();
  /** the strokes as last shared (rebuilt when `iv` changes) */
  private inkOut: { iv: number; ink: Record<string, string[]> } | null = null;
  private encoded = new WeakMap<InkStroke, string>();

  constructor(id = Math.random().toString(36).slice(2, 8) || 'p') { this.id = id.replace(/[^a-z0-9]/g, '').slice(0, 12) || 'p'; }

  /** an id for a new stroke drawn here */
  newId(): string { return `${this.id}.${(++this.seq).toString(36)}`; }

  get presenters(): number { return this.peers.size; }
  /** the other screens of this account presenting */
  get screens(): number { let n = 0; for (const p of this.peers.values()) if (p.mine) n++; return n; }

  /** this screen's strokes changed (drawn, erased, a slide cleared): the next state shares them anew */
  inkChanged(): void { this.iv++; }

  /** strokes erased here — anyone's: they go on every screen */
  erase(ids: readonly string[]): void {
    let any = false;
    for (const id of ids) if (!this.goneAll.has(id)) { this.goneAll.add(id); this.gone.push(id); any = true; }
    if (this.gone.length > GONE_CAP) this.gone.splice(0, this.gone.length - GONE_CAP);
    for (const m of this.kept.values()) for (const id of ids) m.delete(id);
    if (any) this.inkChanged();
  }

  /**
   * The strokes on the slide `key`: this screen's (`own`), the other presenters', those kept from
   * presenters that left — each once, none erased.
   */
  merged(key: string, own: readonly InkStroke[]): InkStroke[] {
    const seen = new Set<string>();
    const out: InkStroke[] = [];
    const add = (s: InkStroke) => {
      if (s.id) { if (seen.has(s.id) || this.goneAll.has(s.id)) return; seen.add(s.id); }
      out.push(s);
    };
    own.forEach(add);
    for (const p of [...this.peers.values()].sort((a, b) => a.client - b.client)) p.ink.get(key)?.forEach(add);
    this.kept.get(key)?.forEach(add);
    return out;
  }

  /** the strokes the others are drawing on the slide `key` */
  liveOn(key: string): InkStroke[] {
    return [...this.peers.values()].filter(p => p.live?.k === key).map(p => p.live!.stroke);
  }

  /** the others' lasers, by client */
  lasers(): Map<number, NonNullable<PeerPresent['laser']>> {
    const out = new Map<number, NonNullable<PeerPresent['laser']>>();
    for (const p of this.peers.values()) if (p.laser) out.set(p.client, p.laser);
    return out;
  }

  /** the highest move clock seen, here and on the other screens */
  private clock(): number {
    let n = this.at.n;
    for (const p of this.peers.values()) n = Math.max(n, p.at.n);
    return n;
  }

  /**
   * The linked presenter that leads (`leads`), when it leads this screen too, this screen is linked
   * and it shows another slide or step; null when there is nothing to follow. `any`: that presenter
   * even when this screen leads it (a screen linked again joins the others where they are).
   */
  leader(any = false): Follow | null {
    if (!this.at.linked) return null;
    let best: PeerPresent | null = null;
    for (const p of this.peers.values()) if (p.mine && p.at.linked && (!best || leads(p.at, p.id, best.at, best.id))) best = p;
    if (!best || !(any || leads(best.at, best.id, this.at, this.id))) return null;
    if (best.at.slide === this.at.slide && best.at.step === this.at.step) return null;
    return { slide: best.at.slide, step: best.at.step, n: best.at.n };
  }

  /**
   * This screen shows another slide or step: by itself (a move: the clock goes on past every one seen),
   * or following a presenter's move `follow` (its clock taken over). Unlinked, its moves lead no one.
   */
  moved(slide: number, step: number, follow: Follow | null = null): void {
    const n = follow ? follow.n : this.at.linked ? this.clock() + 1 : this.at.n;
    this.at = { ...this.at, slide, step, n };
  }

  /** where this screen starts: no move (it leads no one until it moves by itself) */
  place(slide: number, step: number): void { this.at = { ...this.at, slide, step }; }

  setLinked(on: boolean): void { this.at = { ...this.at, linked: on }; }

  /**
   * The other presenters' states as the awareness has them now (anyone's: checked here). Those gone
   * since leave their strokes here. True when this screen's shared strokes changed with it.
   */
  setPeers(list: readonly PresenterState[]): boolean {
    const iv = this.iv;
    const next = new Map<number, PeerPresent>();
    for (const { client, state, mine } of list) {
      const p = readPresent(state, client, this.peers.get(client), mine === true);
      if (p && p.id !== this.id) next.set(client, p);
    }
    // strokes erased elsewhere: no longer shown, nor shared from here (this screen's own, those it keeps)
    for (const p of next.values()) for (const id of p.gone) {
      if (this.goneAll.has(id)) continue;
      this.goneAll.add(id);
      for (const m of this.kept.values()) m.delete(id);
      this.inkChanged();
    }
    // a presenter that stopped: its strokes are kept, and shared on from here
    for (const [client, p] of this.peers) {
      if (next.get(client)?.id === p.id) continue;
      for (const [k, strokes] of p.ink) {
        let m = this.kept.get(k);
        if (!m) this.kept.set(k, m = new Map());
        for (const s of strokes) if (!this.goneAll.has(s.id)) m.set(s.id, s);
      }
      this.inkChanged();
    }
    this.peers = next;
    return this.iv !== iv;
  }

  /**
   * The state to share: `own` this screen's strokes per slide, `current` the slide shown (its strokes
   * are the last left out), the stroke being drawn and the laser as the kit has them.
   */
  state(own: ReadonlyMap<string, readonly InkStroke[]>, current: string, live: PresentState['live'], laser: PresentState['laser']): PresentState {
    if (this.inkOut?.iv !== this.iv) this.inkOut = { iv: this.iv, ink: this.inkRecord(own, current) };
    return { v: 1, id: this.id, at: { ...this.at }, iv: this.iv, ink: this.inkOut.ink, gone: this.gone.slice(), live, laser };
  }

  /** a stroke's shared text, made once */
  encode(s: SharedStroke): string {
    let e = this.encoded.get(s);
    if (e === undefined) { e = encodeStroke(s); this.encoded.set(s, e); }
    return e;
  }

  /**
   * This screen's strokes and those it keeps, not erased, none another presenter shares itself — within
   * INK_CAP: the newest first, those of the slide shown before all, each slide's in the order drawn.
   */
  private inkRecord(own: ReadonlyMap<string, readonly InkStroke[]>, current: string): Record<string, string[]> {
    const live = new Set<string>();
    for (const p of this.peers.values()) for (const list of p.ink.values()) for (const s of list) live.add(s.id);
    const all: { k: string; e: string; order: number; i: number }[] = [];
    let order = 0;
    const take = (k: string, s: InkStroke) => {
      if (!isKey(k) || !s.id || !isId(s.id) || this.goneAll.has(s.id) || !s.pts.length) return;
      all.push({ k, e: this.encode(s as SharedStroke), order: order++, i: all.length });
    };
    for (const [k, m] of this.kept) for (const s of m.values()) if (!live.has(s.id)) take(k, s);
    for (const [k, list] of own) for (const s of list) take(k, s);
    const ranked = [...all].sort((a, b) => (Number(b.k === current) - Number(a.k === current)) || b.order - a.order);
    const kept = new Set<number>();
    let size = 0;
    for (const x of ranked) { if (size + x.e.length > INK_CAP) continue; size += x.e.length; kept.add(x.i); }
    const out: Record<string, string[]> = {};
    for (const x of all) if (kept.has(x.i)) (out[x.k] ??= []).push(x.e);
    return out;
  }
}

/** a slide's key for the drawings: by its index ("s3"), so it is the same slide on every screen */
export const slideKey = (index: number): string => `s${index}`;

/**
 * The other clients' `present` states in a document's awareness, handed to `cb` at once and then
 * whenever one of them changed (a cursor moving elsewhere in the document is no news for the slides);
 * `mine`: the client is signed in as this one is (its `user`'s username).
 */
export function watchPresenters(aw: Awareness, cb: (peers: PresenterState[]) => void): () => void {
  let last = new Map<number, unknown>();
  const userOf = (st: unknown) => { const u = (st as { user?: { username?: unknown } } | null)?.user?.username; return typeof u === 'string' && u ? u : null; };
  const f = (force: boolean) => {
    const next = new Map<number, unknown>(), mine = new Map<number, boolean>();
    const me = userOf(aw.getLocalState());
    aw.getStates().forEach((st, client) => {
      const p = client === aw.clientID ? null : (st as Record<string, unknown>)[PRESENT_FIELD];
      if (p) { next.set(client, p); mine.set(client, !!me && userOf(st) === me); }
    });
    const same = next.size === last.size && [...next].every(([c, p]) => last.get(c) === p);
    last = next;
    if (force || !same) cb([...next].map(([client, state]) => ({ client, state, mine: mine.get(client) })));
  };
  const onChange = () => f(false);
  aw.on('change', onChange);
  f(true);
  return () => aw.off('change', onChange);
}

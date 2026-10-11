/**
 * The math keyboard's pen (✎ Write): a pad to write a formula on with a pen or a finger. Each pause
 * sends what is written — drawn as a black-on-white picture (ink.ts inkLayout), with the formula
 * around the cursor — to the server's recognizer (POST /api/ai/ink, a vision model); up to three
 * readings come back as chips above the pad, the most likely one also shown faintly at the cursor
 * in the formula itself. A chip or ✓ inserts the reading at the cursor (one undo step) and clears
 * the pad for the next piece. A zigzag over strokes scratches them out; ↶ takes back the last
 * change, ✕ clears.
 *
 * Once a pen has touched the pad, fingers no longer write (the hand rests on the screen while
 * writing with a pencil). It is an AI feature: off until switched on (here or Settings ▸ AI), as
 * the privacy notice says.
 */
import { api } from '../../api';
import { getPrefs, setPref } from '../../prefs';
import { renderStaticHtml, type LyxMathField } from '../lyxmath/field';
import { inkLayout, scratchedOut, widthAt, type InkPoint, type Stroke } from './ink';

/** the pause after the last stroke before it is read (ms) */
const PAUSE = 550;

export interface InkPadHost { field(): LyxMathField | null }

export class InkPad {
  readonly el: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private surface: HTMLDivElement;
  private cands: HTMLDivElement;
  private status: HTMLSpanElement;
  private insertBtn: HTMLButtonElement;
  private undoBtn: HTMLButtonElement;
  private clearBtn: HTMLButtonElement;
  private consent: HTMLDivElement;
  private strokes: Stroke[] = [];
  private history: Stroke[][] = [];
  private current: { s: Stroke; id: number } | null = null;
  private penSeen = false;
  private candidates: string[] = [];
  /** the strokes the candidates were read from (stale once the ink changed) */
  private readFor: Stroke[] | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private request: AbortController | null = null;
  private seq = 0;
  private raf = 0;
  /** the field showing a reading as its ghost */
  private ghostOn: LyxMathField | null = null;
  private unavailable = '';

  constructor(private host: InkPadHost) {
    this.el = document.createElement('div');
    this.el.className = 'mk-pad';
    this.el.dataset.mkPad = '';
    const bar = document.createElement('div');
    bar.className = 'mk-pad-bar';
    this.cands = document.createElement('div');
    this.cands.className = 'mk-cands';
    this.status = document.createElement('span');
    this.status.className = 'mk-pad-status';
    this.cands.append(this.status);
    this.undoBtn = this.button('undo', '↶', 'Undo the last stroke');
    this.clearBtn = this.button('clear', '✕', 'Clear the pad');
    this.insertBtn = this.button('insert', '✓', 'Insert the reading at the cursor');
    this.insertBtn.classList.add('mk-pad-insert');
    bar.append(this.cands, this.undoBtn, this.clearBtn, this.insertBtn);
    this.surface = document.createElement('div');
    this.surface.className = 'mk-pad-surface';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'mk-pad-canvas';
    this.canvas.setAttribute('aria-label', 'Handwriting pad: write a formula');
    this.surface.append(this.canvas);
    this.consent = document.createElement('div');
    this.consent.className = 'mk-pad-consent';
    this.consent.innerHTML = '<p>Handwriting is read by an AI model: a picture of what you write here, with the formula around the cursor, goes through the OverLyX server to OpenRouter (Google’s model by default). Nothing is sent until you switch this on — also in Settings ▸ AI.</p>';
    const on = this.button('consent', 'Read my handwriting', 'Switch handwriting recognition on');
    on.classList.add('mk-pad-on');
    this.consent.append(on);
    this.surface.append(this.consent);
    this.el.append(bar, this.surface);
    this.wire();
    this.refresh();
  }

  private button(id: string, label: string, title: string): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mk-pad-btn';
    b.dataset.mkPadBtn = id;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.textContent = label;
    return b;
  }

  /* ------------------------------------------------------------ lifecycle (keyboard.ts) */

  shown(): void {
    this.resized();
    if (this.strokes.length && this.readFor !== this.strokes) this.schedule(0);
    else this.preview();
  }
  hidden(): void { this.cancel(); this.ghost(null); }
  /** another formula took the cursor (or none): its context differs — read again */
  fieldChanged(): void {
    this.ghost(null);
    this.readFor = null;
    if (this.strokes.length && this.el.isConnected) this.schedule(PAUSE);
  }
  resized(): void {
    const r = this.surface.getBoundingClientRect();
    const dpr = Math.max(1, devicePixelRatio || 1);
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.draw();
  }

  /* ------------------------------------------------------------ input */

  private wire(): void {
    const c = this.canvas;
    const at = (e: PointerEvent): InkPoint => {
      const r = c.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top, t: e.timeStamp, p: e.pointerType === 'pen' ? e.pressure || 0.5 : 0.5 };
    };
    c.addEventListener('pointerdown', e => {
      e.preventDefault();
      if (!getPrefs().aiInk) return;
      if (e.pointerType === 'pen') this.penSeen = true;
      // palm rejection: with a pen about, a resting hand does not write
      if (e.pointerType === 'touch' && this.penSeen) return;
      if (this.current) return;
      try { c.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
      this.cancel();
      this.current = { s: { pts: [at(e)], pen: e.pointerType === 'pen' }, id: e.pointerId };
      this.el.classList.add('mk-writing');
      this.paint();
    });
    c.addEventListener('pointermove', e => {
      const cur = this.current;
      if (!cur || e.pointerId !== cur.id) return;
      const evs = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
      for (const ev of evs.length ? evs : [e]) cur.s.pts.push(at(ev));
      this.paint();
    });
    const up = (e: PointerEvent, keep: boolean) => {
      const cur = this.current;
      if (!cur || e.pointerId !== cur.id) return;
      this.current = null;
      this.el.classList.remove('mk-writing');
      if (keep) {
        const out = scratchedOut(cur.s, this.strokes);
        this.history.push(this.strokes);
        this.strokes = out ? this.strokes.filter((_, i) => !out.includes(i)) : [...this.strokes, cur.s];
        this.changed();
      }
      this.paint();
    };
    c.addEventListener('pointerup', e => up(e, true));
    c.addEventListener('pointercancel', e => up(e, false));
    // the bar's buttons and chips act when let go (the keyboard cancels touchstart, so no click follows on iOS)
    this.el.addEventListener('pointerup', e => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-mk-pad-btn], [data-mk-cand]');
      if (!b || !this.el.contains(b)) return;
      if (b.dataset.mkCand !== undefined) { this.insert(this.candidates[Number(b.dataset.mkCand)]); return; }
      switch (b.dataset.mkPadBtn) {
        case 'insert': if (this.candidates.length && this.readFor === this.strokes) this.insert(this.candidates[0]); break;
        case 'undo': if (this.history.length) { this.strokes = this.history.pop()!; this.changed(); this.paint(); } break;
        case 'clear': if (this.strokes.length) { this.history.push(this.strokes); this.strokes = []; this.changed(); this.paint(); } break;
        case 'consent': setPref('aiInk', true); this.refresh(); break;
      }
    });
  }

  /** the ink changed: the readings are stale, a new one after the pause */
  private changed(): void {
    this.cancel();
    this.ghost(null);
    if (!this.strokes.length) { this.candidates = []; this.readFor = this.strokes; this.refresh(); return; }
    this.refresh();
    this.schedule(PAUSE);
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.read(); }, ms);
  }

  private cancel(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.request?.abort();
    this.request = null;
  }

  /* ------------------------------------------------------------ reading */

  /** what is written, as the picture the recognizer reads (a PNG data URL) */
  picture(strokes = this.strokes): string | null {
    const l = inkLayout(strokes);
    if (!l) return null;
    const cv = document.createElement('canvas');
    cv.width = l.w; cv.height = l.h;
    const g = cv.getContext('2d');
    if (!g) return null;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, l.w, l.h);
    g.strokeStyle = g.fillStyle = '#000';
    g.lineWidth = l.line;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (const s of strokes) {
      const pts = s.pts.map(p => ({ x: (p.x - l.x0) * l.k, y: (p.y - l.y0) * l.k }));
      if (pts.length === 1 || pts.every(p => Math.hypot(p.x - pts[0].x, p.y - pts[0].y) < 0.5)) {
        g.beginPath(); g.arc(pts[0].x, pts[0].y, l.line / 2 + 0.5, 0, 2 * Math.PI); g.fill();
        continue;
      }
      g.beginPath();
      g.moveTo(pts[0].x, pts[0].y);
      for (const p of pts.slice(1)) g.lineTo(p.x, p.y);
      g.stroke();
    }
    return cv.toDataURL('image/png');
  }

  private async read(): Promise<void> {
    const strokes = this.strokes;
    const f = this.host.field();
    if (!strokes.length || !getPrefs().aiInk) return;
    const image = this.picture(strokes);
    if (!image) return;
    const around = f ? f.cellLatexAround() : { before: '', after: '' };
    const ac = new AbortController();
    this.request?.abort();
    this.request = ac;
    const seq = ++this.seq;
    this.el.classList.add('mk-reading');
    this.setStatus('Reading…');
    try {
      const r = await api.aiInk({ image, before: around.before, after: around.after, text: f?.cursor.mode === 'text' }, ac.signal);
      if (seq !== this.seq || strokes !== this.strokes) return;
      this.unavailable = '';
      this.candidates = r.candidates;
      this.readFor = strokes;
      this.refresh();
      this.preview();
    } catch (e) {
      if (ac.signal.aborted || seq !== this.seq) return;
      const msg = (e as Error).message || 'The handwriting could not be read.';
      if (/not configured|503/.test(msg)) this.unavailable = 'Handwriting recognition is not available on this server.';
      this.setStatus(this.unavailable || msg);
    } finally {
      if (seq === this.seq) { this.el.classList.remove('mk-reading'); if (this.request === ac) this.request = null; }
    }
  }

  /** the most likely reading shown faintly at the cursor (only at a cell's end: the ghost is drawn there) */
  private preview(): void {
    const f = this.host.field();
    const best = this.readFor === this.strokes ? this.candidates[0] : undefined;
    this.ghost(f && best && f.atCellEnd() ? f : null, best);
  }

  private ghost(f: LyxMathField | null, latex?: string): void {
    if (this.ghostOn && this.ghostOn !== f) this.ghostOn.setGhost(null);
    this.ghostOn = f;
    f?.setGhost(latex ?? null);
  }

  private insert(latex: string | undefined): void {
    const f = this.host.field();
    if (!latex || !f) return;
    this.ghost(null);
    f.execute('replace', latex);
    this.history.push(this.strokes);
    this.strokes = [];
    this.candidates = [];
    this.readFor = this.strokes;
    this.cancel();
    this.refresh();
    this.paint();
  }

  /* ------------------------------------------------------------ drawing */

  private setStatus(text: string): void {
    this.status.textContent = text;
    this.status.hidden = !text;
  }

  /** the bar: the readings (or what is going on), the buttons' states, the consent */
  private refresh(): void {
    const consent = !getPrefs().aiInk;
    this.consent.hidden = !consent;
    this.el.classList.toggle('mk-needs-consent', consent);
    for (const c of this.cands.querySelectorAll('[data-mk-cand]')) c.remove();
    const fresh = this.readFor === this.strokes && this.strokes.length > 0;
    if (fresh && this.candidates.length) {
      const macros = this.host.field()?.macros ?? {};
      this.candidates.forEach((latex, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'mk-cand' + (i === 0 ? ' mk-best' : '');
        b.dataset.mkCand = String(i);
        b.title = latex;
        try { b.innerHTML = renderStaticHtml(latex, false, macros); } catch { b.textContent = latex; }
        this.cands.append(b);
      });
      this.setStatus('');
    } else if (fresh) this.setStatus(this.unavailable || 'Nothing legible — write a little larger?');
    else if (!this.strokes.length) this.setStatus(this.unavailable || 'Write a formula — it is read as you pause');
    else this.setStatus('');
    this.insertBtn.disabled = !(fresh && this.candidates.length);
    this.undoBtn.disabled = !this.history.length;
    this.clearBtn.disabled = !this.strokes.length;
  }

  private paint(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); });
  }

  private draw(): void {
    const g = this.canvas.getContext('2d');
    if (!g) return;
    const dpr = Math.max(1, devicePixelRatio || 1);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const color = getComputedStyle(this.el).getPropertyValue('--mk-ink').trim() || getComputedStyle(this.el).color;
    g.strokeStyle = g.fillStyle = color;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (const s of this.current ? [...this.strokes, this.current.s] : this.strokes) drawStroke(g, s, !!s.pen);
  }
}

/** a stroke as smooth quadratic pieces through the midpoints of its points, as wide as the pen pressed */
function drawStroke(g: CanvasRenderingContext2D, s: Stroke, pen: boolean): void {
  const pts = s.pts, base = 2.6;
  if (pts.length === 1) { g.beginPath(); g.arc(pts[0].x, pts[0].y, widthAt(base, pts[0].p, pen) / 2, 0, 2 * Math.PI); g.fill(); return; }
  if (!pen) {
    g.lineWidth = base;
    g.beginPath();
    g.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) g.quadraticCurveTo(pts[i].x, pts[i].y, (pts[i].x + pts[i + 1].x) / 2, (pts[i].y + pts[i + 1].y) / 2);
    g.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    g.stroke();
    return;
  }
  let px = pts[0].x, py = pts[0].y;
  for (let i = 1; i < pts.length; i++) {
    const last = i === pts.length - 1;
    const mx = last ? pts[i].x : (pts[i].x + pts[i + 1].x) / 2, my = last ? pts[i].y : (pts[i].y + pts[i + 1].y) / 2;
    g.lineWidth = widthAt(base, pts[i].p, true);
    g.beginPath();
    g.moveTo(px, py);
    g.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    g.stroke();
    px = mx; py = my;
  }
}

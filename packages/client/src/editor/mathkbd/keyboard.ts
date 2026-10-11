/**
 * The math keyboard: docked at the bottom of the window while a formula has the cursor on a touch
 * screen (hook.ts decides when), in place of the system keyboard — which the formula's input keeps
 * away with inputmode="none". Pages of keys (keys.ts: numbers and structures, functions, Greek,
 * relations, letters) and the pen (inkpad.ts: handwriting read as LaTeX), with Backspace, the
 * arrows and Enter always at the right. The keys work on the formula's own cursor (LyxMathField):
 * what they do is exactly what the hardware keys and the math toolbar do, one undo step each.
 *
 * A press never takes the focus from the formula (pointerdown, touchstart and mousedown are
 * cancelled); a key acts when it is let go (Backspace and the arrows at once, then repeating while
 * held); held longer, a key with variants shows them above it and the finger picks one. ⌄ folds the
 * panel into a small button (as does a key typed on a hardware keyboard); ⌨ hands over to the
 * system keyboard until the button is tapped again. The panel's height is dragged at its top edge.
 */
import './mathkbd.css';
import { activeMathField, renderStaticHtml, type LyxMathField } from '../lyxmath/field';
import { PAGES, SIDE_KEYS, type KeyAction, type KeyDef } from './keys';
import { hardwareKeyboardSeen, mathKeyboardEnabled, systemKeyboard } from './hook';
import { InkPad } from './inkpad';

const PAGE_STORE = 'ol.mathkbd.page';
const HEIGHT_STORE = 'ol.mathkbd.height';
const LONG_PRESS = 380;
const REPEAT_DELAY = 420, REPEAT_EVERY = 70;

const store = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string): void { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** the panel's height when nobody dragged it: about two fifths of the window, more on a phone */
function defaultHeight(): number {
  const vh = innerHeight;
  return Math.round(innerWidth < 700 ? Math.min(0.46 * vh, 320) : Math.max(230, Math.min(0.4 * vh, 340)));
}

/** a key held down */
interface Press { key: KeyDef; el: HTMLElement; id: number; timer: ReturnType<typeof setTimeout> | null; repeating: boolean; alts: HTMLElement | null; pick: KeyDef | null }

let instance: MathKeyboard | null = null;
/** the keyboard (made once, on the first formula that wants it) */
export function mathKeyboardUi(): { focus(field: LyxMathField | null): void; hardware(): void } {
  if (!instance) instance = new MathKeyboard();
  return instance;
}

export class MathKeyboard {
  readonly root: HTMLDivElement;
  readonly pill: HTMLButtonElement;
  private head: HTMLDivElement;
  private main: HTMLDivElement;
  private side: HTMLDivElement;
  private field: LyxMathField | null = null;
  private page: string;
  private shift = false;
  /** folded by ⌄ while this formula has the cursor (a formula taken anew opens it again) */
  private dismissed = false;
  /** the button was tapped: the panel shows although a hardware key was seen (hook.ts reports only the first) */
  private forced = false;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private height: number;
  private pad: InkPad | null = null;
  private pages = new Map<string, HTMLElement>();
  private press: Press | null = null;

  constructor() {
    this.page = store.get(PAGE_STORE) ?? '123';
    this.height = Number(store.get(HEIGHT_STORE)) || 0;
    this.root = document.createElement('div');
    this.root.className = 'mk';
    this.root.dataset.mk = '';
    this.root.setAttribute('role', 'group');
    this.root.setAttribute('aria-label', 'Math keyboard');
    this.root.hidden = true;
    const grip = document.createElement('div');
    grip.className = 'mk-grip';
    grip.title = 'Drag to resize';
    this.head = document.createElement('div');
    this.head.className = 'mk-head';
    const body = document.createElement('div');
    body.className = 'mk-body';
    this.main = document.createElement('div');
    this.main.className = 'mk-main';
    this.side = document.createElement('div');
    this.side.className = 'mk-side';
    body.append(this.main, this.side);
    this.root.append(grip, this.head, body);
    this.pill = document.createElement('button');
    this.pill.type = 'button';
    this.pill.className = 'mk-pill';
    this.pill.dataset.mkPill = '';
    this.pill.title = 'Math keyboard';
    this.pill.setAttribute('aria-label', 'Show the math keyboard');
    this.pill.innerHTML = '<span>∑</span><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="6" width="19" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M6 10h1M9 10h1M12 10h1M15 10h1M18 10h1M7 14h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
    this.pill.hidden = true;
    document.body.append(this.root, this.pill);

    this.buildHead();
    this.buildSide();
    this.showPage(this.page);
    this.wireKeys();
    this.wireGrip(grip);
    // the button: never takes the focus from the formula either
    for (const t of ['pointerdown', 'mousedown'] as const) this.pill.addEventListener(t, e => e.preventDefault());
    this.pill.addEventListener('touchstart', e => e.preventDefault(), { passive: false });
    this.pill.addEventListener('pointerup', () => this.unfold());
    this.pill.addEventListener('click', () => this.unfold());
    addEventListener('resize', () => { if (!this.root.hidden) this.applyHeight(); });
  }

  /* ------------------------------------------------------------ showing */

  focus(field: LyxMathField | null): void {
    if (field) {
      if (this.hideTimer) { clearTimeout(this.hideTimer); this.hideTimer = null; }
      if (field !== this.field) { this.pad?.fieldChanged(); }
      this.field = field;
      this.update();
      return;
    }
    // the cursor left the formula — perhaps for the next one (an arrow out of one into another)
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null;
      if (activeMathField()) return;
      this.field = null;
      this.dismissed = false;
      this.pad?.fieldChanged();
      this.update();
    }, 160);
  }

  /** a hardware key: folded into the button for the rest of the session (until the button is tapped) */
  hardware(): void { this.forced = false; this.update(); }

  private update(): void {
    const f = this.field;
    const on = !!f && mathKeyboardEnabled();
    const open = on && !this.dismissed && !systemKeyboard() && (this.forced || !hardwareKeyboardSeen());
    this.root.hidden = !open;
    this.pill.hidden = !on || open;
    document.documentElement.classList.toggle('mk-open', open);
    if (open) { this.applyHeight(); requestAnimationFrame(() => this.reveal()); }
    else document.documentElement.style.removeProperty('--mk-h');
  }

  private unfold(): void {
    const f = this.field ?? activeMathField();
    if (!f) return;
    this.dismissed = false;
    this.forced = true;
    if (systemKeyboard()) f.useSystemKeyboard(false);
    this.field = f;
    this.update();
  }

  private applyHeight(): void {
    const h = Math.round(Math.max(180, Math.min(innerHeight * 0.7, this.height || defaultHeight())));
    this.root.style.height = `${h}px`;
    document.documentElement.style.setProperty('--mk-h', `${h}px`);
  }

  /** the formula above the panel: its page scrolled when the panel covers it */
  private reveal(): void {
    const f = this.field;
    // (a formula on a slide lies over the canvas, which is fitted above the panel)
    if (!f || this.root.hidden || f.dom.closest('[data-dl-mathedit]')) return;
    const r = f.dom.getBoundingClientRect();
    const limit = this.root.getBoundingClientRect().top - 16;
    if (r.bottom <= limit) return;
    let sc: HTMLElement | null = f.dom.parentElement;
    while (sc && !(sc.scrollHeight > sc.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement;
    if (sc) sc.scrollBy({ top: r.bottom - limit, behavior: 'smooth' });
  }

  /* ------------------------------------------------------------ building */

  private buildHead(): void {
    const tabs = document.createElement('div');
    tabs.className = 'mk-tabs';
    tabs.setAttribute('role', 'tablist');
    for (const p of PAGES) tabs.append(this.tabButton(p.id, p.tab, p.name));
    tabs.append(this.tabButton('pen', '✎ Write', 'Write by hand'));
    const tools = document.createElement('div');
    tools.className = 'mk-tools';
    const sys = this.headButton('sys', '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="6" width="19" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M6 10h1M9 10h1M12 10h1M15 10h1M18 10h1M7 14h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>', 'The system keyboard (∑ comes back here)');
    const hide = this.headButton('hide', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>', 'Hide the math keyboard');
    tools.append(sys, hide);
    this.head.append(tabs, tools);
  }

  private tabButton(id: string, label: string, name: string): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mk-tab';
    b.dataset.mkTab = id;
    b.textContent = label;
    b.title = name;
    b.setAttribute('role', 'tab');
    return b;
  }

  private headButton(id: string, svg: string, title: string): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mk-tool';
    b.dataset.mkTool = id;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.innerHTML = svg;
    return b;
  }

  private buildSide(): void {
    for (const row of SIDE_KEYS) this.side.append(this.rowOf(row));
  }

  private rowOf(row: KeyDef[]): HTMLDivElement {
    const r = document.createElement('div');
    r.className = 'mk-row';
    for (const k of row) r.append(this.keyEl(k));
    return r;
  }

  private keys = new WeakMap<HTMLElement, KeyDef>();
  private keyEl(k: KeyDef): HTMLElement {
    const shown = this.shift && k.shifted ? k.shifted : k;
    const b = document.createElement('div');
    b.className = `mk-key mk-${shown.kind ?? 'num'}` + (k.alt?.length ? ' mk-has-alt' : '');
    b.setAttribute('role', 'button');
    b.setAttribute('aria-label', shown.name);
    b.title = shown.name;
    b.dataset.mkKey = shown.name;
    b.style.flexGrow = String(k.w ?? 1);
    b.innerHTML = this.labelHtml(shown);
    if (k.a && 'kb' in k.a && k.a.kb === 'shift' && this.shift) b.classList.add('mk-on');
    this.keys.set(b, shown === k ? k : { ...shown, alt: k.alt, shifted: shown });
    return b;
  }

  private labels = new Map<string, string>();
  private labelHtml(k: KeyDef): string {
    if (!k.tex) return `<span class="mk-l">${escapeHtml(k.label ?? '')}</span>`;
    let h = this.labels.get(k.tex);
    if (h === undefined) {
      try { h = `<span class="mk-m">${renderStaticHtml(k.tex, false, {})}</span>`; } catch { h = `<span class="mk-l">${escapeHtml(k.name)}</span>`; }
      this.labels.set(k.tex, h);
    }
    return h;
  }

  private showPage(id: string): void {
    if (id !== 'pen' && !PAGES.some(p => p.id === id)) id = '123';
    this.page = id;
    store.set(PAGE_STORE, id);
    for (const b of this.head.querySelectorAll<HTMLElement>('.mk-tab')) {
      const on = b.dataset.mkTab === id;
      b.classList.toggle('mk-on', on);
      b.setAttribute('aria-selected', String(on));
    }
    this.root.classList.toggle('mk-pen', id === 'pen');
    if (id === 'pen') {
      if (!this.pad) this.pad = new InkPad({ field: () => this.field ?? activeMathField() });
      this.main.replaceChildren(this.pad.el);
      this.pad.shown();
      return;
    }
    this.pad?.hidden();
    const key = `${id}:${this.shift ? 1 : 0}`;
    let el = this.pages.get(key);
    if (!el) {
      el = document.createElement('div');
      el.className = 'mk-page';
      el.dataset.mkPage = id;
      for (const row of PAGES.find(p => p.id === id)!.rows) el.append(this.rowOf(row));
      this.pages.set(key, el);
    }
    this.main.replaceChildren(el);
  }

  /* ------------------------------------------------------------ pressing */

  private wireKeys(): void {
    const root = this.root;
    // nothing here may take the focus from the formula (or, on iOS, dismiss it)
    // (cancelling touchstart also cancels the click that would follow: the pen's buttons act on pointerup)
    root.addEventListener('touchstart', e => e.preventDefault(), { passive: false });
    root.addEventListener('mousedown', e => e.preventDefault());
    root.addEventListener('contextmenu', e => e.preventDefault());
    root.addEventListener('pointerdown', e => {
      const t = e.target as HTMLElement;
      e.preventDefault();
      if (t.closest('.mk-pad')) return;   // the pen's (inkpad.ts)
      const tab = t.closest<HTMLElement>('[data-mk-tab]');
      if (tab) { this.showPage(tab.dataset.mkTab!); return; }
      const tool = t.closest<HTMLElement>('[data-mk-tool]');
      if (tool) { this.tool(tool.dataset.mkTool!); return; }
      const el = t.closest<HTMLElement>('.mk-key');
      const k = el && this.keys.get(el);
      if (!el || !k) return;
      this.endPress();
      try { el.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
      el.classList.add('mk-down');
      const p: Press = this.press = { key: k, el, id: e.pointerId, timer: null, repeating: false, alts: null, pick: null };
      if (k.repeat) {
        this.act(k);
        p.repeating = true;
        const again = () => { if (this.press !== p) return; this.act(k); p.timer = setTimeout(again, REPEAT_EVERY); };
        p.timer = setTimeout(again, REPEAT_DELAY);
      } else if (k.alt?.length) {
        p.timer = setTimeout(() => { if (this.press === p) this.openAlts(p); }, LONG_PRESS);
      }
    });
    root.addEventListener('pointermove', e => {
      const p = this.press;
      if (!p || e.pointerId !== p.id || !p.alts) return;
      const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('.mk-alt');
      for (const a of p.alts.querySelectorAll<HTMLElement>('.mk-alt')) a.classList.toggle('mk-down', a === hit);
      p.pick = hit ? this.keys.get(hit) ?? null : null;
    });
    root.addEventListener('pointerup', e => {
      const p = this.press;
      if (!p || e.pointerId !== p.id) return;
      if (p.alts) { if (p.pick) this.act(p.pick); }
      else if (!p.repeating) {
        // let go over the key (a finger that slid off it types nothing, as on iOS)
        const r = p.el.getBoundingClientRect();
        const inside = e.clientX >= r.left - 8 && e.clientX <= r.right + 8 && e.clientY >= r.top - 8 && e.clientY <= r.bottom + 8;
        if (inside || e.pointerType === 'mouse') this.act(p.key);
      }
      this.endPress();
    });
    root.addEventListener('pointercancel', () => this.endPress());
  }

  private endPress(): void {
    const p = this.press;
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    p.el.classList.remove('mk-down');
    p.alts?.remove();
    this.press = null;
  }

  /** the variants of a held key, in a row above it */
  private openAlts(p: Press): void {
    const k = p.key;
    const row = document.createElement('div');
    row.className = 'mk-alts';
    for (const a of [{ ...k, alt: undefined }, ...(k.alt ?? [])]) {
      const el = document.createElement('div');
      el.className = 'mk-alt';
      el.title = a.name;
      el.dataset.mkKey = a.name;
      el.innerHTML = this.labelHtml(a);
      this.keys.set(el, a);
      row.append(el);
    }
    this.root.append(row);
    const r = p.el.getBoundingClientRect(), rr = this.root.getBoundingClientRect();
    const w = row.offsetWidth, h = row.offsetHeight;
    const left = Math.max(4, Math.min(rr.width - w - 4, r.left - rr.left + r.width / 2 - w / 2));
    row.style.left = `${left}px`;
    row.style.top = `${Math.max(-h - 4, r.top - rr.top - h - 6)}px`;
    p.alts = row;
    p.el.classList.remove('mk-down');
    // the variant under the finger right away: the key itself (the first)
    const first = row.querySelector<HTMLElement>('.mk-alt');
    first?.classList.add('mk-down');
    p.pick = first ? this.keys.get(first) ?? null : null;
  }

  private tool(id: string): void {
    const f = this.field ?? activeMathField();
    if (id === 'hide') { this.dismissed = true; this.update(); return; }
    if (id === 'sys' && f) { f.useSystemKeyboard(true); this.update(); }
  }

  /** what a key does, on the formula with the cursor */
  act(k: KeyDef): void {
    const f = this.field ?? activeMathField();
    if (!f) return;
    this.run(f, k.a, k);
    // Shift holds for one letter
    if (this.shift && k.shifted && !('kb' in k.a)) { this.shift = false; this.showPage(this.page); }
  }

  private run(f: LyxMathField, a: KeyAction, k: KeyDef): void {
    if ('type' in a) f.typeText(a.type);
    else if ('insert' in a) f.execute('insert', a.insert);
    else if ('cmd' in a) f.execute(a.cmd, ...(a.args ?? []));
    else if ('key' in a) f.pressKey({ key: a.key, shiftKey: !!a.shift, ctrlKey: !!a.mod && !mac, metaKey: !!a.mod && mac });
    else if ('seq' in a) for (const x of a.seq) this.run(f, x, k);
    else if (a.kb === 'shift') { this.shift = !this.shift; this.showPage(this.page); }
    else if (a.kb === 'pairClose') {
      // `)` beside the `)` the ( key put in: over it, as editors that close brackets do
      const ch = k.label ?? ')';
      const next = f.cursor.nextAtom();
      if (next && next.t === 'char' && next.c === ch) f.pressKey({ key: 'ArrowRight' });
      else f.typeText(ch);
    }
  }

  /* ------------------------------------------------------------ resizing */

  private wireGrip(grip: HTMLElement): void {
    let start: { y: number; h: number } | null = null;
    grip.addEventListener('pointerdown', e => {
      e.preventDefault();
      e.stopPropagation();
      start = { y: e.clientY, h: this.root.getBoundingClientRect().height };
      try { grip.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    });
    grip.addEventListener('pointermove', e => {
      if (!start) return;
      this.height = Math.max(180, Math.min(innerHeight * 0.7, start.h + start.y - e.clientY));
      this.applyHeight();
      this.pad?.resized();
    });
    const end = () => { if (!start) return; start = null; store.set(HEIGHT_STORE, String(Math.round(this.height))); this.reveal(); };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  }
}

function escapeHtml(s: string): string { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

/**
 * The emoji keyboard (Insert ▸ Emoji…, the toolbar's ☺ button, Ctrl+; — DOCS.md "Emoji"): one emoji
 * per row with its variants to the right (skin tones; the colours of the hearts, circles, squares,
 * books …) and the other emoji below it, grouped as Unicode groups them, recently used first, search
 * by name. The chosen emoji font draws the keyboard and goes onto the emoji inserted. Touch-sized on
 * touch screens, where it stays open after a pick (the iPad's emoji keyboard). Loaded on first use
 * (its data is ~70 kB: emojidata.ts, generated from Unicode's emoji-test.txt).
 */
import { EMOJI_FONTS, type EmojiFont } from '@overlyx/core';
import { EMOJI_DATA } from './emojidata';
import { emojiSample, loadEmojiFonts } from './emojimenu';
import './emoji.css';

export interface EmojiTarget {
  /** insert the emoji at the cursor, in `face` (null: the device's own emoji) */
  insert(emoji: string, face: string | null): void;
  /** Make an emoji…: the made picture (PNG) is saved into the project and inserted at text size; absent: not offered */
  insertPicture?(png: Blob, name: string): Promise<void>;
  /** back to the text after the keyboard closes */
  focus?(): void;
}

interface Row { e: string; name: string; v: string[] }
const GROUP_ICONS: Record<string, string> = {
  'Smileys & Emotion': '😀', 'People & Body': '👋', 'Animals & Nature': '🐻', 'Food & Drink': '🍔', 'Travel & Places': '🚗',
  Activities: '⚽', Objects: '💡', Symbols: '❤️', Flags: '🏁',
};
const RECENT_KEY = 'ol.emojiRecent', FONT_KEY = 'ol.emojiFont';
const store = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string): void { try { localStorage.setItem(k, v); } catch { /* private window */ } },
};

let groups: { name: string; rows: Row[] }[] | null = null;
function data(): { name: string; rows: Row[] }[] {
  return (groups ??= EMOJI_DATA.map(([name, text]) => ({
    name,
    rows: text.split('\n').map(line => { const [e, n, v] = line.split('\t'); return { e, name: n, v: v ? v.split(' ') : [] }; }),
  })));
}
/** every emoji (and variant) → its row: recent ones are shown with their row */
let rowOf: Map<string, Row> | null = null;
const rowFor = (e: string) => (rowOf ??= new Map(data().flatMap(g => g.rows.flatMap(r => [[r.e, r] as [string, Row], ...r.v.map(v => [v, r] as [string, Row])])))).get(e);

export const recentEmoji = (): string[] => { try { return JSON.parse(store.get(RECENT_KEY) ?? '[]').filter((x: unknown) => typeof x === 'string').slice(0, 24); } catch { return []; } };
function remember(e: string): void { store.set(RECENT_KEY, JSON.stringify([e, ...recentEmoji().filter(x => x !== e)].slice(0, 24))); }

/** rows whose name has every word of the query (or the emoji itself) */
export function searchEmoji(q: string, limit = 200): Row[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const out: Row[] = [];
  for (const g of data()) for (const r of g.rows) {
    if (words.every(w => r.name.includes(w)) || r.e === q.trim() || r.v.includes(q.trim())) { out.push(r); if (out.length >= limit) return out; }
  }
  return out;
}

let openBox: HTMLElement | null = null;
let closeOpen: (() => void) | null = null;
export const closeEmojiPicker = () => closeOpen?.();

export function openEmojiPicker(target: EmojiTarget, at?: { x: number; y: number }): void {
  closeEmojiPicker();
  loadEmojiFonts();
  const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  let font: EmojiFont = EMOJI_FONTS.find(f => (f.face ?? '') === (store.get(FONT_KEY) ?? '')) ?? EMOJI_FONTS[0];

  const box = document.createElement('div');
  box.className = 'emoji-kbd';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'Emoji');
  const head = document.createElement('div'); head.className = 'emoji-kbd-head';
  const search = document.createElement('input');
  search.type = 'search'; search.placeholder = 'Search emoji'; search.setAttribute('aria-label', 'Search emoji');
  const fontSel = document.createElement('select');
  fontSel.title = 'Emoji font (also for the emoji you insert)';
  for (const f of EMOJI_FONTS) { const o = document.createElement('option'); o.value = f.face ?? ''; o.textContent = f.label; fontSel.appendChild(o); }
  fontSel.value = font.face ?? '';
  const close = document.createElement('button'); close.type = 'button'; close.textContent = '✕'; close.title = 'Close (Esc)'; close.setAttribute('aria-label', 'Close');
  head.append(search, fontSel, close);
  const cats = document.createElement('div'); cats.className = 'emoji-kbd-cats';
  const list = document.createElement('div'); list.className = 'emoji-kbd-list';
  const foot = document.createElement('div'); foot.className = 'emoji-kbd-foot';
  const note = document.createElement('span'); note.className = 'note';
  const make = document.createElement('button'); make.type = 'button'; make.textContent = 'Make an emoji…';
  foot.append(note);
  if (target.insertPicture) foot.append(make);
  box.append(head, cats, list, foot);

  const pick = (e: string) => {
    remember(e);
    target.insert(e, font.face);
    if (!touch) done();
  };
  const rowEl = (r: Row): HTMLElement => {
    const el = document.createElement('div');
    el.className = 'emoji-kbd-row' + (r.v.length ? ' has-variants' : '');
    for (const e of [r.e, ...r.v]) {
      const b = emojiSample(e, font, 'button') as HTMLButtonElement;
      b.type = 'button'; b.title = r.name; b.dataset.emoji = e;
      el.appendChild(b);
    }
    const n = document.createElement('span'); n.className = 'emoji-name'; n.textContent = r.name;
    el.appendChild(n);
    return el;
  };
  const groupEl = (name: string, rows: Row[], id?: string): HTMLElement => {
    const g = document.createElement('section'); g.className = 'emoji-kbd-group';
    if (id) g.dataset.group = id;
    const h = document.createElement('h4'); h.textContent = name;
    g.appendChild(h);
    for (const r of rows) g.appendChild(rowEl(r));
    return g;
  };
  const renderAll = () => {
    list.replaceChildren();
    const recent = recentEmoji().map(e => rowFor(e)).filter((r, i, a): r is Row => !!r && a.indexOf(r) === i);
    if (recent.length) list.appendChild(groupEl('Recently used', recent, 'recent'));
    for (const g of data()) list.appendChild(groupEl(g.name, g.rows, g.name));
  };
  const renderSearch = () => {
    const q = search.value.trim();
    if (!q) { renderAll(); return; }
    const rows = searchEmoji(q);
    list.replaceChildren(rows.length ? groupEl(`${rows.length >= 200 ? '200+' : rows.length} found`, rows) : Object.assign(document.createElement('div'), { className: 'emoji-kbd-empty', textContent: 'No emoji by that name' }));
    list.scrollTop = 0;
  };
  const renderCats = () => {
    cats.replaceChildren();
    const entries: [string, string, string][] = [['recent', '🕘', 'Recently used'], ...data().map(g => [g.name, GROUP_ICONS[g.name] ?? g.rows[0].e, g.name] as [string, string, string])];
    for (const [id, icon, title] of entries) {
      const b = emojiSample(icon, font, 'button') as HTMLButtonElement;
      b.className = ''; b.type = 'button'; b.title = title; b.setAttribute('aria-label', title);
      b.addEventListener('click', () => {
        if (search.value) { search.value = ''; renderAll(); }
        list.querySelector<HTMLElement>(`[data-group="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'start' });
      });
      cats.appendChild(b);
    }
  };
  const renderNote = () => { note.textContent = font.licence ? `${font.label} · ${font.licence}` : 'Emoji as your device draws them'; };

  list.addEventListener('click', ev => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('button[data-emoji]');
    if (b) { ev.preventDefault(); pick(b.dataset.emoji!); }
  });
  list.addEventListener('mousedown', ev => { if ((ev.target as HTMLElement).closest('button')) ev.preventDefault(); });
  search.addEventListener('input', renderSearch);
  search.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') { const first = list.querySelector<HTMLElement>('button[data-emoji]'); if (first) { ev.preventDefault(); pick(first.dataset.emoji!); } }
  });
  fontSel.addEventListener('change', () => {
    font = EMOJI_FONTS.find(f => (f.face ?? '') === fontSel.value) ?? EMOJI_FONTS[0];
    store.set(FONT_KEY, font.face ?? '');
    renderCats(); renderSearch(); renderNote();
  });
  close.addEventListener('click', () => done());
  make.addEventListener('click', () => {
    void import('./make').then(m => m.showMakeEmoji(box, list, foot, font, target, () => done()));
  });

  const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); done(); } };
  const onDown = (ev: PointerEvent) => { if (!box.contains(ev.target as Node)) done(false); };
  function done(refocus = true): void {
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onDown, true);
    box.remove();
    if (openBox === box) { openBox = null; closeOpen = null; }
    if (refocus) target.focus?.();
  }
  closeOpen = () => done(false);
  openBox = box;

  renderCats(); renderAll(); renderNote();
  document.body.appendChild(box);
  // beside the caret where it fits, else in the middle of the window
  const r = box.getBoundingClientRect(), vw = window.innerWidth, vh = window.innerHeight;
  let x = at ? at.x : (vw - r.width) / 2, y = at ? at.y + 8 : (vh - r.height) / 2;
  if (x + r.width > vw - 8) x = vw - r.width - 8;
  if (y + r.height > vh - 8) y = at && at.y - r.height - 8 >= 8 ? at.y - r.height - 8 : Math.max(8, vh - r.height - 8);
  box.style.left = Math.max(8, x) + 'px'; box.style.top = Math.max(8, y) + 'px';
  setTimeout(() => {
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown, true);
  }, 0);
  if (!touch) search.focus();
}

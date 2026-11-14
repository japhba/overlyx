/**
 * The slide list's selection (the rail and the slide sorter of a deck): several slides selected —
 * Shift+click a range, Ctrl/⌘+click single ones — and everything the list does to one slide done to
 * all of them as one change (slideops.ts): dragged together, deleted, duplicated, skipped, moved a
 * place, cut, copied and pasted — in this deck or another one (slideclip.ts; the system clipboard
 * carries them). The deck editor (DeliverableEditor.tsx) owns the frames and the text; this is the
 * list's logic, its keys and its menu.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { projectOfDoc } from '@overlyx/core';
import type { MenuItem } from '../editor/contextmenu';
import { fileUrl } from '../api';
import type { HtmlOp, ToRuntime } from './protocol';
import { pickSlide, clampSel, moveSlidesOps, stepSlidesOps, removeSlidesOps, duplicateSlidesOps, skipSlidesOps, type SlidePick } from './slideops';
import { slidesClip, readSlidesClip, hasSlidesClip, pastePlan, pasteOps, withAssets, joinPath, type SlidesClip } from './slideclip';

export interface SlideListDeps {
  text(): string;
  readOnly(): boolean;
  /** operations on the deck's text, as the editor makes them (undo, suggestions, the master's follow-ups) */
  applyOps(ops: HtmlOp[]): boolean;
  /** the canvas goes to slide `i` */
  show(i: number): void;
  /** a message for the slide list's frame */
  toList(msg: ToRuntime): void;
  notify(text: string, kind?: 'error'): void;
  /** this deck: its document id (a host without ids: its path), its folder (project-relative) */
  deck: string;
  dir: string;
  /** the deck's document id when files of other decks can be read from here (the web app) */
  docId?: string;
  /** a file put into the deck's folder: the address the page names it by (null: it could not be) */
  upload(f: { name: string; type: string; data: Blob }, sub?: string): Promise<string | null>;
  /** which of the slides are skipped */
  skipped(i: number): boolean;
  /** the slide sorter closes (the slide shown: on the canvas) */
  closeGrid?(): void;
}

export interface SlideKey { key: string; ctrl: boolean; meta: boolean; shift: boolean; alt: boolean }

/** this tab's last copy of slides: pasted from a menu when the browser keeps the clipboard from the page */
let lastCopied: { html: string; plain: string } | null = null;
/** a copy made without a clipboard event of its own (a menu, a key pressed inside the list's frame): the next copy event carries it */
let pendingCopy: { html: string; plain: string } | null = null;
let listening = false;
function listen(): void {
  if (listening || typeof document === 'undefined') return;
  listening = true;
  document.addEventListener('copy', e => {
    const c = pendingCopy;
    if (!c || !e.clipboardData) return;
    pendingCopy = null;
    e.clipboardData.setData('text/html', c.html);
    e.clipboardData.setData('text/plain', c.plain);
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);
}
/** pictures copied into a deck already (old deck and address → the new address): a second paste names the same file */
const copiedAssets = new Map<string, string>();

const many = (k: number) => `${k} slide${k === 1 ? '' : 's'}`;

export function useSlideList(current: number, n: number, deps: SlideListDeps) {
  const [sel, setSelState] = useState<number[]>([]);
  const selRef = useRef(sel);
  const anchor = useRef(current);
  const d = useRef(deps); d.current = deps;
  const cur = useRef(current); cur.current = current;
  const count = useRef(n); count.current = n;
  /** the list is a grid (the slide sorter): ↑ / ↓ go a row */
  const grid = useRef(false);
  const setSel = (s: number[]) => { if (s.join() !== selRef.current.join()) { selRef.current = s; setSelState(s); } };
  // the slide shown is one of the selected; shown by other means (the canvas, Page Down), it is selected alone
  useEffect(() => { if (!selRef.current.includes(current)) { anchor.current = current; setSel(clampSel([current], current, n)); } }, [current]);
  useEffect(() => { setSel(clampSel(selRef.current, cur.current, n)); }, [n]);
  useEffect(() => { d.current.toList({ ol: 'current', slide: current, sel }); }, [current, sel.join()]);
  useEffect(listen, []);

  /** the slides a command on slide `i` is for: the selection when `i` is one of it, else `i` alone */
  const of = (i: number): number[] => (selRef.current.length > 1 && selRef.current.includes(i) ? selRef.current : [i]);
  /** after a change of the deck: these slides selected, this one shown (once the canvas has the new text) */
  const settle = (s: number[], show: number) => setTimeout(() => { anchor.current = show; selRef.current = s; setSelState(s); d.current.show(show); }, 150);
  const pick = (i: number, how: SlidePick) => {
    const s = pickSlide({ sel: selRef.current.length ? selRef.current : [cur.current], anchor: anchor.current, current: cur.current }, i, how, count.current);
    anchor.current = s.anchor;
    setSel(s.sel);
    d.current.show(s.current);
  };
  /** the slide sorter: the slide shown opened (the sorter closes) */
  const open = () => { if (grid.current) d.current.closeGrid?.(); };
  const guard = () => { if (d.current.readOnly()) { d.current.notify('You can only view this page.', 'error'); return false; } return true; };

  const remove = (i: number, quiet = false): boolean => {
    if (!guard()) return false;
    const p = of(i);
    const ops = removeSlidesOps(d.current.text(), p);
    if (!ops) { d.current.notify(count.current <= 1 ? 'A deck keeps at least one slide.' : 'A deck keeps at least one slide: not all of them can be deleted.'); return false; }
    if (!d.current.applyOps(ops)) return false;
    if (!quiet) d.current.notify(p.length === 1 ? `Slide ${p[0] + 1} deleted — Ctrl+Z brings it back.` : `${many(p.length)} deleted — Ctrl+Z brings them back.`);
    const next = Math.max(0, Math.min(p[0], count.current - p.length - 1));
    settle([next], next);
    return true;
  };
  const duplicate = (i: number) => {
    if (!guard()) return;
    const r = duplicateSlidesOps(d.current.text(), of(i));
    if (r && d.current.applyOps(r.ops)) settle(r.sel, r.sel[0]);
  };
  const skip = (i: number) => {
    if (!guard()) return;
    const p = of(i);
    const r = skipSlidesOps(d.current.text(), p);
    if (!r || !r.ops.length || !d.current.applyOps(r.ops) || !r.on) return;
    d.current.notify(p.length === 1 ? `Slide ${p[0] + 1} is skipped: it is not presented or printed. Skip slide again brings it back.` : `${many(p.length)} are skipped: they are not presented or printed. Skip slide again brings them back.`);
  };
  /** moved: to before slide `to`, or a place up / down */
  const moved = (r: { ops: HtmlOp[]; sel: number[] } | null, shown: number, was: number[]) => {
    if (!r || !r.ops.length || !d.current.applyOps(r.ops)) return;
    // (the slide shown stays the one shown, where it is now)
    const k = was.indexOf(shown);
    settle(r.sel, r.sel[k < 0 ? 0 : k]);
  };
  const drop = (from: number, to: number) => { if (guard()) { const p = of(from); moved(moveSlidesOps(d.current.text(), p, to), from, p); } };
  const step = (i: number, dir: -1 | 1) => { if (guard()) { const p = of(i); moved(stepSlidesOps(d.current.text(), p, dir), i, p); } };
  const canStep = (i: number, dir: -1 | 1) => !!stepSlidesOps(d.current.text(), of(i), dir)?.ops.length;

  /* ------------------------------------------------------------- the clipboard */

  const clipOf = (i: number) => slidesClip(d.current.text(), of(i), { deck: d.current.deck, dir: d.current.dir });
  /** Copy / Cut from a menu or a key of the list's frame: the browser's copy command, else its clipboard interface */
  const copy = (i: number, cut = false) => {
    if (cut && !guard()) return;
    const c = clipOf(i);
    if (!c) return;
    lastCopied = c;
    pendingCopy = c;
    let done = false;
    try { done = document.execCommand('copy'); } catch { done = false; }
    if (pendingCopy) { pendingCopy = null; done = false; }
    if (!done) {
      const write = navigator.clipboard?.write?.bind(navigator.clipboard);
      if (write && typeof ClipboardItem !== 'undefined') void write([new ClipboardItem({ 'text/html': new Blob([c.html], { type: 'text/html' }), 'text/plain': new Blob([c.plain], { type: 'text/plain' }) })]).catch(() => { /* this tab still has them (lastCopied) */ });
    }
    const k = c.clip.slides.length;
    if (cut) { if (remove(i, true)) d.current.notify(`${many(k)} cut — Ctrl+V pastes ${k === 1 ? 'it' : 'them'} after the slide shown, in this deck or another one.`); }
    else d.current.notify(`${many(k)} copied — Ctrl+V pastes ${k === 1 ? 'it' : 'them'} after the slide shown, in this deck or another one.`);
  };
  /** Ctrl+C / Ctrl+X as the browser's event (the keyboard is in the editor): filled here */
  const copyEvent = (e: ClipboardEvent, cut: boolean): boolean => {
    if (!e.clipboardData || (cut && d.current.readOnly())) return false;
    const c = clipOf(cur.current);
    if (!c) return false;
    lastCopied = c;
    e.preventDefault();
    e.clipboardData.setData('text/html', c.html);
    e.clipboardData.setData('text/plain', c.plain);
    if (cut) remove(cur.current, true);
    return true;
  };
  /** a file of the deck the slides come from, copied into this deck's folder: its address here (null: not possible) */
  const bring = async (clip: SlidesClip, rel: string): Promise<string | null> => {
    const key = `${d.current.deck}\n${clip.deck}\n${rel}`;
    const had = copiedAssets.get(key);
    if (had) return had;
    const from = joinPath(clip.dir, rel);
    if (!d.current.docId || from === null || clip.deck.split('/').length < 3) return null;
    try {
      const res = await fetch(fileUrl(projectOfDoc(clip.deck), from), { credentials: 'same-origin' });
      if (!res.ok) return null;
      const blob = await res.blob();
      const parts = rel.split(/[?#]/)[0].split('/').filter(s => s && s !== '.' && s !== '..');
      const name = decodeURI(parts[parts.length - 1] ?? 'picture');
      const sub = parts.length > 1 && /^[\w-]+$/.test(parts[parts.length - 2]) ? parts[parts.length - 2] : 'images';
      const now = await d.current.upload({ name, type: blob.type, data: blob }, sub);
      if (now) copiedAssets.set(key, now);
      return now;
    } catch { return null; }
  };
  /** the clipboard's slides after the slide shown (false: it carries none) */
  const paste = async (html: string): Promise<boolean> => {
    const clip = readSlidesClip(html);
    if (!clip) return false;
    if (!guard()) return true;
    const plan = pastePlan(d.current.text(), clip, d.current.deck, cur.current);
    let slides = plan.slides, missed = 0;
    if (plan.assets.length) {
      const map: Record<string, string> = {};
      for (const rel of plan.assets) { const now = await bring(clip, rel); if (now) map[rel] = now; else missed++; }
      slides = slides.map(s => withAssets(s, map));
    }
    // (the pictures took a moment: the deck as it is now)
    const r = pasteOps(d.current.text(), cur.current, slides, plan.style);
    if (!r || !d.current.applyOps(r.ops)) return true;
    settle(r.sel, r.sel[0]);
    const k = slides.length;
    if (missed) d.current.notify(`${many(k)} pasted, but ${missed} picture${missed === 1 ? '' : 's'} could not be copied from the other deck: put ${missed === 1 ? 'it' : 'them'} into this deck again.`, 'error');
    else if (plan.foreign) d.current.notify(`${many(k)} pasted from another deck, in this deck’s look${plan.assets.length ? ` — ${plan.assets.length} picture${plan.assets.length === 1 ? '' : 's'} copied into this deck’s folder` : ''}.`);
    return true;
  };
  /** Paste from a menu or a key of the list's frame: the clipboard read (the browser may ask), else this tab's last copy */
  const pasteClipboard = () => {
    if (!guard()) return;
    const mine = () => { if (lastCopied) void paste(lastCopied.html); else d.current.notify(`Press ${/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘V' : 'Ctrl+V'} to paste slides here.`); };
    if (!navigator.clipboard?.read) { mine(); return; }
    void navigator.clipboard.read().then(async items => {
      for (const it of items) if (it.types.includes('text/html')) { const html = await (await it.getType('text/html')).text(); if (await paste(html)) return; }
      mine();
    }).catch(mine);
  };

  /* ------------------------------------------------------------- keys and the menu */

  /**
   * The list's keys. `inFrame`: pressed inside the list's frame (its copy and paste are done here);
   * pressed in the editor, Ctrl+C / X / V come as the browser's clipboard events (copyEvent, paste).
   */
  const key = (k: SlideKey, inFrame: boolean): boolean => {
    const mod = k.ctrl || k.meta, i = cur.current, total = count.current, ro = d.current.readOnly();
    const low = k.key.toLowerCase();
    if (!mod) {
      const dir = k.key === 'ArrowUp' || k.key === 'ArrowLeft' ? -1 : k.key === 'ArrowDown' || k.key === 'ArrowRight' ? 1 : 0;
      if (dir) {
        if (grid.current && (k.key === 'ArrowUp' || k.key === 'ArrowDown')) d.current.toList({ ol: 'railRow', dir, shift: k.shift });
        else pick(i + dir, k.shift ? 'range' : 'one');
        return true;
      }
      if (k.key === 'Home' || k.key === 'End') { pick(k.key === 'Home' ? 0 : total - 1, k.shift ? 'range' : 'one'); return true; }
      if (k.shift) return false;
      if (k.key === 'Delete' || k.key === 'Backspace') { if (!ro) remove(i); return true; }
      if (k.key === 'Escape' && selRef.current.length > 1) { anchor.current = i; setSel([i]); return true; }
      // (the slide sorter: Enter opens the slide shown, Esc goes back to it)
      if (grid.current && (k.key === 'Enter' || k.key === 'Escape')) { open(); return true; }
      return false;
    }
    if (k.shift) return false;
    if (low === 'a') { const all = Array.from({ length: total }, (_, j) => j); setSel(all); return true; }
    if (low === 'c' || low === 'x' || low === 'v') {
      if (!inFrame) return false;
      if (low === 'v') pasteClipboard(); else copy(i, low === 'x');
      return true;
    }
    if (ro) return false;
    if (low === 'd') { duplicate(i); return true; }
    if (k.key === 'ArrowUp' || k.key === 'ArrowDown') { step(i, k.key === 'ArrowUp' ? -1 : 1); return true; }
    return false;
  };

  /** Cut, Copy, Paste for slide `i` (or the selection it is one of) */
  const clipItems = (i: number): MenuItem[] => {
    const ro = d.current.readOnly(), k = of(i).length;
    return [
      { label: k > 1 ? `Cut ${many(k)}` : 'Cut slide', shortcut: 'Ctrl+X', disabled: ro || count.current <= k, action: () => copy(i, true) },
      { label: k > 1 ? `Copy ${many(k)}` : 'Copy slide', shortcut: 'Ctrl+C', action: () => copy(i) },
      { label: 'Paste slides', shortcut: 'Ctrl+V', disabled: ro, action: pasteClipboard },
    ];
  };
  /** the list's menu for several selected slides (one slide: the editor's own menu, with clipItems) */
  const menu = (i: number): MenuItem[] => {
    const ro = d.current.readOnly(), p = of(i), k = p.length;
    return [
      { label: `Duplicate ${many(k)}`, shortcut: 'Ctrl+D', disabled: ro, action: () => duplicate(i) },
      { label: `Skip ${many(k)} (not presented)`, checked: p.every(j => d.current.skipped(j)), disabled: ro, action: () => skip(i) },
      { sep: true },
      ...clipItems(i),
      { sep: true },
      { label: 'Move up', shortcut: 'Ctrl+↑', disabled: ro || !canStep(i, -1), action: () => step(i, -1) },
      { label: 'Move down', shortcut: 'Ctrl+↓', disabled: ro || !canStep(i, 1), action: () => step(i, 1) },
      { sep: true },
      { label: `Delete ${many(k)}`, shortcut: 'Del', disabled: ro || count.current <= k, action: () => { remove(i); } },
    ];
  };

  return { sel, of, pick, open, remove, duplicate, skip, step, canStep, drop, copy, copyEvent, paste, pasteClipboard, key, clipItems, menu, grid, hasSlidesClip };
}
export type SlideList = ReturnType<typeof useSlideList>;

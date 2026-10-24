/**
 * "Annotations in the margin" mode: Note / Comment / Greyed-out insets are positioned in the
 * notes & comments pane right of the text (the document pane's split, app/notespane.tsx) instead
 * of inline. The inset DOM stays where ProseMirror put it (so editing/collaboration keep working);
 * we only move it visually with absolute positioning and stack the cards so they do not overlap.
 * Without the margin, a comment thread is a chip in the text and its card opens as a popover under
 * the chip while the cursor is in it (`cm-active`, plugins/commentui.ts): placed here too, kept
 * inside the text column.
 */
import { Plugin, PluginKey } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { documentViewScale } from '../viewscale';

export const marginKey = new PluginKey<boolean>('lyx-margin');

export function marginPlugin(initial = false): Plugin<boolean> {
  let raf = 0;
  let observer: ResizeObserver | null = null;
  const schedule = (view: EditorView) => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => layout(view));
  };
  return new Plugin<boolean>({
    key: marginKey,
    state: {
      init: () => initial,
      apply: (tr, prev) => (tr.getMeta(marginKey) !== undefined ? tr.getMeta(marginKey) : prev),
    },
    view(view) {
      const root = view.dom.parentElement!;
      root.classList.toggle('margin-mode', marginKey.getState(view.state) ?? false);
      observer = new ResizeObserver(() => schedule(view));
      observer.observe(view.dom);
      observer.observe(root);   // the split moved: the text column may keep its width, the cards move anyway
      const onResize = () => schedule(view);
      window.addEventListener('resize', onResize);
      schedule(view);
      return {
        update: (v, prevState) => {
          const on = marginKey.getState(v.state) ?? false;
          root.classList.toggle('margin-mode', on);
          // an open comment card follows its chip (and goes when the cursor leaves the thread)
          const popover = !!v.dom.querySelector('.lyx-inset-note-comment.cm-active, .lyx-inset-note-comment.cm-placed');
          if (on || marginKey.getState(prevState) || popover) schedule(v);
        },
        destroy: () => { observer?.disconnect(); cancelAnimationFrame(raf); window.removeEventListener('resize', onResize); },
      };
    },
  });
}

/** cards keep 16px from the pane's edges and grow with it up to 560px */
const PANE_PAD = 16, CARD_MAX = 560;

export function isMarginNote(el: Element): boolean {
  return el.classList.contains('lyx-inset-note');
}

/** Position all note cards in the margin column, stacked without overlap. */
export function layout(view: EditorView): void {
  const root = view.dom.parentElement;
  if (!root) return;   // the editor was torn down before a scheduled layout ran
  const on = marginKey.getState(view.state) ?? false;
  const cards = Array.from(view.dom.querySelectorAll<HTMLElement>(':scope .lyx-inset-note'));
  // only top-level notes (notes nested in notes stay inline in their parent card); resolved comment
  // threads only when shown (the editor's show-resolved: the notes pane's switch, View ▸ Resolved comments)
  const showResolved = view.dom.classList.contains('show-resolved');
  const top = cards.filter(c => !c.parentElement?.closest('.lyx-inset-note') && (showResolved || !c.classList.contains('resolved')));
  if (!on) {
    for (const c of cards) {
      c.classList.remove('in-margin');
      const b = c.querySelector<HTMLElement>(':scope > .inset-box');
      if (!b) continue;
      if (c.classList.contains('cm-active') && (showResolved || !c.classList.contains('resolved'))) placePopover(view, c, b);
      else if (c.classList.contains('cm-placed')) { c.classList.remove('cm-placed'); b.style.top = ''; b.style.left = ''; b.style.width = ''; }
      else { b.style.top = ''; b.style.left = ''; b.style.width = ''; }
    }
    return;
  }
  // the notes pane: the right part of the page, --notes-col wide (inside ink mode's gutter: the page is
  // wider than the scroll pane by one on each side); without one (a layout page, a host that does not
  // split) the cards go just right of the text column
  const page = root.closest('.editor-page') as HTMLElement | null;
  const scroll = root.closest('.editor-scroll') as HTMLElement | null;
  const scale = documentViewScale(root);
  const paneWidth = page ? parseFloat(getComputedStyle(page).getPropertyValue('--notes-col')) : NaN;
  let columnLeft: number, cardWidth: number;
  if (page && paneWidth > 0 && !view.dom.classList.contains('ol-layout')) {
    const gutter = scroll ? Math.max(0, (page.offsetWidth - scroll.clientWidth) / 2) : 0;
    const paneRight = page.getBoundingClientRect().right - gutter * scale;
    columnLeft = paneRight - (paneWidth - PANE_PAD) * scale;
    cardWidth = Math.max(120, Math.min(CARD_MAX, paneWidth - 2 * PANE_PAD));
  } else {
    columnLeft = view.dom.getBoundingClientRect().right + 28 * scale;
    cardWidth = 320;
  }
  // cards in folded-away sections (plugins/fold.ts) have no box: they must not push the others down
  const items = top.filter(c => c.getClientRects().length > 0).map(c => {
    const anchor = c.querySelector<HTMLElement>(':scope > .inset-anchor') ?? c;
    return { el: c, anchorTop: anchor.getBoundingClientRect().top };
  }).sort((a, b) => a.anchorTop - b.anchorTop);
  // the pane's switch for resolved threads sits at its top: the cards start below it
  const toggle = page?.querySelector<HTMLElement>(':scope > .notes-resolved > button');
  let nextTop = toggle ? toggle.getBoundingClientRect().bottom + 8 * scale : -Infinity;
  for (const it of items) {
    it.el.classList.add('in-margin');
    const box = it.el.querySelector<HTMLElement>(':scope > .inset-box')!;
    box.style.width = cardWidth + 'px';
    // coordinates must be relative to the box's offset parent (nearest positioned ancestor)
    const op = (box.offsetParent as HTMLElement | null) ?? root;
    const opRect = op.getBoundingClientRect();
    const topV = Math.max(it.anchorTop - 2 * scale, nextTop);
    box.style.top = `${(topV - opRect.top) / scale + op.scrollTop}px`;
    box.style.left = `${(columnLeft - opRect.left) / scale}px`;
    nextTop = topV + box.getBoundingClientRect().height + 8 * scale;
  }
  for (const c of cards) if (!top.includes(c)) c.classList.remove('in-margin');
}

/** the open comment card without a margin: under its chip, as wide as fits (up to 360px), inside the text column */
function placePopover(view: EditorView, card: HTMLElement, box: HTMLElement): void {
  const chip = card.querySelector<HTMLElement>(':scope > .inset-anchor') ?? card;
  const c = chip.getBoundingClientRect();
  const col = view.dom.getBoundingClientRect();
  const scale = documentViewScale(card);
  const width = Math.max(220, Math.min(360, col.width / scale));
  card.classList.add('cm-placed');
  box.style.width = width + 'px';
  const op = (box.offsetParent as HTMLElement | null) ?? view.dom;
  const opRect = op.getBoundingClientRect();
  const left = Math.max(col.left, Math.min(c.left - 16 * scale, col.right - width * scale));
  box.style.left = `${(left - opRect.left) / scale + op.scrollLeft}px`;
  box.style.top = `${(c.bottom + 6 * scale - opRect.top) / scale + op.scrollTop}px`;
}

export function setMarginMode(view: EditorView, on: boolean): void {
  view.dispatch(view.state.tr.setMeta(marginKey, on));
}

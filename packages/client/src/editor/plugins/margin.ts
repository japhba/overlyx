/**
 * "Annotations in the margin" mode: Note / Comment / Greyed-out insets are positioned in a
 * column to the right of the text (Google-Docs style) instead of inline. The inset DOM stays
 * where ProseMirror put it (so editing/collaboration keep working); we only move it visually
 * with absolute positioning and stack the cards so they do not overlap.
 */
import { Plugin, PluginKey } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';

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
      const onResize = () => schedule(view);
      window.addEventListener('resize', onResize);
      schedule(view);
      return {
        update: (v, prevState) => {
          const on = marginKey.getState(v.state) ?? false;
          root.classList.toggle('margin-mode', on);
          if (on || marginKey.getState(prevState)) schedule(v);
        },
        destroy: () => { observer?.disconnect(); cancelAnimationFrame(raf); window.removeEventListener('resize', onResize); },
      };
    },
  });
}

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
  // threads are not shown at all (the Comments panel keeps them)
  const top = cards.filter(c => !c.parentElement?.closest('.lyx-inset-note') && !c.classList.contains('resolved'));
  if (!on) {
    ((root.closest('.editor-scroll') as HTMLElement | null) ?? root).style.removeProperty('--margin-col');
    for (const c of cards) { c.classList.remove('in-margin'); const b = c.querySelector<HTMLElement>(':scope > .inset-box'); if (b) { b.style.top = ''; b.style.left = ''; } }
    return;
  }
  // the note column is 320px wide (a `--note-width` on the page overrides that), less on a narrow
  // page (the text column keeps at least ~360px)
  const pageWidth = root.getBoundingClientRect().width;
  const wanted = parseFloat(getComputedStyle(root).getPropertyValue('--note-width')) || 320;
  const cardWidth = Math.max(160, Math.min(wanted, Math.round(pageWidth * 0.45)));
  const col = `${cardWidth + 52}px`;
  // on the scroll container, so the ruler above the page sees it too
  const holder = (root.closest('.editor-scroll') as HTMLElement | null) ?? root;
  if (holder.style.getPropertyValue('--margin-col') !== col) holder.style.setProperty('--margin-col', col);
  const columnLeft = view.dom.getBoundingClientRect().right + 28; // just right of the text column
  const items = top.map(c => {
    const anchor = c.querySelector<HTMLElement>(':scope > .inset-anchor') ?? c;
    return { el: c, anchorTop: anchor.getBoundingClientRect().top };
  }).sort((a, b) => a.anchorTop - b.anchorTop);
  let nextTop = -Infinity;
  for (const it of items) {
    it.el.classList.add('in-margin');
    const box = it.el.querySelector<HTMLElement>(':scope > .inset-box')!;
    box.style.width = cardWidth + 'px';
    // coordinates must be relative to the box's offset parent (nearest positioned ancestor)
    const op = (box.offsetParent as HTMLElement | null) ?? root;
    const opRect = op.getBoundingClientRect();
    const topV = Math.max(it.anchorTop - 2, nextTop);
    box.style.top = `${topV - opRect.top + op.scrollTop}px`;
    box.style.left = `${columnLeft - opRect.left}px`;
    nextTop = topV + box.getBoundingClientRect().height + 8;
  }
  for (const c of cards) if (!top.includes(c)) c.classList.remove('in-margin');
}

export function setMarginMode(view: EditorView, on: boolean): void {
  view.dispatch(view.state.tr.setMeta(marginKey, on));
}

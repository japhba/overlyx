/**
 * The zoom said over a view while it changes (a pinch, a wheel, − / +, a fit chosen): a pill at the top
 * of the view with the percentage as it goes, or the fit's name when it is at one (in the accent
 * colour); gone a moment after the zoom rests. The toolbars' figures catch up only once a pinch
 * rests. Every view that zooms has one: the slide canvas, the PDF viewer, a layout document's canvas,
 * a board, the document's text zoom. Written straight into the element (`.zoom-hud`, styles.css), not a
 * render per frame.
 */

/** the pill's words: "137 %", or "Fit · 64 %" at a fit */
export const zoomText = (pct: number, fit?: string | null): string => (fit ? `${fit} · ${pct} %` : `${pct} %`);

export interface ZoomPill {
  /** a zoom shown now: `scale` a factor (1: 100 %), `fit` the fit's name when it is at one */
  show(scale: number, fit?: string | null): void;
  dispose(): void;
}

/** the pill in the element `el` gives (the view's own) */
export function zoomPill(el: () => HTMLElement | null, ms = 800, label = ''): ZoomPill {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    show(scale, fit) {
      const e = el();
      if (!e) return;
      e.textContent = (label ? label + ' · ' : '') + zoomText(Math.round(scale * 100), fit);
      e.classList.toggle('fit', !!fit);
      e.classList.add('on');
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; e.classList.remove('on'); }, ms);
    },
    dispose() { if (timer) clearTimeout(timer); timer = null; },
  };
}

/**
 * A pill of its own for a view outside Preact (a layout document's canvas, the text): on the page
 * (fixed, in <body>, as the view may scroll), at the top centre of the element `host` gives.
 */
const activeHostedPills = new WeakMap<HTMLElement, HTMLElement>();

export function hostedZoomPill(host: () => HTMLElement | null, attr: string, label = ''): ZoomPill {
  let made: HTMLElement | null = null;
  const pill = zoomPill(() => {
    const h = host();
    if (!h || !h.isConnected) return null;
    if (!made) {
      made = document.createElement('div');
      made.className = 'zoom-hud fixed';
      made.setAttribute('aria-hidden', 'true');
      made.setAttribute(attr, '');
      document.body.appendChild(made);
    }
    const previous = activeHostedPills.get(h);
    if (previous !== made) previous?.classList.remove('on');
    activeHostedPills.set(h, made);
    const r = h.getBoundingClientRect();
    made.style.left = `${r.left + r.width / 2}px`;
    made.style.top = `${r.top + 14}px`;
    return made;
  }, 800, label);
  return { show: pill.show, dispose() { pill.dispose(); made?.remove(); made = null; } };
}

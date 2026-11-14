/**
 * A deck's slides or a poster as pictures, and what is made of those pictures: handouts and notes
 * pages (a PDF), a PowerPoint file. Rendered like the PDF export (render.ts: the sandboxed headless
 * Chromium, the page in print mode — skipped slides and suggested deletions left out, every click
 * step shown), one screenshot a slide.
 *
 * The sizes are bounded for this small server (core html/exportsize.ts) and these exports run one at
 * a time: a picture is held uncompressed while it is drawn.
 */
import type { Page } from 'playwright-core';
import { RENDER_ORIGIN, withPage, pageReport } from './render.ts';
import { maxPictureScale, type HandoutPaper, type HandoutPerPage } from '@overlyx/core/html/exportsize.ts';
import { handoutHtml } from '@overlyx/core/html/handout.ts';

/** what the person asked for cannot be made (said to them as it is), as opposed to a failure of the renderer */
export class ExportError extends Error {}

export interface SlideShot {
  /** the slide's place in the deck as the editor counts (skipped slides too), from 0 */
  index: number;
  title: string;
  /** the speaker notes (plain text) */
  notes: string;
  image: Buffer;
}
export interface DeckShots {
  kind: 'deck' | 'poster';
  /** the deck's title */
  title: string;
  /** a slide's size (CSS px) and the pictures' pixels per CSS pixel */
  width: number; height: number; scale: number;
  jpeg: boolean;
  shots: SlideShot[];
}

interface ShotOptions {
  /** picture pixels per CSS pixel */
  scale: number;
  /** a factor chosen here, not by the person: lowered to what the server renders instead of refusing */
  fit?: boolean;
  /** only this slide (the editor's index) — also when it is skipped */
  slide?: number;
  /** JPEG (photographs of slides inside a PDF) instead of PNG */
  jpeg?: boolean;
  reach?: string;
}

let last: Promise<unknown> = Promise.resolve();
/** one export at a time */
function inTurn<T>(f: () => Promise<T>): Promise<T> {
  const r = last.then(f, f);
  last = r.catch(() => undefined);
  return r;
}

async function shoot<T>(project: string, rel: string, userId: number, o: ShotOptions, after: (page: Page, deck: DeckShots) => Promise<T>): Promise<T> {
  let scale = Math.min(8, Math.max(0.1, o.scale));
  for (let attempt = 0; ; attempt++) {
    const r = await withPage<{ again: number } | { value: T }>(project, rel, userId, 'print', { width: 1280, height: 900 }, scale, async (_ctx, page) => {
      const rep = await pageReport(page);
      if (rep.kind === 'page') throw new ExportError('A web page has no slides: only decks and posters export as pictures.');
      // (nothing named inside: the server runs under tsx, whose helper for function names the page does not have)
      const found = await page.evaluate((only: number | null) => {
        const all = Array.from(document.querySelectorAll<HTMLElement>('.slide')).filter(s => !s.parentElement?.closest('.slide'));
        const out: { n: number; index: number; title: string; notes: string; w: number; h: number }[] = [];
        for (let i = 0; i < all.length; i++) {
          const s = all[i];
          if (only !== null) {
            if (i !== only) continue;
            s.removeAttribute('data-ol-skip'); s.removeAttribute('data-ol-del');
          } else if (s.hasAttribute('data-ol-skip') || s.hasAttribute('data-ol-del')) continue;
          if (!s.offsetWidth || !s.offsetHeight) continue;
          s.setAttribute('data-ol-shot', String(out.length));
          out.push({
            n: out.length, index: i, w: s.offsetWidth, h: s.offsetHeight,
            title: (s.querySelector('h1, h2, h3')?.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 200),
            notes: (s.querySelector(':scope > aside.notes, :scope > .notes')?.textContent ?? '').trim(),
          });
        }
        return { title: document.title.trim(), slides: out };
      }, o.slide ?? null);
      if (!found.slides.length) throw new ExportError(o.slide === undefined ? 'There is no slide to export.' : 'That slide is not there any more.');
      const width = Math.max(...found.slides.map(s => s.w)), height = Math.max(...found.slides.map(s => s.h));
      const most = maxPictureScale({ width, height }, found.slides.length);
      if (scale > most * 1.01) {
        if (o.fit && attempt === 0) return { again: most };
        throw new ExportError(`Pictures that large are more than this server renders (at most ${Math.round(width * most)} × ${Math.round(height * most)} pixels here).`);
      }
      const shots: SlideShot[] = [];
      for (const s of found.slides) {
        const image = await page.locator(`[data-ol-shot="${s.n}"]`).screenshot(o.jpeg ? { animations: 'disabled', type: 'jpeg', quality: 88 } : { animations: 'disabled', type: 'png' });
        shots.push({ index: s.index, title: s.title, notes: s.notes, image });
      }
      return { value: await after(page, { kind: rep.kind === 'poster' ? 'poster' : 'deck', title: found.title, width, height, scale, jpeg: !!o.jpeg, shots }) };
    }, o.reach ?? '');
    if ('again' in r) { scale = r.again; continue; }
    return r.value;
  }
}

/** The slides (or the one slide, or the poster) as pictures. */
export function deliverableShots(project: string, rel: string, userId: number, o: ShotOptions): Promise<DeckShots> {
  return inTurn(() => shoot(project, rel, userId, o, async (_page, deck) => deck));
}

/**
 * Handouts (1, 2, 3, 4 or 6 slides a page; 3 with lines for notes beside each) or notes pages (a
 * slide, its speaker notes under it) as a PDF on A4 or Letter. The slides are pictures at twice
 * their size (sharp in print at these sizes); the page around them is laid out here
 * (core html/handout.ts) and printed by the same browser.
 */
export function handoutPdf(project: string, rel: string, userId: number, o: { layout: 'handout' | 'notes'; per: HandoutPerPage; paper: HandoutPaper; reach?: string }): Promise<Buffer> {
  return inTurn(() => shoot(project, rel, userId, { scale: 2, fit: true, jpeg: true, reach: o.reach }, async (page, deck) => {
    const html = handoutHtml({
      title: deck.title, layout: o.layout, per: o.per, paper: o.paper, aspect: deck.width / deck.height,
      slides: deck.shots.map((s, i) => ({ src: `${RENDER_ORIGIN}/__export/${i}.jpg`, number: s.index + 1, title: s.title, notes: s.notes })),
    });
    await page.route(`${RENDER_ORIGIN}/__export/**`, async route => {
      const p = new URL(route.request().url()).pathname;
      const m = /^\/__export\/(\d+)\.jpg$/.exec(p);
      if (p === '/__export/index.html') await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
      else if (m && deck.shots[Number(m[1])]) await route.fulfill({ status: 200, contentType: 'image/jpeg', body: deck.shots[Number(m[1])].image });
      else await route.fulfill({ status: 404 });
    });
    await page.goto(`${RENDER_ORIGIN}/__export/index.html`, { waitUntil: 'load' });
    return await page.pdf({ format: o.paper === 'letter' ? 'Letter' : 'A4', printBackground: true, preferCSSPageSize: true, margin: { top: '0', right: '0', bottom: '0', left: '0' } });
  }));
}

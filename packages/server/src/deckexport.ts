/**
 * What a deck or a poster exports as besides its PDF and its website (the route
 * /api/projects/:project/deliverable-export, index.ts):
 *
 * - `what=png`: one picture — the slide `slide` (the editor's index, from 0) of a deck, or the
 *   poster — at `scale` picture pixels per CSS pixel (core html/exportsize.ts has the limits);
 * - `what=pngs`: every slide as `slide-01.png` … in a .zip;
 * - `what=handout`: handouts, `per` = 1 | 2 | 3 | 4 | 6 slides a page, `paper` = a4 | letter (PDF);
 * - `what=notes`: notes pages — a slide, its speaker notes below (PDF).
 */
import type { Response } from 'express';
import { splitProjectKey } from '@overlyx/core';
import { handoutPaper, handoutPerPage } from '@overlyx/core/html/exportsize.ts';
import { splitEntry } from './deliverables.ts';
import { deliverableShots, handoutPdf, ExportError } from './render-export.ts';
import { writeZip } from './zip.ts';

export const EXPORT_KINDS = ['png', 'pngs', 'handout', 'notes'] as const;

function send(res: Response, type: string, name: string, data: Buffer): void {
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.end(data);
}

export async function deckExport(project: string, rel: string, userId: number, q: Record<string, unknown>, res: Response): Promise<void> {
  const what = String(q.what ?? '');
  const name = (splitEntry(rel).dir.split('/').pop() || splitProjectKey(project).name).replace(/[^A-Za-z0-9._ -]+/g, '-') || 'slides';
  try {
    if (what === 'png') {
      const slide = q.slide === undefined ? undefined : Math.max(0, Math.floor(Number(q.slide)) || 0);
      const deck = await deliverableShots(project, rel, userId, { scale: Number(q.scale) || 1, slide });
      const shot = deck.shots[0];
      send(res, 'image/png', deck.kind === 'poster' || slide === undefined ? `${name}.png` : `${name}-slide-${String(shot.index + 1).padStart(2, '0')}.png`, shot.image);
    } else if (what === 'pngs') {
      const deck = await deliverableShots(project, rel, userId, { scale: Number(q.scale) || 1 });
      const digits = Math.max(2, String(deck.shots.length).length);
      // (numbered as they come in the export, skipped slides left out: 01, 02, … without gaps)
      send(res, 'application/zip', `${name}-slides.zip`, writeZip(deck.shots.map((s, i) => ({ name: `slide-${String(i + 1).padStart(digits, '0')}.png`, data: s.image, store: true }))));
    } else if (what === 'handout' || what === 'notes') {
      const pdf = await handoutPdf(project, rel, userId, { layout: what, per: handoutPerPage(q.per), paper: handoutPaper(q.paper) });
      send(res, 'application/pdf', `${name}-${what === 'notes' ? 'notes' : 'handout'}.pdf`, pdf);
    } else {
      res.status(400).json({ error: `what: ${EXPORT_KINDS.join(', ')}` });
    }
  } catch (e) {
    if (e instanceof ExportError) { res.status(400).json({ error: e.message }); return; }
    console.error('[deliverables] export', what, e);
    res.status(500).json({ error: (e as Error).message });
  }
}

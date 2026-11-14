/**
 * The editor's Check (checks.ts, ChecksPane.tsx): the report agents get from render_page (report.ts),
 * measured for people — in a frame of its own beside the editor (the slide rail's mode: every slide
 * laid out at its size), asked for when the Check pane is open and the text has rested. Nothing here
 * runs in the frame people type and draw in.
 */
import { post, state } from './env';
import { whenTypeset } from './reconcile';
import { report } from './report';
import { typesetPage } from './math';

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** fonts, formulas and pictures as they will be (no animation frames: a frame out of sight gets none) */
async function settled(): Promise<void> {
  try { await Promise.race([document.fonts?.ready, wait(4000)]); } catch { /* ignore */ }
  // (the page's own formulas first: the frame's first text is the page it was served with)
  await Promise.race([typesetPage(), wait(8000)]);
  await Promise.race([whenTypeset(), wait(6000)]);
  const imgs = Array.from(document.images).filter(i => !i.complete);
  if (imgs.length) await Promise.race([Promise.all(imgs.map(i => new Promise<void>(r => { i.addEventListener('load', () => r(), { once: true }); i.addEventListener('error', () => r(), { once: true }); }))), wait(5000)]);
  await wait(60);
}

let asked = 0;
export async function runCheck(id: number): Promise<void> {
  asked = id;
  await settled();
  // (asked again meanwhile: that one answers)
  if (asked !== id) return;
  try { const r = report(); post({ ol: 'checked', id, version: state.version, kind: r.kind, width: r.width, height: r.height, pages: r.pages }); }
  catch (e) { post({ ol: 'checked', id, version: state.version, kind: state.kind, width: 0, height: 0, pages: [], error: String((e as Error)?.message ?? e) }); }
}

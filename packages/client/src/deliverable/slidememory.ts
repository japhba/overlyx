/**
 * A deck reopens on the slide this person looked at last — in this browser or on another device:
 * the browser keeps it at once, the account a moment later (/api/docs/<id>/place); when the deck
 * opens, the newer of the two wins, as the folds do (editor/plugins/fold.ts). The web host
 * (webHost.ts) offers it to the editor; which file of a project: app/lastfile.ts.
 */
import { api } from '../api';

interface SlideRecord { slide: number; at: number }

const key = (id: string) => 'ol.slide:' + id;
/** how long the account's answer is waited for before the deck opens on this browser's */
const ASK_MS = 1500;
const PUSH_MS = 2000;

function readLocal(id: string): SlideRecord | null {
  try {
    const v = JSON.parse(localStorage.getItem(key(id)) ?? 'null');
    return v && Number.isInteger(v.slide) && v.slide >= 0 ? { slide: v.slide, at: Number(v.at) || 0 } : null;
  } catch { return null; }
}
function writeLocal(id: string, rec: SlideRecord): void {
  try { localStorage.setItem(key(id), JSON.stringify(rec)); } catch { /* private window */ }
}

/** The slide to reopen the deck on (null: the first). */
export async function lastSlide(id: string): Promise<number | null> {
  const local = readLocal(id);
  const remote = await Promise.race([api.place(id).catch(() => null), new Promise<null>(res => setTimeout(res, ASK_MS, null))]);
  if (remote && remote.slide !== null && remote.at > (local?.at ?? 0)) { writeLocal(id, { slide: remote.slide, at: remote.at }); return remote.slide; }
  if (local && remote && local.at > remote.at) api.setPlace(id, local.slide, local.at).catch(() => { /* next time */ });
  return local?.slide ?? null;
}

const pending = new Map<string, SlideRecord>();
let timer: ReturnType<typeof setTimeout> | undefined;
const push = (leaving = false) => {
  clearTimeout(timer);
  for (const [id, rec] of pending) {
    if (!leaving) { api.setPlace(id, rec.slide, rec.at).catch(() => { /* offline: the browser's copy is newer and goes up the next time */ }); continue; }
    // (the tab closes or goes to the background: a keepalive request outlives the page)
    try {
      void fetch(`/api/docs/${encodeURIComponent(id)}/place`, { method: 'PUT', keepalive: true, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rec) })
        .catch(() => { /* next time */ });
    } catch { /* ignore */ }
  }
  pending.clear();
};
let listening = false;

/** The slide looked at now: kept in the browser, sent to the account a moment later. */
export function noteSlide(id: string, slide: number): void {
  if (readLocal(id)?.slide === slide) return;
  const rec = { slide, at: Date.now() };
  writeLocal(id, rec);
  pending.set(id, rec);
  clearTimeout(timer);
  timer = setTimeout(push, PUSH_MS);
  if (!listening) {
    listening = true;
    const onHide = (e: Event) => { if (pending.size && (e.type === 'pagehide' || document.visibilityState === 'hidden')) push(true); };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onHide);
  }
}

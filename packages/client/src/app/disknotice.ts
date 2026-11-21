/**
 * The notice that the file changed outside the editor while edits made here were not saved yet, and
 * that where both changed the same place the file's version was kept — the version from here is in
 * History (server docnotices.ts, WebSocket message 8). A small card at the bottom right, never a
 * dialog: it says what happened in plain words, and "Show in History" opens History at that version
 * (where the host has History: the web app registers it with setHistoryOpener). Every editor that
 * connects to a document registers `noticeHandler` (documents editor.ts, decks webHost.ts, boards
 * BoardEditor.tsx). Plain DOM, so that it works in every host. Once the card has been on a visible
 * screen for a few seconds, or was clicked, the editor answers with the notice's id: the server does
 * not tell this person again (until then every open of the document shows it).
 */
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import './disknotice.css';

/** the WebSocket message type (server ws.ts MSG_NOTICE) */
export const MSG_NOTICE = 8;

export interface DiskNotice {
  id: number;
  doc: string;
  version: number | null;
  kind: 'disk' | 'restart' | 'stale';
  places: number | null;
  at: number;
}

let opener: ((doc: string, version: number) => void) | null = null;
/** The host can open History at a version (the web app); without one the card says where it is. */
export function setHistoryOpener(f: ((doc: string, version: number) => void) | null): void { opener = f; }

const shown = new Set<number>();

/** messageHandlers[MSG_NOTICE] of a y-websocket provider (its third argument: the provider, whose socket says "seen") */
export function noticeHandler(): (enc: unknown, dec: decoding.Decoder, provider?: unknown) => void {
  return (_enc, dec, provider) => {
    let n: DiskNotice;
    try { n = JSON.parse(decoding.readVarString(dec)) as DiskNotice; } catch { return; }
    showDiskNotice(n, () => {
      const ws = (provider as { ws?: WebSocket | null } | undefined)?.ws;
      if (!ws || ws.readyState !== 1) return;
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MSG_NOTICE);
      encoding.writeVarUint(e, n.id);
      ws.send(encoding.toUint8Array(e));
    });
  };
}

/** how long a card is on a visible screen before it counts as seen */
const SEEN_MS = 4000;

function when(t: number): string {
  const d = new Date(t), now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `today at ${time}`;
  if (d.toDateString() === new Date(now.getTime() - 86_400_000).toDateString()) return `yesterday at ${time}`;
  return `${d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })} at ${time}`;
}

/** what the card says */
export function noticeText(n: DiskNotice): { title: string; body: string; version: string } {
  const file = n.doc.split('/').pop() ?? 'this file';
  const places = n.places && n.places > 1 ? ` (${n.places} places)` : n.places === 1 ? ' (one place)' : '';
  const where = `Both were combined; where both had changed the same thing${places}, the file's version was kept.`;
  if (n.kind === 'stale') return {
    title: 'Edits from before a restart are in History',
    body: `The server restarted ${when(n.at)} before the last edits to ${file} were saved, and the file was changed outside the editor meanwhile. It opens as the file is now.`,
    version: 'Unsaved edits from before a restart',
  };
  if (n.kind === 'restart') return {
    title: 'Edits recovered after a restart',
    body: `The server restarted ${when(n.at)} before the last edits to ${file} were saved, and the file was changed outside the editor meanwhile (by another program, git or an agent). ${where}`,
    version: 'Before a change on disk',
  };
  return {
    title: 'The file changed outside the editor',
    body: `${file} was changed outside the editor ${when(n.at)} (by another program, git or an agent) while edits made here were not saved yet. ${where}`,
    version: 'Before a change on disk',
  };
}

function stack(): HTMLElement {
  let s = document.querySelector<HTMLElement>('.ol-disknotices');
  if (!s) {
    s = document.createElement('div');
    s.className = 'ol-disknotices';
    s.setAttribute('role', 'status');
    s.setAttribute('aria-live', 'polite');
    document.body.appendChild(s);
  }
  return s;
}

/** Show a notice (once per notice, however many connections bring it); `seen` is called once it was. */
export function showDiskNotice(n: DiskNotice, seen?: () => void): void {
  if (shown.has(n.id) || typeof document === 'undefined') return;
  shown.add(n.id);
  let told = false;
  const tell = () => { if (!told) { told = true; seen?.(); } };
  const t = noticeText(n);
  const card = document.createElement('div');
  card.className = 'ol-disknotice';
  card.dataset.notice = String(n.id);
  const h = document.createElement('div');
  h.className = 'ol-disknotice-title';
  h.textContent = t.title;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'ol-disknotice-close';
  close.title = close.ariaLabel = 'Dismiss';
  close.textContent = '×';
  close.onclick = () => { tell(); card.remove(); };
  h.appendChild(close);
  const p = document.createElement('p');
  const kept = n.version === null ? ' Keeping the version from here as a version did not work.'
    : opener ? ` The version from here is in History as “${t.version}”.`
    : ` The version from here is in this file's History as “${t.version}” (open the file on the web to see it).`;
  p.textContent = t.body + kept;
  card.append(h, p);
  if (opener && n.version !== null) {
    const row = document.createElement('div');
    row.className = 'ol-disknotice-actions';
    const show = document.createElement('button');
    show.type = 'button';
    show.className = 'ol-disknotice-show';
    show.textContent = 'Show in History';
    show.onclick = () => { tell(); opener?.(n.doc, n.version!); card.remove(); };
    row.appendChild(show);
    card.appendChild(row);
  }
  stack().appendChild(card);
  let visible = 0;
  const watch = setInterval(() => {
    if (told || !card.isConnected) { clearInterval(watch); return; }
    if (document.visibilityState === 'visible' && (visible += 500) >= SEEN_MS) { clearInterval(watch); tell(); }
  }, 500);
}

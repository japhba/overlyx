/**
 * What the PDF pane's bar and the status bar say about the PDF: how old it is, and whether it is
 * current, behind the document (the .tex file was written after the PDF), being built, or from a
 * build that failed. Times are on the server's clock (the PDF file's mtime, the last save); `skew`
 * (server − browser, from the build status' `now`) turns the browser's clock into the server's.
 */
import { useEffect, useState } from 'preact/hooks';
import type { Prefs } from '../prefs';

/** the auto-build choices (the ▾ beside View PDF, Settings ▸ Editor ▸ PDF) */
export const AUTO_BUILD_CHOICES: [Prefs['autoBuild'], string, string][] = [
  ['off', 'Off', 'Only when you ask (Ctrl+R, View PDF)'],
  ['shown', 'While the PDF is shown', 'A moment after the document was saved, if the PDF pane is open'],
  ['always', 'Always', 'Also with the PDF hidden — keeps a public PDF link current'],
];
export const AUTO_BUILD_DELAYS = [0, 1, 3, 10, 30];

export type PdfStatusKind = 'none' | 'building' | 'error' | 'outdated' | 'current';

export interface PdfStatusInput {
  url: string | null;
  busy: boolean;
  ok: boolean | null;
  /** when the PDF file was written (server clock) */
  pdfAt?: number | null;
  /** server clock − browser clock, ms */
  skew?: number;
}

export interface PdfStatus {
  kind: PdfStatusKind;
  /** age of the PDF shown, ms (null: no PDF) */
  age: number | null;
  /** the PDF pane's bar ("✓ built 2 min ago") */
  label: string;
  /** the status bar ("PDF 2 min old") */
  short: string;
  title: string;
}

/** "just now", "12 s", "3 min", "2 h", "3 days" */
export function formatAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h`;
  const d = Math.floor(h / 24);
  return `${d} days`;
}
const ago = (ms: number) => { const a = formatAge(ms); return a === 'just now' ? a : a + ' ago'; };

/** A save this long after the PDF was written counts as newer (the two clocks are the same server's; allow for rounding). */
const SLACK = 1500;

export function pdfStatus(s: PdfStatusInput, savedAt: number, now = Date.now()): PdfStatus {
  const serverNow = now + (s.skew ?? 0);
  const age = s.url && s.pdfAt ? Math.max(0, serverNow - s.pdfAt) : null;
  const when = s.pdfAt ? new Date(s.pdfAt - (s.skew ?? 0)).toLocaleTimeString() : '';
  const behind = !!s.pdfAt && savedAt > s.pdfAt + SLACK;
  const behindNote = behind ? ` The document was changed after it (saved ${new Date(savedAt - (s.skew ?? 0)).toLocaleTimeString()}).` : '';
  if (s.busy) {
    return { kind: 'building', age, label: age !== null ? `building… · PDF ${formatAge(age)} old` : 'building…', short: 'PDF building…',
      title: 'A build is running in the background — you can keep editing.' + (when ? ` The PDF shown was built at ${when}.` : '') };
  }
  if (!s.url) {
    if (s.ok === false) return { kind: 'error', age: null, label: '✗ errors', short: 'PDF ✗ errors', title: 'The build failed and there is no PDF — see the log.' };
    return { kind: 'none', age: null, label: '', short: 'no PDF yet', title: 'No PDF built yet — Ctrl+R builds it.' };
  }
  if (s.ok === false) {
    return { kind: 'error', age, label: age !== null ? `✗ errors · PDF ${formatAge(age)} old` : '✗ errors', short: age !== null ? `PDF ✗ errors · ${formatAge(age)}` : 'PDF ✗ errors',
      title: 'The last build had errors — see the log.' + (when ? ` The PDF shown is from ${when}.` : '') + behindNote };
  }
  if (behind && age !== null) {
    return { kind: 'outdated', age, label: `✓ built ${ago(age)} · outdated`, short: `PDF ${formatAge(age)} old · outdated`, title: `Built at ${when}.${behindNote} Ctrl+R builds it again.` };
  }
  return { kind: 'current', age, label: age !== null ? `✓ built ${ago(age)}` : '✓ built', short: age !== null ? `PDF ${formatAge(age) === 'just now' ? 'just built' : formatAge(age) + ' old'}` : 'PDF built',
    title: (when ? `Built at ${when}` : 'Built') + ' — up to date with the document.' };
}

/** Re-render as time passes: every second while `fast`, else every 15 s. */
export function useTicker(fast: boolean): number {
  const [t, setT] = useState(() => Date.now());
  useEffect(() => {
    const iv = setInterval(() => setT(Date.now()), fast ? 1000 : 15000);
    return () => clearInterval(iv);
  }, [fast]);
  return t;
}

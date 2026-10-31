/**
 * Formulas the editor could not typeset — a command MathJax does not know (its name drawn in red), a
 * TeX error or one the editor's own reader stumbled on (the source shown in red) — reported once the
 * formula is on the screen, where the user sees it (core typeset.ts says what a report may carry:
 * command names and the error's words, how the preamble defines the command, never the formula).
 * Each kind once a page load, a few at most; the web app's go to the server (POST
 * /api/client-typeset), the VS Code extension's through its bridge to its telemetry.
 */
import { api, API_BASE } from '../api';
import { preambleFacts, type TypesetInput } from '@overlyx/core/typeset.ts';
import { editorContext } from './context';

const REPORTS_MAX = 12;
let reports = 0;
const sent = new Set<string>();
const waiting = new WeakMap<Element, { key: string; input: TypesetInput; docId: string }>();
const preambles = new Map<string, Promise<string | null>>();
let observer: IntersectionObserver | null = null;

const formatOf = (id: string): TypesetInput['format'] => (/\.(md|markdown)$/i.test(id) ? 'md' : /\.html?$/i.test(id) ? 'article' : 'tex');

function preambleOf(docId: string): Promise<string | null> {
  let p = preambles.get(docId);
  if (!p) {
    p = api.header(docId).then(h => h.headerLines.join('\n'), () => null);
    preambles.set(docId, p);
  }
  return p;
}

async function send(input: TypesetInput, docId: string): Promise<void> {
  let facts: Partial<TypesetInput> = {};
  if (input.command && docId) {
    const preamble = await preambleOf(docId);
    facts = preamble === null ? { defined: 'unknown' } : preambleFacts(preamble, input.command);
  }
  api.clientTypeset({ ...input, ...facts, format: formatOf(docId), app: API_BASE !== '' ? 'vscode' : 'web' }).catch(() => {});
}

function seen(entries: IntersectionObserverEntry[]): void {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    observer?.unobserve(e.target);
    const w = waiting.get(e.target);
    waiting.delete(e.target);
    if (!w || sent.has(w.key) || reports >= REPORTS_MAX || !e.target.isConnected) continue;
    sent.add(w.key);
    reports++;
    void send(w.input, w.docId);
  }
}

/**
 * What became of rendering the formula in `el`: the commands MathJax did not know, the error it
 * (or the editor's reader, `parse`) raised — or nothing wrong (null), which forgets an earlier
 * problem of `el`.
 */
export function noteTypeset(el: HTMLElement, problem: { undefinedCommands?: string[]; error?: string | null; parse?: boolean; display: boolean } | null): void {
  if (typeof IntersectionObserver === 'undefined' || reports >= REPORTS_MAX) return;
  const command = problem?.undefinedCommands?.find(c => !sent.has('undefined ' + c));
  const input: TypesetInput | null = !problem ? null
    : command ? { problem: 'undefined', command: '\\' + command.replace(/^\\/, ''), display: problem.display }
    : problem.error ? { problem: problem.parse ? 'parse' : 'error', error: problem.error, display: problem.display } : null;
  if (!input) { if (waiting.delete(el)) observer?.unobserve(el); return; }
  const key = input.problem === 'undefined' ? 'undefined ' + command : `${input.problem} ${input.error}`;
  if (sent.has(key)) return;
  const pm = el.closest<HTMLElement>('.ProseMirror');
  waiting.set(el, { key, input, docId: pm?.dataset.docId ?? editorContext.docId ?? '' });
  (observer ??= new IntersectionObserver(seen)).observe(el);
}

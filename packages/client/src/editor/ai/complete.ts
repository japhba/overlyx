/**
 * Autocomplete in the text (Tools ▸ AI ▸ Autocomplete text), with the mechanics of an IDE's
 * inline suggestions (VS Code / Copilot):
 *
 *  - typing schedules a request (a short throttle, so continuous typing still asks); one request is in flight at a time,
 *    and typing does *not* cancel it — when the reply arrives, whatever was typed meanwhile is
 *    compared with the reply's beginning, and the rest is shown if it matches;
 *  - a shown suggestion stays while you type its beginning (it shrinks as you go) and is
 *    dismissed by anything else — a different character, a cursor move, Escape;
 *  - Tab inserts the whole suggestion, ⌘/Ctrl+→ the next word of it;
 *  - the suggestion comes back from the server as LaTeX *and* as editor nodes and is rendered as
 *    faint "ghost" content after the caret (formulas included), so Tab inserts exactly what is shown;
 *  - replies are cached by context; only a collapsed cursor in ordinary text asks (not in ERT,
 *    listings, code, bibliography, nor in the middle of a word).
 */
import { Plugin, PluginKey, TextSelection, type EditorState, type Selection, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import { Fragment, type Node as PMNode } from 'prosemirror-model';
import { schema } from '@overlyx/core';
import { ySyncPluginKey } from 'y-prosemirror';
import { api, type PMJSON } from '../../api';
import { getPrefs } from '../../prefs';
import { editorContext, viewDocId } from '../context';
import { nodeText } from '../cliptext';
import { renderFragment } from './render';

export interface Ghost {
  pos: number;
  nodes: PMJSON[];
  /** plain text of `nodes` (what typing is matched against) */
  text: string;
  /** the paragraph's text before / after the ghost when it was shown (typing its beginning extends `before`) */
  before: string;
  after: string;
  deco: DecorationSet;
  /** builds the decoration for a moved / shortened ghost, against the document it will be shown in (captures the view) */
  render: (doc: PMNode, pos: number, nodes: PMJSON[]) => DecorationSet | null;
}
interface CompleteState {
  ghost: Ghost | null;
  /** the last transaction was local typing: a completion may be due */
  typed: boolean;
  /** the last transaction moved the cursor without typing: an in-flight request is stale */
  moved: boolean;
}
export const aiCompleteKey = new PluginKey<CompleteState>('ai-complete');

const NO_COMPLETE_INSETS = new Set(['ERT', 'listings', 'Preamble', 'Index', 'IPA', 'Argument']);
const NO_COMPLETE_LAYOUTS = new Set(['Bibliography', 'LyX-Code', 'Verbatim', 'Verbatim*']);

export interface CompletionContext { pos: number; before: string; after: string }

/** Where a completion makes sense: a collapsed cursor in text, not in the middle of a word. */
export function completionContext(state: EditorState): CompletionContext | null {
  const { $from, empty } = state.selection;
  if (!empty || !$from.parent.isTextblock || $from.parent.type.name !== 'paragraph') return null;
  if (NO_COMPLETE_LAYOUTS.has(String($from.parent.attrs.layout))) return null;
  for (let d = $from.depth - 1; d > 0; d--) { const n = $from.node(d); if (n.type.name === 'inset' && NO_COMPLETE_INSETS.has(String(n.attrs.name))) return null; }
  const par = $from.parent, off = $from.parentOffset;
  const cur = nodeText(par.cut(0, off));
  if (cur.trim().length < 3) return null;
  const nextNode = $from.nodeAfter;
  if (nextNode?.isText && nextNode.text && !/^\s/.test(nextNode.text)) return null;   // inside a word (a formula or inset after the cursor is fine)
  // the paragraphs before and after (top-level neighbours) for context
  const doc = state.doc, idx = $from.index(0);
  let before = '';
  for (let i = Math.max(0, idx - 4); i < idx; i++) before += nodeText(doc.child(i)) + '\n\n';
  before += cur;
  let after = nodeText(par.cut(off));
  if (idx + 1 < doc.childCount) after += '\n\n' + nodeText(doc.child(idx + 1));
  return { pos: $from.pos, before, after };
}

/** The paragraph's text before and after a collapsed cursor (formulas as $…$), or null. */
export function localContext(doc: PMNode, sel: Selection): { pos: number; before: string; after: string } | null {
  if (!sel.empty || !sel.$from.parent.isTextblock) return null;
  const par = sel.$from.parent, off = sel.$from.parentOffset;
  return { pos: sel.from, before: nodeText(par.cut(0, off)), after: nodeText(par.cut(off)) };
}

/** plain text of inline nodes (formulas as $…$, like the clipboard) */
export function nodesText(nodes: PMJSON[]): string {
  try { return nodeText(schema.nodes.paragraph.create(null, Fragment.fromJSON(schema, nodes))); } catch { return ''; }
}

/** The nodes minus their first `n` characters (only leading text can be consumed); null when a formula or inset would be cut. */
export function trimNodes(nodes: PMJSON[], n: number): PMJSON[] | null {
  const out = nodes.slice();
  while (n > 0 && out.length) {
    const first = out[0];
    if (first.type !== 'text' || typeof first.text !== 'string') return null;
    if (first.text.length <= n) { n -= first.text.length; out.shift(); }
    else { out[0] = { ...first, text: first.text.slice(n) }; n = 0; }
  }
  return n > 0 ? null : out;
}

/**
 * What the user typed since a request was made (the request's context is a prefix of the
 * current one), or null when the cursor went elsewhere.
 */
export function typedSince(req: CompletionContext, cur: CompletionContext): string | null {
  if (cur.pos < req.pos || cur.after !== req.after || !cur.before.startsWith(req.before)) return null;
  const typed = cur.before.slice(req.before.length);
  return cur.pos - req.pos === typed.length ? typed : null;
}

function makeRender(view: EditorView) {
  return (doc: PMNode, pos: number, nodes: PMJSON[]): DecorationSet | null => {
    let frag: Fragment;
    try { frag = Fragment.fromJSON(schema, nodes); } catch { return null; }
    if (!frag.size) return null;
    const widget = Decoration.widget(pos, () => {
      const span = document.createElement('span');
      span.className = 'ai-ghost';
      span.contentEditable = 'false';
      span.title = 'Suggested continuation — Tab inserts it, ⌘/Ctrl+→ the next word, Esc dismisses it';
      span.appendChild(renderFragment(view, frag, pos));
      return span;
    // the key decides whether ProseMirror re-renders the widget: it must change with the content
    }, { side: 1, ignoreSelection: true, key: 'ai-ghost:' + pos + ':' + JSON.stringify(nodes) });
    return DecorationSet.create(doc, [widget]);
  };
}

/** Inserts the ghost content at its position (Tab). */
export function acceptCompletion(view: EditorView): boolean {
  const g = aiCompleteKey.getState(view.state)?.ghost;
  if (!g) return false;
  let frag: Fragment;
  try { frag = Fragment.fromJSON(schema, g.nodes); } catch { return false; }
  let tr = view.state.tr.insert(g.pos, frag);
  tr = tr.setSelection(TextSelection.near(tr.doc.resolve(g.pos + frag.size))).scrollIntoView().setMeta(aiCompleteKey, 'accept');
  view.dispatch(tr);
  view.focus();
  return true;
}

/** Inserts the next word of the suggestion (⌘/Ctrl+→); the rest stays on show. A leading formula is taken whole. */
export function acceptWord(view: EditorView): boolean {
  const g = aiCompleteKey.getState(view.state)?.ghost;
  if (!g) return false;
  const first = g.nodes[0];
  if (!first || first.type !== 'text' || typeof first.text !== 'string') return acceptCompletion(view);
  const m = /^\s*\S+\s?/.exec(first.text);
  const word = m ? m[0] : first.text;
  if (word.length >= g.text.length) return acceptCompletion(view);
  // the reducer sees plain typing of the ghost's beginning and shortens it accordingly
  const tr = view.state.tr.insertText(word, g.pos);
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, g.pos + word.length)).scrollIntoView());
  view.focus();
  return true;
}

export function dismissCompletion(view: EditorView): boolean {
  if (!aiCompleteKey.getState(view.state)?.ghost) return false;
  view.dispatch(view.state.tr.setMeta(aiCompleteKey, 'clear'));
  return true;
}

/**
 * The ghost after a document change: unchanged (mapped) when nothing happened around it, shorter
 * when the beginning of the suggestion was typed, gone otherwise. Judged on the paragraph's text
 * around the cursor rather than on the transaction's steps (typing next to a widget produces
 * replace steps of varying shape).
 */
function afterChange(g: Ghost, tr: Transaction): Ghost | null {
  const lc = localContext(tr.doc, tr.selection);
  if (!lc || lc.after !== g.after || !lc.before.startsWith(g.before)) return null;
  const typed = lc.before.slice(g.before.length);
  if (lc.pos !== g.pos + typed.length && !(typed === '' && lc.pos === tr.mapping.map(g.pos))) return null;
  if (!typed) return lc.pos === g.pos ? g : { ...g, pos: lc.pos, deco: g.deco.map(tr.mapping, tr.doc) };
  if (!g.text.startsWith(typed) || g.text.length <= typed.length) return null;
  const nodes = trimNodes(g.nodes, typed.length);
  if (!nodes || !nodes.length) return null;
  const deco = g.render(tr.doc, lc.pos, nodes);
  return deco ? { ...g, pos: lc.pos, nodes, text: g.text.slice(typed.length), before: lc.before, deco } : null;
}

export function aiCompletePlugin(): Plugin<CompleteState> {
  return new Plugin<CompleteState>({
    key: aiCompleteKey,
    state: {
      init: () => ({ ghost: null, typed: false, moved: false }),
      apply(tr: Transaction, st: CompleteState): CompleteState {
        const meta = tr.getMeta(aiCompleteKey);
        if (meta === 'clear' || meta === 'accept') return { ghost: null, typed: false, moved: false };
        if (meta && typeof meta === 'object' && 'ghost' in meta) return { ghost: (meta as { ghost: Ghost }).ghost, typed: false, moved: false };
        const remote = !!tr.getMeta(ySyncPluginKey) || tr.getMeta('addToHistory') === false;
        const typed = tr.docChanged && !remote && tr.selection.empty;
        const moved = !tr.docChanged && tr.selectionSet && !remote;
        if (st.ghost) {
          if (tr.docChanged) {
            // typing the suggestion's beginning keeps it, shorter; anything else ends it
            const g = afterChange(st.ghost, tr);
            return { ghost: g, typed: g ? false : typed, moved: false };
          }
          if (tr.selectionSet && tr.selection.from !== st.ghost.pos) return { ghost: null, typed: false, moved };
          return st;
        }
        return typed === st.typed && moved === st.moved ? st : { ...st, typed, moved };
      },
    },
    props: {
      decorations(state) { return aiCompleteKey.getState(state)?.ghost?.deco ?? DecorationSet.empty; },
      handleKeyDown(view, ev) {
        const g = aiCompleteKey.getState(view.state)?.ghost;
        if (!g) return false;
        const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? ev.metaKey : ev.ctrlKey;
        if (ev.key === 'Tab' && !ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey) { ev.preventDefault(); return acceptCompletion(view); }
        if (ev.key === 'ArrowRight' && mod && !ev.shiftKey && !ev.altKey) { ev.preventDefault(); return acceptWord(view); }
        if (ev.key === 'Escape') { dismissCompletion(view); return true; }
        return false;
      },
    },
    view(view) {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let inflight: { ctx: CompletionContext; ac: AbortController } | null = null;
      let dirty = false;   // typing happened while a request was in flight
      const cache = new Map<string, PMJSON[]>();
      const render = makeRender(view);
      const enabled = () => getPrefs().aiCompleteText && !!editorContext.ai?.available;
      const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };
      const abort = () => { clearTimer(); dirty = false; if (inflight) { inflight.ac.abort(); inflight = null; editorContext.aiBusy?.(false); } };
      const cacheKey = (ctx: CompletionContext) => ctx.before.slice(-600) + ' ' + ctx.after.slice(0, 200);

      /** shows a reply for `req` if the cursor is still there or only typed the reply's beginning since */
      const applyReply = (req: CompletionContext, nodes: PMJSON[], text: string): boolean => {
        if (!nodes.length || !view.hasFocus()) return false;
        const cur = completionContext(view.state);
        if (!cur) return false;
        const typed = typedSince(req, cur);
        if (typed === null) return false;
        let shown = nodes, shownText = text || nodesText(nodes);
        if (typed) {
          if (!shownText.startsWith(typed) || shownText.length <= typed.length) return false;
          const t = trimNodes(nodes, typed.length);
          if (!t || !t.length) return false;
          shown = t; shownText = shownText.slice(typed.length);
        }
        const deco = render(view.state.doc, cur.pos, shown);
        const lc = localContext(view.state.doc, view.state.selection);
        if (!deco || !lc) return false;
        view.dispatch(view.state.tr.setMeta(aiCompleteKey, { ghost: { pos: cur.pos, nodes: shown, text: shownText, before: lc.before, after: lc.after, deco, render } }).setMeta('addToHistory', false));
        return true;
      };

      const request = async () => {
        timer = null;
        if (inflight) { dirty = true; return; }
        if (!enabled() || !view.hasFocus()) return;
        const ctx = completionContext(view.state);
        if (!ctx) return;
        const hit = cache.get(cacheKey(ctx));
        if (hit) { applyReply(ctx, hit, nodesText(hit)); return; }
        const ac = new AbortController();
        inflight = { ctx, ac };
        dirty = false;
        editorContext.aiBusy?.(true);
        let shown = false;
        try {
          const r = await api.aiComplete(viewDocId(view), { kind: 'text', before: ctx.before, after: ctx.after }, ac.signal);
          if (ac.signal.aborted) return;
          if (cache.size > 80) cache.clear();
          cache.set(cacheKey(ctx), r.nodes);
          shown = applyReply(ctx, r.nodes, r.text);
        } catch (e) {
          if ((e as Error).name === 'AbortError' || ac.signal.aborted) return;
          const status = (e as { status?: number }).status;
          if (status === 429 || status === 503) editorContext.notify?.((e as Error).message, 'error');
        } finally {
          if (inflight?.ac === ac) { inflight = null; editorContext.aiBusy?.(false); }
          // typed on meanwhile and nothing fits: ask again right away from where the cursor is now
          const again = !ac.signal.aborted && dirty && !shown;
          dirty = false;
          if (again && !aiCompleteKey.getState(view.state)?.ghost) void request();
        }
      };
      return {
        update(v, prev) {
          if (v.state === prev) return;
          const st = aiCompleteKey.getState(v.state);
          if (!st) return;
          if (st.moved) { abort(); return; }
          if (!st.typed || st.ghost || !enabled()) return;
          // a throttle, not a debounce: continuous typing must not starve the request (the reply is
          // matched against whatever gets typed meanwhile)
          if (!timer) timer = setTimeout(() => { void request(); }, Math.max(80, getPrefs().aiCompleteDelay));
        },
        destroy: abort,
      };
    },
  });
}

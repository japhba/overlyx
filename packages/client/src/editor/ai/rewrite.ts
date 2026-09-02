/**
 * ⌘K / Ctrl+K "rewrite with AI" (Tools ▸ AI ▸ Rewrite with AI): a small prompt appears under the
 * selection; the instruction and the selected passage go to the server (ai.ts), which returns
 * the replacement as LaTeX and as editor nodes. The proposal is previewed in place — the old
 * text struck through, the new content rendered after it (formulas included) — and applied only
 * on Accept (Enter); Esc rejects. Nothing reaches the document before that, so co-authors never
 * see a half-finished rewrite.
 *
 * Inside a formula the same panel rewrites the formula (or its selected part); the proposal is
 * rendered in the panel and replaces the formula on Accept.
 */
import { Plugin, PluginKey, TextSelection, NodeSelection, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import { Fragment, Slice } from 'prosemirror-model';
import { schema } from '@overlyx/core';
import { api, type PMJSON } from '../../api';
import { getPrefs, setPref } from '../../prefs';
import { editorContext, viewDocId } from '../context';
import { currentParagraph } from '../commands';
import { nodeText } from '../cliptext';
import { renderFragment, isInlineFragment } from './render';
import type { LyxMathField } from '../lyxmath/field';
import { renderStaticHtml } from '../lyxmath/field';

interface RewriteState { preview: { from: number; to: number; deco: DecorationSet } | null }
export const aiRewriteKey = new PluginKey<RewriteState>('ai-rewrite');

export function aiRewritePlugin(): Plugin<RewriteState> {
  return new Plugin<RewriteState>({
    key: aiRewriteKey,
    state: {
      init: () => ({ preview: null }),
      apply(tr: Transaction, st: RewriteState): RewriteState {
        const meta = tr.getMeta(aiRewriteKey);
        if (meta === 'clear') return { preview: null };
        if (meta && typeof meta === 'object') return { preview: meta as RewriteState['preview'] };
        if (st.preview && tr.docChanged) {
          // remote edits: the preview follows the text
          const from = tr.mapping.map(st.preview.from, 1), to = tr.mapping.map(st.preview.to, -1);
          return { preview: { from, to: Math.max(from, to), deco: st.preview.deco.map(tr.mapping, tr.doc) } };
        }
        return st;
      },
    },
    props: { decorations(state) { return aiRewriteKey.getState(state)?.preview?.deco ?? DecorationSet.empty; } },
  });
}

/* ------------------------------------------------------------------ the panel */

let panel: RewritePanel | null = null;
export function closeRewrite(): void { panel?.close(); }
export function rewriteOpen(): boolean { return !!panel; }

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
export const REWRITE_KEY = isMac ? '⌘K' : 'Ctrl+K';

type Target =
  | { kind: 'text'; view: EditorView; from: number; to: number; content: PMJSON[]; layout: string; before: string; after: string }
  | { kind: 'math'; field: LyxMathField; view: EditorView | null; latex: string; display: boolean; selection?: string; wrap: (tex: string) => string }
  /** raw LaTeX selected in the source pane: the reply is raw source, spliced back on Accept */
  | { kind: 'source'; docId: string; host: HTMLElement; textarea: HTMLTextAreaElement; from: number; to: number; onAccept: (tex: string, from: number, to: number) => void };

class RewritePanel {
  dom: HTMLDivElement;
  private input: HTMLTextAreaElement;
  private status: HTMLDivElement;
  private preview: HTMLDivElement;
  private actions: HTMLDivElement;
  private ctrl: AbortController | null = null;
  private result: { tex: string; nodes: PMJSON[] } | null = null;
  /** follow-ups: the proposals so far (a new instruction refines the last one) */
  private history: { instruction: string; tex: string }[] = [];
  private host: HTMLElement;

  constructor(private target: Target, anchor: DOMRect) {
    const view = target.kind === 'source' ? null : target.view;
    this.host = target.kind === 'source' ? target.host : (view?.dom.closest('.editor-scroll') as HTMLElement | null) ?? document.body;
    this.dom = document.createElement('div');
    this.dom.className = 'ai-panel';
    this.dom.dataset.aiPanel = target.kind;
    this.dom.innerHTML = `
      <div class="ai-row">
        <select class="ai-model" title="Model for this rewrite (kept as your ⌘K model)"></select>
        <textarea class="ai-input" rows="1" placeholder="${target.kind === 'math' ? 'What to do with the formula… (Enter to ask)' : target.from === target.to ? 'What to write here… (Enter to ask)' : 'What to do with the selection… (Enter to ask)'}"></textarea>
        <button type="button" class="ai-close" title="Close (Esc)">✕</button>
      </div>
      <div class="ai-status"></div>
      <div class="ai-preview" hidden></div>
      <div class="ai-actions" hidden>
        <button type="button" class="btn primary ai-accept" data-ai-accept>Accept <kbd>⏎</kbd></button>
        <button type="button" class="btn ai-reject" data-ai-reject>Reject <kbd>Esc</kbd></button>
        <button type="button" class="btn ai-retry" data-ai-retry title="Ask again, e.g. with a refined instruction">Try again</button>
      </div>`;
    this.input = this.dom.querySelector('.ai-input')!;
    // the model for this rewrite: the server's default or one of its offered models (kept in the prefs)
    const sel = this.dom.querySelector('.ai-model') as HTMLSelectElement;
    const models = editorContext.ai?.models ?? [];
    const fallback = editorContext.ai?.model ?? '';
    sel.append(new Option(`${models.find(m => m.id === fallback)?.label ?? fallback ?? 'default'}`, ''));
    for (const m of models) sel.append(new Option(m.label, m.id));
    const pref = getPrefs().aiModel;
    if (pref && !models.some(m => m.id === pref)) sel.append(new Option(pref, pref));
    sel.value = pref && [...sel.options].some(o => o.value === pref) ? pref : '';
    sel.addEventListener('change', () => setPref('aiModel', sel.value));
    this.status = this.dom.querySelector('.ai-status')!;
    this.preview = this.dom.querySelector('.ai-preview')!;
    this.actions = this.dom.querySelector('.ai-actions')!;
    this.dom.querySelector('.ai-close')!.addEventListener('click', () => this.close());
    this.dom.querySelector('[data-ai-accept]')!.addEventListener('click', () => this.accept());
    this.dom.querySelector('[data-ai-reject]')!.addEventListener('click', () => this.close());
    this.dom.querySelector('[data-ai-retry]')!.addEventListener('click', () => { this.history = []; this.clearPreview(); this.input.value = this.lastInstruction; this.input.focus(); this.input.select(); });
    // keys stay in the panel (the editor's own bindings must not fire); Enter asks / accepts, Esc rejects
    this.dom.addEventListener('keydown', ev => {
      ev.stopPropagation();
      if (ev.key === 'Escape') { ev.preventDefault(); this.close(); return; }
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        // a proposal is on show: Enter with an empty box accepts it, typed text is a follow-up
        if (this.result && !this.input.value.trim()) this.accept();
        else void this.ask();
      }
    });
    this.dom.addEventListener('mousedown', ev => { if ((ev.target as HTMLElement).tagName !== 'TEXTAREA') ev.preventDefault(); });
    this.input.addEventListener('input', () => { this.input.style.height = 'auto'; this.input.style.height = Math.min(120, this.input.scrollHeight) + 'px'; });
    this.host.appendChild(this.dom);
    this.place(anchor);
    this.setStatus(target.kind === 'math' ? 'Describe the change to the formula.' : target.from === target.to ? 'Describe what to write at the cursor.' : 'Describe the change — e.g. “more concise”, “fix grammar”, “as a bulleted list”, “make the argument rigorous”.');
    // the keyboard goes to the prompt at once (a key typed right after ⌘K must not land in the editor)
    this.input.focus();
    requestAnimationFrame(() => { if (document.activeElement !== this.input && this.dom.isConnected) this.input.focus(); });
    // the passage is tracked in the plugin state from now on, so that it follows edits made meanwhile
    if (target.kind === 'text') target.view.dispatch(target.view.state.tr.setMeta(aiRewriteKey, { from: target.from, to: target.to, deco: DecorationSet.empty }));
  }
  private lastInstruction = '';

  private place(anchor: DOMRect) {
    const hr = this.host.getBoundingClientRect();
    const scrollTop = this.host === document.body ? window.scrollY : this.host.scrollTop;
    const scrollLeft = this.host === document.body ? window.scrollX : this.host.scrollLeft;
    const width = Math.min(460, hr.width - 16);
    let left = anchor.left - hr.left + scrollLeft;
    left = Math.max(8 + scrollLeft, Math.min(left, hr.width - width - 8 + scrollLeft));
    this.dom.style.width = width + 'px';
    this.dom.style.left = left + 'px';
    this.dom.style.top = anchor.bottom - hr.top + scrollTop + 6 + 'px';
  }

  private setStatus(text: string, kind: '' | 'busy' | 'error' = '') { this.status.textContent = text; this.status.className = 'ai-status' + (kind ? ' ' + kind : ''); }

  private clearPreview() {
    this.result = null;
    this.actions.hidden = true;
    this.preview.hidden = true; this.preview.replaceChildren();
    // keep tracking the passage, drop the decorations
    if (this.target.kind === 'text') { const v = this.target.view; const p = aiRewriteKey.getState(v.state)?.preview; if (p) v.dispatch(v.state.tr.setMeta(aiRewriteKey, { from: p.from, to: p.to, deco: DecorationSet.empty })); }
  }

  async ask() {
    const instruction = this.input.value.trim();
    if (!instruction) { this.input.focus(); return; }
    // a new instruction over a shown proposal is a follow-up: it refines that proposal
    if (this.result) this.history.push({ instruction: this.lastInstruction, tex: this.result.tex });
    this.lastInstruction = instruction;
    this.clearPreview();
    this.ctrl?.abort();
    const ac = this.ctrl = new AbortController();
    this.setStatus('Thinking…', 'busy');
    const t = this.target;
    const docId = t.kind === 'text' ? viewDocId(t.view) : t.kind === 'source' ? t.docId : (t.view ? viewDocId(t.view) : editorContext.docId ?? '');
    try {
      const model = getPrefs().aiModel || undefined;
      const history = this.history.length ? this.history.slice(-5) : undefined;
      const r = t.kind === 'text'
        ? await api.aiRewrite(docId, { instruction, content: t.content, layout: t.layout, before: t.before, after: t.after, model, history }, ac.signal)
        : t.kind === 'source'
          ? await api.aiRewrite(docId, { instruction, content: [], model, history, source: { text: t.textarea.value.slice(t.from, t.to), before: t.textarea.value.slice(Math.max(0, t.from - 600), t.from), after: t.textarea.value.slice(t.to, t.to + 600) } }, ac.signal)
          : await api.aiRewrite(docId, { instruction, content: [], model, history, math: { latex: t.latex, display: t.display, selection: t.selection } }, ac.signal);
      if (ac.signal.aborted) return;
      this.showResult(r);
    } catch (e) {
      if (ac.signal.aborted) return;
      this.setStatus((e as Error).message || 'The request failed.', 'error');
    } finally { if (this.ctrl === ac) this.ctrl = null; }
  }

  /** After a proposal: the box empties and invites a follow-up; Enter alone accepts. */
  private armFollowUp() {
    this.input.value = '';
    this.input.placeholder = 'Follow up to refine — or Enter to accept…';
    this.actions.hidden = false;
  }

  private showResult(r: { tex: string; nodes: PMJSON[] }) {
    const t = this.target;
    if (t.kind === 'source') {
      if (!r.tex.trim()) { this.setStatus('The model returned nothing — try a different instruction.', 'error'); return; }
      this.result = r;
      this.preview.hidden = false;
      this.preview.replaceChildren(Object.assign(document.createElement('pre'), { className: 'ai-src', textContent: r.tex }));
      this.setStatus(t.from === t.to ? 'Proposed source for the cursor:' : 'Proposed replacement for the selected source:');
      this.armFollowUp();
      return;
    }
    if (t.kind === 'math') {
      if (!r.tex.trim()) { this.setStatus('The model returned nothing for this formula — try a different instruction.', 'error'); return; }
      this.result = r;
      this.preview.hidden = false;
      this.preview.innerHTML = renderStaticHtml(t.display ? t.wrap(r.tex) : '$' + r.tex + '$', t.display, t.field.macros);
      this.preview.title = r.tex;
      this.setStatus(t.selection !== undefined ? 'Proposed replacement for the selected part:' : 'Proposed formula:');
      this.armFollowUp();
      return;
    }
    let frag: Fragment;
    try { frag = Fragment.fromJSON(schema, r.nodes); } catch { this.setStatus('The reply could not be shown as document content.', 'error'); return; }
    if (!frag.size) { this.setStatus('The model returned nothing to insert.', 'error'); return; }
    this.result = r;
    const { view } = t;
    const tracked = aiRewriteKey.getState(view.state)?.preview;
    const from = tracked?.from ?? t.from, to = tracked?.to ?? t.to;
    const decos: Decoration[] = [];
    if (to > from) decos.push(Decoration.inline(from, to, { class: 'ai-old' }));
    decos.push(Decoration.widget(to, (v) => {
      const span = document.createElement('span');
      span.className = 'ai-new' + (isInlineFragment(frag) ? '' : ' block');
      span.contentEditable = 'false';
      span.appendChild(renderFragment(v, frag, to));
      return span;
    }, { side: 1, key: 'ai-new:' + to + ':' + r.tex, ignoreSelection: true }));   // a fresh key: the widget of an earlier proposal at the same place must not be reused
    view.dispatch(view.state.tr.setMeta(aiRewriteKey, { from, to, deco: DecorationSet.create(view.state.doc, decos) }));
    this.setStatus(to > from ? 'Proposed change shown in the text — Enter accepts, Esc rejects, or type a follow-up.' : 'Proposed text shown at the cursor — Enter accepts, Esc rejects, or type a follow-up.');
    this.armFollowUp();
    // the panel moves below the proposal so that it never covers it
    requestAnimationFrame(() => { const el = view.dom.querySelector('.ai-new') as HTMLElement | null; if (el && this.dom.isConnected) this.place(el.getBoundingClientRect()); });
  }

  accept() {
    const r = this.result;
    if (!r) { void this.ask(); return; }
    const t = this.target;
    if (t.kind === 'source') {
      t.onAccept(r.tex, t.from, t.to);
      this.close();
      return;
    }
    if (t.kind === 'math') {
      const f = t.field;
      f.focus();
      if (t.selection !== undefined) f.execute('replace', r.tex);
      else f.execute('replaceFormula', t.wrap(r.tex));
      this.close();
      return;
    }
    const { view } = t;
    const st = aiRewriteKey.getState(view.state)?.preview;
    const from = st?.from ?? t.from, to = st?.to ?? t.to;
    const frag = Fragment.fromJSON(schema, r.nodes);
    let tr = view.state.tr;
    if (isInlineFragment(frag)) tr = tr.replaceWith(from, to, frag);
    else if (frag.childCount === 1 && from === to) tr = tr.replaceWith(from, to, frag.firstChild!.content);
    else tr = tr.replaceRange(from, to, new Slice(frag, 1, 1));
    const end = tr.mapping.map(to, 1);
    try { tr = tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(end, tr.doc.content.size)), -1)); } catch { /* keep */ }
    tr = tr.setMeta(aiRewriteKey, 'clear').scrollIntoView();
    this.close(false);
    view.dispatch(tr);
    view.focus();
  }

  close(clear = true) {
    this.ctrl?.abort();
    if (clear && this.target.kind === 'text') { const v = this.target.view; if (aiRewriteKey.getState(v.state)?.preview) v.dispatch(v.state.tr.setMeta(aiRewriteKey, 'clear')); }
    this.dom.remove();
    if (panel === this) panel = null;
    if (this.target.kind === 'text') this.target.view.focus(); else if (this.target.kind === 'math') this.target.field.focus(); else this.target.textarea.focus();
  }
}

function escapeAttr(s: string): string { return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

/** True when ⌘K should open the AI prompt (the preference is on). */
export function rewriteEnabled(): boolean { return getPrefs().aiRewrite; }

function notConfigured(): void {
  editorContext.notify?.('AI assistance is not configured on this server (no OPENROUTER_API_KEY) — see Tools ▸ AI', 'error');
}

/** Open the rewrite prompt for the editor's selection (a selected formula node counts as math). */
export function openRewrite(view: EditorView): boolean {
  if (!editorContext.ai?.available) { notConfigured(); return true; }
  closeRewrite();
  // a cursor moved by the browser a moment ago (End, a click) may not be in the state yet
  try { (view as any).domObserver?.flush(); } catch { /* ignore */ }
  const sel = view.state.selection;
  if (sel instanceof NodeSelection && (sel.node.type.name === 'math_inline' || sel.node.type.name === 'math_display')) {
    const nv = (view.nodeDOM(sel.from) as any)?.pmViewDesc?.spec as { ensureField?: () => LyxMathField } | undefined;
    const f = nv?.ensureField?.();
    if (f) { openRewriteMath(f, view); return true; }
  }
  const content = sel.content().toJSON()?.content ?? [];
  const layout = String(currentParagraph(view.state)?.node.attrs.layout ?? 'Standard');
  // where the cursor is, for an empty selection: the paragraph's text around it
  const $c = sel.$from, par = $c.parent;
  const before = par.isTextblock ? nodeText(par.cut(0, $c.parentOffset)) : '', after = par.isTextblock ? nodeText(par.cut(sel.$to.parentOffset)) : '';
  const c = view.coordsAtPos(sel.to);
  const start = view.coordsAtPos(sel.from);
  const anchor = new DOMRect(Math.min(start.left, c.left), c.top, Math.abs(c.left - start.left), c.bottom - c.top);
  panel = new RewritePanel({ kind: 'text', view, from: sel.from, to: sel.to, content, layout, before, after }, anchor);
  return true;
}

/** Open the rewrite prompt over the source pane's selection (Ctrl/⌘+K in the source view). */
export function openSourceRewrite(t: { docId: string; host: HTMLElement; textarea: HTMLTextAreaElement; anchor: DOMRect; onAccept: (tex: string, from: number, to: number) => void }): void {
  if (!editorContext.ai?.available) { notConfigured(); return; }
  if (!getPrefs().aiRewrite) { editorContext.notify?.('Rewrite with AI is off — switch it on under Tools ▸ AI assistance', 'error'); return; }
  closeRewrite();
  panel = new RewritePanel({ kind: 'source', docId: t.docId, host: t.host, textarea: t.textarea, from: t.textarea.selectionStart, to: t.textarea.selectionEnd, onAccept: t.onAccept }, t.anchor);
}

/** Open the rewrite prompt for a formula being edited (⌘K inside the field, or its context menu). */
export function openRewriteMath(field: LyxMathField, view: EditorView | null = editorContext.activeView ?? null): void {
  if (!editorContext.ai?.available) { notConfigured(); return; }
  closeRewrite();
  // the writer surrounds display formulas with newlines; the form is judged on the trimmed source
  const full = field.latex.trim();
  const c = field.cursor;
  const selection = c.selection ? c.grabSelection() : undefined;
  // how a bare formula body is wrapped back into this formula's form ($…$, \[…\], \begin{env}…)
  let wrap: (tex: string) => string;
  let latex = full;
  const env = /^\\begin\{([^}]+)\}/.exec(full);
  if (env) wrap = tex => (/^\\begin\{/.test(tex) ? tex : `\\begin{${env[1]}}\n${tex}\n\\end{${env[1]}}`);
  else if (full.startsWith('\\[')) wrap = tex => (/^\\begin\{|^\\\[/.test(tex) ? tex : `\\[\n${tex}\n\\]`);
  else { latex = full.replace(/^\$|\$$/g, ''); wrap = tex => '$' + tex.replace(/^\$+|\$+$/g, '') + '$'; }
  panel = new RewritePanel({ kind: 'math', field, view, latex, display: field.display, selection, wrap }, field.dom.getBoundingClientRect());
}

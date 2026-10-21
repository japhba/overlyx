/**
 * The review card for offline edits that met other edits (server offlinemerge.ts). When an editor
 * reconnects with offline edits that changed the same words as somebody else meanwhile, the server
 * keeps the live text, lays the offline version over it as tracked changes by "<name> (offline)" and
 * notes the merge in the CRDT (the front end hands its entries in as a MergeSource). The card takes
 * the reader through those places one by one: Keep current (rejects the place's changes), Keep
 * <name>'s (accepts them) — or, when this account has an AI of its own linked (the Agent panel's
 * ChatGPT sign-in, or an agent connected over MCP that is listening; server linkedai.ts), Combine:
 * that AI proposes one version of the paragraph made from both, shown in the card and put in on
 * "Use this" (a tracked change while tracking is on). A place is one merge's changes in one
 * paragraph. The card leaves once every place is settled; × hides it until the next merge.
 */
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import { Fragment, Slice, type Node as PMNode } from 'prosemirror-model';
import { schema } from '@overlyx/core';
import { allChanges, resolveChanges, type ChangeRange } from './changes';
import { api, type AiMergeResult } from '../../api';
import { editorContext, viewDocId } from '../context';
import { nodeText } from '../cliptext';
import { renderFragment, isInlineFragment } from '../ai/render';

/** A merge the server laid out for review (server offlinemerge.ts OfflineMergeEntry, under its key). */
export interface MergeEntry { key: string; name: string; reviewer: string; authorId: number; time: number; at: number; conflicts: number }
export interface MergeSource {
  list(): MergeEntry[];
  /** `fn` runs whenever the entries change; returns the unsubscribe */
  subscribe(fn: () => void): () => void;
  /** every place of the merge is settled: forget it */
  dismiss(key: string): void;
}

/** One merge's tracked changes in one paragraph (`block`: the paragraph's position). */
export interface MergePlace { entry: MergeEntry; block: number; ranges: ChangeRange[] }

/** The places of the merges in a document, in document order. */
export function mergePlaces(doc: PMNode, entries: MergeEntry[]): MergePlace[] {
  const out: MergePlace[] = [];
  if (!entries.length) return out;
  for (const r of allChanges(doc)) {
    const entry = entries.find(e => e.authorId === r.author && e.time === r.time);
    if (!entry) continue;
    const $p = doc.resolve(Math.min(r.from, doc.content.size));
    let depth = $p.depth;
    while (depth > 0 && !$p.node(depth).isTextblock) depth--;
    const block = depth > 0 ? $p.before(depth) : r.from;
    const last = out.at(-1);
    if (last && last.entry === entry && last.block === block) last.ranges.push(r);
    else out.push({ entry, block, ranges: [r] });
  }
  return out;
}

/** The paragraph of a place with its changes rejected (the current text) or accepted (the offline version). */
function versionOf(state: EditorState, place: MergePlace, accept: boolean): PMNode | null {
  let tr: Transaction | null = null;
  resolveChanges(place.ranges, accept)(state, t => { tr = t; });
  const t = tr as Transaction | null;
  const node = t ? t.doc.nodeAt(t.mapping.map(place.block)) : state.doc.nodeAt(place.block);
  return node?.isTextblock ? node : null;
}

const focusKey = new PluginKey<DecorationSet>('ol-merge-review');

export function mergeReviewPlugin(source: MergeSource | null | undefined): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: focusKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, deco) {
        const meta = tr.getMeta(focusKey) as { from: number; to: number } | null | undefined;
        if (meta === null) return DecorationSet.empty;
        if (meta) return DecorationSet.create(tr.doc, [Decoration.inline(meta.from, meta.to, { class: 'ol-merge-focus' })]);
        return tr.docChanged ? deco.map(tr.mapping, tr.doc) : deco;
      },
    },
    props: { decorations: state => focusKey.getState(state) },
    view: view => new ReviewCard(view, source ?? null),
  });
}

/** this account's own AI, asked at most once a minute */
let linked: { at: number; via: Promise<string | null> } | null = null;
function linkedAi(): Promise<string | null> {
  if (!linked || Date.now() - linked.at > 60_000) linked = { at: Date.now(), via: api.aiLinked().then(r => r.via, () => null) };
  return linked.via;
}

type AiState = { status: 'loading'; ctrl: AbortController } | { status: 'ready'; r: AiMergeResult } | { status: 'error'; message: string };

class ReviewCard {
  private card: HTMLElement | null = null;
  private places: MergePlace[] = [];
  private index = 0;
  /** × was pressed: hidden until a merge comes that was not there then */
  private hidden = false;
  private known = new Set<string>();
  private via: string | null = null;
  private ai: AiState | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private unsubscribe: () => void;

  constructor(private view: EditorView, private source: MergeSource | null) {
    this.unsubscribe = source ? source.subscribe(() => this.schedule()) : () => {};
    window.addEventListener('resize', this.position);
    window.addEventListener('scroll', this.position, true);
    this.schedule();
  }

  update(view: EditorView, prev: EditorState): void { if (view.state.doc !== prev.doc) this.schedule(); }

  destroy(): void {
    clearTimeout(this.timer);
    this.unsubscribe();
    window.removeEventListener('resize', this.position);
    window.removeEventListener('scroll', this.position, true);
    if (this.ai?.status === 'loading') this.ai.ctrl.abort();
    this.card?.remove();
  }

  /** the entries arrive with the document's changes in one Yjs update, but not in one ProseMirror update: look a moment later */
  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(), 60);
  }

  private refresh(): void {
    if (!this.source || this.view.isDestroyed) return;
    const entries = this.source.list();
    // a new merge: shown again, and its reviewer ("<name> (offline)") into the author table the change bars read
    if (entries.some(e => !this.known.has(e.key))) { this.hidden = false; if (this.known.size || entries.some(e => !editorContext.meta?.authors.some(a => a.id === e.authorId))) editorContext.refreshAuthors?.(); }
    for (const e of entries) this.known.add(e.key);
    const before = this.places[this.index];
    this.places = mergePlaces(this.view.state.doc, entries);
    // the place being looked at stays the current one when places before it are settled
    const same = before ? this.places.findIndex(p => p.entry.key === before.entry.key && p.ranges[0].from === before.ranges[0].from) : -1;
    if (same >= 0) this.index = same;
    else { if (this.ai?.status === 'loading') this.ai.ctrl.abort(); this.ai = null; }
    this.index = Math.min(this.index, Math.max(0, this.places.length - 1));
    if (!this.places.length || this.hidden) { this.hide(); return; }
    void linkedAi().then(via => { if (via !== this.via) { this.via = via; this.render(); } });
    this.render();
  }

  private hide(): void {
    this.card?.remove();
    this.card = null;
    if (focusKey.getState(this.view.state)?.find().length) this.view.dispatch(this.view.state.tr.setMeta(focusKey, null).setMeta('addToHistory', false));
  }

  private get place(): MergePlace | undefined { return this.places[this.index]; }

  private whose(e: MergeEntry, cap = false): string {
    if (e.name === editorContext.user?.name) return cap ? 'Your' : 'your';
    return `${e.name}'s`;
  }

  private render(): void {
    const p = this.place;
    if (!p) { this.hide(); return; }
    const card = this.card ?? document.createElement('div');
    if (!this.card) {
      card.className = 'merge-review';
      card.setAttribute('role', 'dialog');
      card.setAttribute('aria-label', 'Offline edits to review');
      // clicks in the card leave the caret and the selection in the text alone
      card.addEventListener('mousedown', ev => { if ((ev.target as HTMLElement).closest('button')) ev.preventDefault(); });
      document.body.appendChild(card);
      this.card = card;
    }
    card.replaceChildren();
    const editable = this.view.editable;
    const el = (tag: string, cls: string, text?: string) => { const x = document.createElement(tag); x.className = cls; if (text !== undefined) x.textContent = text; return x; };
    const button = (label: string, cls: string, title: string, fn: () => void, disabled = false) => {
      const b = el('button', 'merge-review-btn ' + cls, label) as HTMLButtonElement;
      b.type = 'button'; b.title = title; b.disabled = disabled;
      b.addEventListener('click', () => fn());
      return b;
    };

    const head = el('div', 'merge-review-head');
    head.append(el('span', 'merge-review-title', 'Merged after working offline'));
    head.append(button('×', 'close', 'Hide — the changes stay in the text as suggestions', () => { this.hidden = true; this.hide(); }));
    card.append(head);
    const n = this.places.filter(x => x.entry === p.entry).length;
    card.append(el('div', 'merge-review-what', `${this.whose(p.entry, true)} offline edits and the current text changed the same words in ${n === 1 ? 'one place' : `${n} places`}. The offline version is shown as suggestions over the current text.`));

    const nav = el('div', 'merge-review-nav');
    nav.append(button('‹', 'step', 'Previous place', () => this.go(this.index - 1), this.places.length < 2));
    nav.append(el('span', 'merge-review-count', `${this.index + 1} of ${this.places.length}`));
    nav.append(button('›', 'step', 'Next place', () => this.go(this.index + 1), this.places.length < 2));
    nav.append(button('Show', 'show', 'Show this place in the text', () => this.go(this.index)));
    card.append(nav);

    if (editable) {
      const act = el('div', 'merge-review-actions');
      act.append(button('Keep current', 'keep-current', 'Keep the current text here (rejects the offline version)', () => this.settle([p], false)));
      act.append(button(`Keep ${this.whose(p.entry) === 'your' ? 'yours' : this.whose(p.entry)}`, 'keep-offline', 'Take the offline version here (accepts it)', () => this.settle([p], true)));
      if (this.via) act.append(button(`Combine…`, 'combine', `Ask ${this.via} (your own AI) for one version made from both`, () => void this.combine(), this.ai?.status === 'loading'));
      card.append(act);
      if (this.ai) card.append(this.aiBox(button));
      const others = this.places.length > 1;
      if (others) {
        const all = el('div', 'merge-review-all');
        all.append(el('span', '', 'All places: '));
        all.append(button('Keep current', 'link', 'Keep the current text everywhere', () => this.settle(this.places, false)));
        all.append(el('span', '', ' · '));
        all.append(button('Keep the offline versions', 'link', 'Take the offline version everywhere', () => this.settle(this.places, true)));
        card.append(all);
      }
    }
    this.position();
  }

  private aiBox(button: (label: string, cls: string, title: string, fn: () => void, disabled?: boolean) => HTMLButtonElement): HTMLElement {
    const box = document.createElement('div');
    box.className = 'merge-review-ai';
    const ai = this.ai!;
    if (ai.status === 'loading') { box.textContent = `Asking ${this.via ?? 'your AI'} for a combined version…`; return box; }
    if (ai.status === 'error') { box.classList.add('error'); box.textContent = ai.message; return box; }
    const label = document.createElement('div');
    label.className = 'merge-review-ai-label';
    label.textContent = `Combined by ${ai.r.via}:`;
    box.append(label);
    const preview = document.createElement('div');
    preview.className = 'merge-review-ai-text';
    try { preview.append(renderFragment(this.view, Fragment.fromJSON(schema, ai.r.nodes), this.place?.block)); }
    catch { preview.textContent = ai.r.tex; }
    box.append(preview);
    if (ai.r.note) { const note = document.createElement('div'); note.className = 'merge-review-ai-note'; note.textContent = ai.r.note; box.append(note); }
    const row = document.createElement('div');
    row.className = 'merge-review-actions';
    row.append(button('Use this', 'use', 'Put the combined version in place of both', () => this.useCombined()));
    row.append(button('Discard', 'discard', 'Forget the proposal', () => { this.ai = null; this.render(); }));
    box.append(row);
    return box;
  }

  /** the card at the top right of the editor's visible box */
  private position = (): void => {
    const card = this.card;
    if (!card) return;
    let box = { top: 0, right: window.innerWidth };
    for (let e = this.view.dom.parentElement; e; e = e.parentElement) {
      const o = getComputedStyle(e).overflowY;
      if (o === 'auto' || o === 'scroll') { const r = e.getBoundingClientRect(); box = { top: r.top, right: r.right }; break; }
    }
    card.style.top = `${Math.max(8, box.top + 12)}px`;
    card.style.right = `${Math.max(8, window.innerWidth - box.right + 20)}px`;
  };

  private go(i: number): void {
    if (!this.places.length) return;
    const next = (i + this.places.length) % this.places.length;
    if (next !== this.index) { if (this.ai?.status === 'loading') this.ai.ctrl.abort(); this.ai = null; }
    this.index = next;
    const p = this.places[next];
    const from = p.ranges[0].from, to = p.ranges[p.ranges.length - 1].to;
    const { state } = this.view;
    try {
      const tr = state.tr.setSelection(TextSelection.near(state.doc.resolve(Math.min(from, state.doc.content.size))))
        .setMeta(focusKey, { from, to: Math.min(to, state.doc.content.size) }).setMeta('addToHistory', false).scrollIntoView();
      this.view.dispatch(tr);
    } catch { /* the place moved meanwhile */ }
    this.render();
  }

  /** Keep the current text (`accept` false) or the offline version at these places. */
  private settle(places: MergePlace[], accept: boolean): void {
    if (this.ai?.status === 'loading') this.ai.ctrl.abort();
    this.ai = null;
    const entries = new Set(places.map(p => p.entry));
    resolveChanges(places.flatMap(p => p.ranges), accept)(this.view.state, this.view.dispatch);
    this.view.dispatch(this.view.state.tr.setMeta(focusKey, null).setMeta('addToHistory', false));
    const left = mergePlaces(this.view.state.doc, [...entries]);
    for (const e of entries) if (!left.some(p => p.entry === e)) this.source?.dismiss(e.key);
    this.refresh();
  }

  /** The account's AI proposes one version of the current place's paragraph made from both. */
  private async combine(): Promise<void> {
    const p = this.place;
    if (!p) return;
    const state = this.view.state;
    const current = versionOf(state, p, false), offline = versionOf(state, p, true);
    if (!current || !offline) return;
    const ctrl = new AbortController();
    this.ai = { status: 'loading', ctrl };
    this.render();
    const around = (dir: -1 | 1): string => {
      const $p = state.doc.resolve(p.block);
      const index = $p.index(), parent = $p.parent;
      const sib = parent.maybeChild(index + dir);
      return sib ? nodeText(sib).slice(dir < 0 ? -600 : 0, dir < 0 ? undefined : 600) : '';
    };
    try {
      const r = await api.aiMerge(viewDocId(this.view), {
        current: current.content.toJSON() ?? [], offline: offline.content.toJSON() ?? [], layout: current.attrs.layout,
        name: p.entry.name, before: around(-1), after: around(1),
      }, ctrl.signal);
      if (this.ai?.status !== 'loading' || this.ai.ctrl !== ctrl) return;
      this.ai = { status: 'ready', r };
    } catch (e) {
      if (ctrl.signal.aborted || this.ai?.status !== 'loading' || this.ai.ctrl !== ctrl) return;
      this.ai = { status: 'error', message: `No combined version: ${(e as Error)?.message ?? e}` };
    }
    this.render();
  }

  /** The combined version in place of the paragraph's two (as little replaced as differs from the current text). */
  private useCombined(): void {
    const p = this.place, ai = this.ai;
    if (!p || ai?.status !== 'ready') return;
    let frag: Fragment;
    try { frag = Fragment.fromJSON(schema, ai.r.nodes); } catch { return; }
    // the current text first (the offline suggestions rejected), then the combined text over it
    let rejected: Transaction | null = null;
    resolveChanges(p.ranges, false)(this.view.state, t => { rejected = t; });
    let block = p.block;
    if (rejected) { const t = rejected as Transaction; block = t.mapping.map(p.block); this.view.dispatch(t); }
    const state = this.view.state, node = state.doc.nodeAt(block);
    if (!node?.isTextblock) return;
    const content = isInlineFragment(frag) ? frag : frag.childCount === 1 && frag.firstChild!.isTextblock ? frag.firstChild!.content : null;
    let tr = state.tr;
    if (content) {
      const start = node.content.findDiffStart(content);
      if (start !== null) {
        let { a, b } = node.content.findDiffEnd(content)!;
        const overlap = start - Math.min(a, b);
        if (overlap > 0) { a += overlap; b += overlap; }
        tr = tr.replaceWith(block + 1 + start, block + 1 + a, content.cut(start, b));
      }
    } else if (frag.childCount) tr = tr.replaceRange(block, block + node.nodeSize, new Slice(frag, 0, 0));
    this.ai = null;
    if (tr.docChanged) this.view.dispatch(tr.setMeta(focusKey, null).scrollIntoView());
    const left = mergePlaces(this.view.state.doc, [p.entry]);
    if (!left.length) this.source?.dismiss(p.entry.key);
    this.refresh();
  }
}

/**
 * A simulation of LessWrong's agent API for the tests (and the e2e stub, OVERLYX_E2E_LESSWRONG_STUB=1):
 * drafts as top-level blocks of paragraphs, read back as markdown in LessWrong's dialect (`*   `
 * bullets), edited the way its tools edit (app/api/agent/*): a quote matched once in the rendered
 * text, case and punctuation folded; a prefix matched at the start of a top-level block or a list
 * item; insertions at the top level only; a list item deleted on its own, any other block whole.
 * Open suggestions can be planted (`suggest`) and show as `<ins>…</ins>`; comment threads with
 * the link-sharing key only, as on LessWrong.
 */
import type { LyxDocument, Paragraph } from '@overlyx/core';
import { writeMarkdown, parseMarkdown } from '@overlyx/core/md/index.ts';
import { normalize } from '@overlyx/core/md/parse.ts';
import { readBlocks, atoms, shownText, parText, normText } from './model.ts';
import { LessWrongApiError, type LessWrongApi, type LwThread, type LwEdit } from './api.ts';

interface FakePost { title: string; key: string | null; ctx: LyxDocument; blocks: Paragraph[][]; list: boolean[]; threads: (LwThread & { open: boolean })[]; suggestions: { after: string; text: string }[] }

/** (post ids unique across simulations: links are by post) */
let postCount = 0;

export class FakeLessWrong implements LessWrongApi {
  posts = new Map<string, FakePost>();
  /** edits made through the API (replace, insert, delete) */
  edits = 0;
  private n = 0;

  create(title: string, markdown = '', key: string | null = null): string {
    const id = 'fakepost' + String(++postCount).padStart(9, '0');
    this.posts.set(id, { title, key, ctx: parseMarkdown('').doc, blocks: [], list: [], threads: [], suggestions: [] });
    this.load(id, markdown);
    return id;
  }

  private post(id: string, key: string | null): FakePost {
    const p = this.posts.get(id);
    if (!p) throw new LessWrongApiError('Post not found or access denied');
    if (key !== null && p.key !== key) throw new LessWrongApiError('Unauthorized to access this post\'s draft');
    return p;
  }

  private load(id: string, markdown: string): void {
    const p = this.posts.get(id)!;
    const r = readBlocks(markdown);
    p.ctx = r.doc;
    p.blocks = r.blocks.map(b => b.pars.map(x => x.par));
    p.list = r.blocks.map(b => b.list);
  }

  /** the draft as LessWrong's read API gives it */
  markdown(id: string): string {
    const p = this.posts.get(id)!;
    // (Turndown's bullets: `*` and three spaces, nested lists four spaces in)
    let md = writeMarkdown({ ...p.ctx, body: p.blocks.flat() }).text.replace(/^((?: {2})*)- /gm, (_m, ind: string) => '    '.repeat(ind.length / 2) + '*   ');
    for (const s of p.suggestions) { const at = md.indexOf(s.after); if (at >= 0) md = md.slice(0, at + s.after.length) + `<ins>${s.text}</ins>` + md.slice(at + s.after.length); }
    return md;
  }

  /** a collaborator's edit on LessWrong (of the markdown) */
  edit(id: string, from: string, to: string): void {
    const md = this.markdown(id);
    if (!md.includes(from)) throw new Error(`not in the draft: ${from}`);
    this.load(id, md.replace(from, to));
  }

  /** an open suggestion: `text` suggested after `after` */
  suggest(id: string, after: string, text: string): void { this.posts.get(id)!.suggestions.push({ after, text }); }

  /** a comment on LessWrong by `by` */
  comment(id: string, quote: string, text: string, by = 'Kirsten'): string {
    const p = this.posts.get(id)!;
    const tid = 'thread' + String(++this.n);
    p.threads.push({ id: tid, type: 'comment', quote, comments: [{ author: by, time: Date.now(), text }], open: true });
    return tid;
  }
  reply(id: string, threadId: string, text: string, by = 'Kirsten'): void { this.posts.get(id)!.threads.find(t => t.id === threadId)!.comments.push({ author: by, time: Date.now(), text }); }
  resolve(id: string, threadId: string): void { this.posts.get(id)!.threads.find(t => t.id === threadId)!.open = false; }
  threads(id: string) { return this.posts.get(id)!.threads; }

  /* the API */

  async readPost(postId: string, key: string | null) {
    const p = this.post(postId, key);
    return { id: postId, title: p.title, draft: true, markdown: this.markdown(postId) };
  }

  /** paragraphs where a rendered quote is: [block, paragraph] pairs */
  private where(p: FakePost, text: string): [number, number][] {
    const out: [number, number][] = [];
    p.blocks.forEach((b, i) => b.forEach((par, k) => { const t = parText(par); for (let at = t.indexOf(text); at >= 0; at = t.indexOf(text, at + 1)) out.push([i, k]); }));
    return out;
  }

  async replaceText(postId: string, key: string | null, a: { quote: string; replacement: string }): Promise<LwEdit> {
    const p = this.post(postId, key);
    const q = normText(parseMarkdown(a.quote).doc.body.map(parText).join(' '));
    const hits = this.where(p, q);
    if (hits.length !== 1) return { ok: false, note: hits.length ? `Quote is ambiguous: it appears ${hits.length} times in the document` : 'Quote not found in document.' };
    const [bi, pi] = hits[0];
    const par = p.blocks[bi][pi];
    const A = atoms(par);
    // the words the quote covers
    for (let l = 0; l < A.length; l++) for (let r = l + 1; r <= A.length; r++) {
      if (A[l].space || A[r - 1].space) continue;
      if (normText(A.slice(l, r).map(x => shownText(x.item)).join('')) !== q) continue;
      const repl = parseMarkdown(a.replacement).doc.body[0]?.items ?? [];
      p.blocks[bi][pi] = { ...par, items: normalize([...A.slice(0, l).map(x => x.item), ...repl, ...A.slice(r).map(x => x.item)]) };
      this.edits++;
      return { ok: true, note: 'Replaced.' };
    }
    return { ok: false, note: 'Quote text was found, but its boundaries could not be resolved to selection points.' };
  }

  /** the block or list item a prefix starts */
  private block(p: FakePost, prefix: string): { b: number; k: number } | string {
    const t = normText(parseMarkdown(prefix).doc.body.map(parText).join(' '));
    if (!t) return 'Prefix was empty after normalization.';
    const found: { b: number; k: number }[] = [];
    p.blocks.forEach((pars, b) => pars.forEach((par, k) => { if ((k === 0 || p.list[b]) && parText(par).startsWith(t)) found.push({ b, k }); }));
    if (found.length !== 1) return found.length ? `Ambiguous prefix: ${found.length} blocks start with it.` : 'No block starts with the given prefix.';
    return found[0];
  }

  async insertBlock(postId: string, key: string | null, a: { location: 'start' | 'end' | { after: string } | { before: string }; markdown: string }): Promise<LwEdit> {
    const p = this.post(postId, key);
    let at: number;
    if (a.location === 'start') at = 0;
    else if (a.location === 'end') at = p.blocks.length;
    else {
      const f = this.block(p, 'after' in a.location ? a.location.after : a.location.before);
      if (typeof f === 'string') return { ok: false, note: f };
      at = 'after' in a.location ? f.b + 1 : f.b;
    }
    const r = readBlocks(a.markdown);
    p.blocks.splice(at, 0, ...r.blocks.map(b => b.pars.map(x => x.par)));
    p.list.splice(at, 0, ...r.blocks.map(b => b.list));
    this.edits++;
    return { ok: true, note: 'Inserted markdown block into collaborative draft.' };
  }

  async deleteBlock(postId: string, key: string | null, a: { prefix: string }): Promise<LwEdit> {
    const p = this.post(postId, key);
    const f = this.block(p, a.prefix);
    if (typeof f === 'string') return { ok: false, note: f };
    if (p.list[f.b] && p.blocks[f.b].length > 1) p.blocks[f.b].splice(f.k, 1);
    else { p.blocks.splice(f.b, 1); p.list.splice(f.b, 1); }
    this.edits++;
    return { ok: true, note: 'Deleted.' };
  }

  async commentOnDraft(postId: string, key: string | null, a: { quote?: string; comment: string; agentName: string }) {
    const p = this.post(postId, key);
    const q = a.quote ? normText(parseMarkdown(a.quote).doc.body.map(parText).join(' ')) : '';
    const anchored = !!q && this.where(p, q).length === 1;
    const tid = 'thread' + String(++this.n);
    p.threads.push({ id: tid, type: 'comment', quote: anchored ? q : '', comments: [{ author: a.agentName, time: Date.now(), text: a.comment }], open: true });
    return { threadId: tid, anchored };
  }

  async readThreads(postId: string, key: string): Promise<LwThread[]> {
    const p = this.post(postId, key);
    if (p.key === null) throw new LessWrongApiError('Unable to access shared draft');
    return p.threads.filter(t => t.open).map(({ open: _open, ...t }) => ({ ...t, comments: t.comments.map(c => ({ ...c })) }));
  }

  async replyToComment(postId: string, key: string, a: { threadId: string; comment: string; agentName: string }): Promise<void> {
    const p = this.post(postId, key);
    const t = p.threads.find(x => x.id === a.threadId);
    if (!t) throw new LessWrongApiError(`Thread not found: ${a.threadId}`);
    t.comments.push({ author: a.agentName, time: Date.now(), text: a.comment });
  }
}

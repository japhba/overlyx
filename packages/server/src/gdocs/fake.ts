/**
 * A simulation of the Google Docs and Drive APIs the Google Docs sync uses (google.ts GoogleApi),
 * for the tests (tests/gdocs.test.ts) and the e2e stub (OVERLYX_E2E_GOOGLE_STUB, routes.ts),
 * modelled on the documented behaviour of documents.get / batchUpdate: body indices start at 1 after the section break, every paragraph ends with its newline, a table
 * takes one index before and after its rows, a row and a cell one each; inserting a newline
 * splits a paragraph (both halves keep its style), deleting a paragraph's newline joins it with
 * the next (which keeps the latter's style), the body's last newline cannot be deleted,
 * createParagraphBullets takes leading tabs as nesting levels and removes them, insertTable puts a
 * newline before the table, createFootnote makes a footnote holding " \n". Comments are anchored
 * to the characters they quote and lose their anchor when those characters are deleted.
 */
import type { DocsDocument, DocsTextStyle, DocsStructural, DocsParagraphElement } from './model.ts';
import type { GComment, GFile, GReply, GoogleApi } from './google.ts';
import { GoogleApiError } from './errors.ts';

interface Ch { ch: string; style: DocsTextStyle; foot?: string; id: number }
interface PStyle { namedStyleType: string; alignment: string; indentStart: number; shading?: boolean }
interface Para { k: 'p'; chars: Ch[]; ps: PStyle; bullet?: { listId: string; nestingLevel: number } }
interface Table { k: 't'; rows: Para[][][] }
type El = Para | Table;

let charIds = 0;
const newPara = (ps?: Partial<PStyle>): Para => ({ k: 'p', chars: [], ps: { namedStyleType: 'NORMAL_TEXT', alignment: 'START', indentStart: 0, ...ps } });
const paraSize = (p: Para) => p.chars.length + 1;
function elSize(e: El): number {
  if (e.k === 'p') return paraSize(e);
  return 2 + e.rows.reduce((s, r) => s + 1 + r.reduce((t, c) => t + 1 + c.reduce((u, p) => u + paraSize(p), 0), 0), 0);
}

/** the paragraph lists of a segment and its tables' cells, with their start indices */
function* paraLists(els: El[], base: number): Generator<{ list: El[]; base: number }> {
  yield { list: els, base };
  let at = base;
  for (const e of els) {
    if (e.k === 't') {
      let x = at + 1;
      for (const r of e.rows) {
        x += 1;
        for (const c of r) { x += 1; yield* paraLists(c, x); x += c.reduce((u, p) => u + paraSize(p), 0); }
      }
    }
    at += elSize(e);
  }
}

/** the paragraph containing `index` (insertion may be at its newline), searched in cells too */
function locate(els: El[], base: number, index: number): { list: El[]; i: number; start: number } {
  for (const { list, base: b } of paraLists(els, base)) {
    let at = b;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.k === 'p' && index >= at && index < at + paraSize(e)) return { list, i, start: at };
      at += elSize(e);
    }
  }
  throw new GoogleApiError(`Index ${index} is not in a paragraph`, 400);
}

export class FakeDoc {
  body: El[] = [newPara()];
  footnotes = new Map<string, El[]>();
  lists = new Map<string, boolean>();   // id → ordered
  revision = 1;
  constructor(public id: string, public title: string) {}

  /* ---- writing (batchUpdate requests) ---- */

  segment(segmentId?: string): { els: El[]; base: number } {
    if (!segmentId) return { els: this.body, base: 1 };
    const f = this.footnotes.get(segmentId);
    if (!f) throw new GoogleApiError('no segment ' + segmentId, 400);
    return { els: f, base: 0 };
  }

  insertText(index: number, text: string, segmentId?: string): void {
    const seg = this.segment(segmentId);
    const { list, i, start } = locate(seg.els, seg.base, index);
    let p = list[i] as Para;
    let off = index - start;
    const inherit = { ...(p.chars[off - 1]?.style ?? p.chars[off]?.style ?? {}) };
    for (const c of text.replace(/[\u0000-\u0008\u000c-\u001f]/g, m => (m === '\n' ? m : ''))) {
      if (c === '\n') {
        const q: Para = { k: 'p', chars: p.chars.slice(off), ps: { ...p.ps }, bullet: p.bullet ? { ...p.bullet } : undefined };
        p.chars = p.chars.slice(0, off);
        list.splice(list.indexOf(p) + 1, 0, q);
        p = q; off = 0;
        continue;
      }
      p.chars.splice(off++, 0, { ch: c, style: { ...inherit }, id: ++charIds });
    }
  }

  deleteRange(startIndex: number, endIndex: number, segmentId?: string): void {
    if (endIndex <= startIndex) return;
    const seg = this.segment(segmentId);
    const total = seg.base + seg.els.reduce((s, e) => s + elSize(e), 0);
    if (endIndex > total - 1) throw new GoogleApiError('Invalid deletion range: cannot delete the last newline of a segment', 400);
    // the paragraph list the range lies in (a cell's, or the segment's)
    for (const { list, base } of [...paraLists(seg.els, seg.base)].reverse()) {
      const end = base + list.reduce((s, e) => s + elSize(e), 0);
      if (startIndex >= base && endIndex <= end) { this.deleteIn(list, base, startIndex, endIndex); return; }
    }
    throw new GoogleApiError('Invalid deletion range', 400);
  }

  private deleteIn(list: El[], base: number, s: number, e: number): void {
    let at = base;
    const keep: El[] = [];
    let first: { p: Para; cut: number } | null = null;   // a paragraph cut from `cut` on (its newline deleted)
    for (const el of list) {
      const size = elSize(el), a = at, b = at + size;
      at = b;
      if (b <= s || a >= e) {
        if (first && a >= e && el.k === 'p' && a === e) {
          // the paragraph whose start the range ends at: joins the cut one (and lends it its style)
          first.p.chars = first.p.chars.concat(el.chars);
          first.p.ps = el.ps; first.p.bullet = el.bullet;
          first = null;
          continue;
        }
        keep.push(el);
        continue;
      }
      if (el.k === 't') {
        if (a >= s && b <= e) continue;   // the whole table
        throw new GoogleApiError('Invalid deletion range: a table can only be deleted whole', 400);
      }
      const from = Math.max(0, s - a), to = Math.min(size, e - a);
      if (first && from === 0 && to === size) continue;   // a paragraph in the middle of the range: gone
      if (first) {
        // the range ends inside this paragraph: its rest joins the cut paragraph, with its style
        first.p.chars = first.p.chars.concat(el.chars.slice(to));
        first.p.ps = el.ps; first.p.bullet = el.bullet;
        first = null;
        continue;
      }
      if (to === size) {
        // the newline goes: what follows joins
        el.chars = el.chars.slice(0, from);
        first = { p: el, cut: from };
        keep.push(el);
      } else {
        el.chars.splice(from, to - from);
        keep.push(el);
      }
    }
    if (first) throw new GoogleApiError('Invalid deletion range', 400);
    list.splice(0, list.length, ...keep);
  }

  paragraphsIn(startIndex: number, endIndex: number, segmentId?: string): Para[] {
    const seg = this.segment(segmentId);
    const out: Para[] = [];
    for (const { list, base } of paraLists(seg.els, seg.base)) {
      let at = base;
      for (const e of list) {
        const size = elSize(e);
        if (e.k === 'p' && at < endIndex && at + size > startIndex) out.push(e);
        at += size;
      }
    }
    return out;
  }

  charsIn(startIndex: number, endIndex: number, segmentId?: string): Ch[] {
    const seg = this.segment(segmentId);
    const out: Ch[] = [];
    for (const { list, base } of paraLists(seg.els, seg.base)) {
      let at = base;
      for (const e of list) {
        if (e.k === 'p') e.chars.forEach((c, k) => { if (at + k >= startIndex && at + k < endIndex) out.push(c); });
        at += elSize(e);
      }
    }
    return out;
  }

  insertTable(index: number, rows: number, columns: number): void {
    const { list, i, start } = locate(this.body, 1, index);
    const p = list[i] as Para;
    const before: Para = { k: 'p', chars: p.chars.slice(0, index - start), ps: { ...p.ps }, bullet: p.bullet ? { ...p.bullet } : undefined };
    p.chars = p.chars.slice(index - start);
    const t: Table = { k: 't', rows: Array.from({ length: rows }, () => Array.from({ length: columns }, () => [newPara()])) };
    list.splice(i, 0, before, t);
  }

  createFootnote(index: number): string {
    const id = 'kix.fn' + (this.footnotes.size + 1) + '_' + Math.random().toString(36).slice(2, 6);
    const { list, i, start } = locate(this.body, 1, index);
    (list[i] as Para).chars.splice(index - start, 0, { ch: '￼', foot: id, style: {}, id: ++charIds });
    const fp = newPara();
    fp.chars.push({ ch: ' ', style: {}, id: ++charIds });
    this.footnotes.set(id, [fp]);
    return id;
  }

  apply(req: Record<string, any>): Record<string, unknown> {
    const [kind, r] = Object.entries(req)[0];
    switch (kind) {
      case 'insertText': this.insertText(r.location.index, r.text, r.location.segmentId); return {};
      case 'deleteContentRange': this.deleteRange(r.range.startIndex, r.range.endIndex, r.range.segmentId); return {};
      case 'updateTextStyle': {
        const fields = String(r.fields).split(',');
        for (const c of this.charsIn(r.range.startIndex, r.range.endIndex, r.range.segmentId)) {
          for (const f of fields) {
            if (r.textStyle[f] !== undefined) (c.style as Record<string, unknown>)[f] = r.textStyle[f];
            else delete (c.style as Record<string, unknown>)[f];
          }
        }
        return {};
      }
      case 'updateParagraphStyle': {
        const fields = String(r.fields).split(',');
        for (const p of this.paragraphsIn(r.range.startIndex, r.range.endIndex, r.range.segmentId)) {
          const ps = r.paragraphStyle;
          if (fields.includes('namedStyleType')) p.ps.namedStyleType = ps.namedStyleType ?? 'NORMAL_TEXT';
          if (fields.includes('alignment')) p.ps.alignment = ps.alignment ?? 'START';
          if (fields.includes('indentStart')) p.ps.indentStart = ps.indentStart?.magnitude ?? 0;
          if (fields.includes('shading')) p.ps.shading = !!ps.shading;
        }
        return {};
      }
      case 'createParagraphBullets': {
        const id = 'kix.list' + (this.lists.size + 1);
        this.lists.set(id, String(r.bulletPreset).startsWith('NUMBERED'));
        for (const p of this.paragraphsIn(r.range.startIndex, r.range.endIndex)) {
          let tabs = 0;
          while (p.chars[0]?.ch === '\t') { p.chars.shift(); tabs++; }
          p.bullet = { listId: id, nestingLevel: tabs };
          p.ps.indentStart = 36 * (tabs + 1);
        }
        return {};
      }
      case 'deleteParagraphBullets':
        // "the nesting level of each paragraph will be visually preserved by adding indent to the start of the paragraph"
        for (const p of this.paragraphsIn(r.range.startIndex, r.range.endIndex)) { if (p.bullet) p.ps.indentStart = 36 * (p.bullet.nestingLevel + 1); delete p.bullet; }
        return {};
      case 'insertTable': this.insertTable(r.location.index, r.rows, r.columns); return {};
      case 'createFootnote': return { createFootnote: { footnoteId: this.createFootnote(r.location.index) } };
      default: throw new GoogleApiError('Unknown request ' + kind, 400);
    }
  }

  /* ---- reading (documents.get) ---- */

  private paraJson(p: Para, start: number): DocsStructural {
    const elements: DocsParagraphElement[] = [];
    let at = start;
    let run: { content: string; style: DocsTextStyle; start: number } | null = null;
    const flush = () => { if (run) { elements.push({ startIndex: run.start, endIndex: run.start + run.content.length, textRun: { content: run.content, textStyle: { ...run.style } } }); run = null; } };
    for (const c of p.chars) {
      if (c.foot) { flush(); elements.push({ startIndex: at, endIndex: at + 1, footnoteReference: { footnoteId: c.foot } }); at++; continue; }
      if (run && JSON.stringify(run.style) === JSON.stringify(c.style)) run.content += c.ch;
      else { flush(); run = { content: c.ch, style: c.style, start: at }; }
      at++;
    }
    if (run) (run as { content: string }).content += '\n'; else run = { content: '\n', style: {}, start: at };
    flush();
    const paragraphStyle: Record<string, unknown> = { namedStyleType: p.ps.namedStyleType, alignment: p.ps.alignment };
    if (p.ps.indentStart) paragraphStyle.indentStart = { magnitude: p.ps.indentStart, unit: 'PT' };
    return { startIndex: start, endIndex: start + paraSize(p), paragraph: { elements, paragraphStyle, ...(p.bullet ? { bullet: { listId: p.bullet.listId, nestingLevel: p.bullet.nestingLevel } } : {}) } };
  }

  private contentJson(els: El[], base: number): DocsStructural[] {
    const out: DocsStructural[] = [];
    let at = base;
    for (const e of els) {
      if (e.k === 'p') { out.push(this.paraJson(e, at)); at += paraSize(e); continue; }
      const tStart = at;
      let x = at + 1;
      const tableRows = e.rows.map(r => {
        x += 1;
        return {
          tableCells: r.map(c => {
            x += 1;
            const content = this.contentJson(c, x);
            x += c.reduce((u, p) => u + paraSize(p), 0);
            return { content };
          }),
        };
      });
      at += elSize(e);
      out.push({ startIndex: tStart, endIndex: at, table: { rows: e.rows.length, columns: e.rows[0]?.length ?? 0, tableRows } });
    }
    return out;
  }

  json(): DocsDocument {
    const lists: DocsDocument['lists'] = {};
    for (const [id, ordered] of this.lists) lists[id] = { listProperties: { nestingLevels: Array.from({ length: 9 }, () => (ordered ? { glyphType: 'DECIMAL' } : { glyphSymbol: '●' })) } };
    const footnotes: DocsDocument['footnotes'] = {};
    for (const [id, els] of this.footnotes) footnotes[id] = { footnoteId: id, content: this.contentJson(els, 0) };
    return { documentId: this.id, title: this.title, revisionId: 'rev' + this.revision, body: { content: [{ endIndex: 1, sectionBreak: {} } as DocsStructural, ...this.contentJson(this.body, 1)] }, lists, footnotes };
  }

  /** the body as text lines (tests) */
  text(): string {
    const out: string[] = [];
    const walk = (els: El[]) => { for (const e of els) { if (e.k === 'p') out.push(e.chars.map(c => (c.foot ? `[^${this.footnotes.get(c.foot)?.map(p => (p as Para).chars.map(x => x.ch).join('')).join('').trim()}]` : c.ch)).join('')); else for (const r of e.rows) out.push('| ' + r.map(c => c.map(p => (p as Para).chars.map(x => x.ch).join('')).join(' ')).join(' | ') + ' |'); } };
    walk(this.body);
    return out.join('\n');
  }

  /** the character at a body index (to anchor comments) */
  charAt(index: number): Ch | undefined {
    return this.charsIn(index, index + 1)[0];
  }
  /** the current body text of characters, by identity */
  hasChar(c: Ch): boolean { return this.charsIn(1, 1e9).includes(c); }
}

interface FakeComment extends GComment { anchorChars?: Ch[] }

/** The Docs and Drive APIs for any number of documents, acting as one Google account ("me"). */
export class FakeGoogle implements GoogleApi {
  docs = new Map<string, FakeDoc>();
  files = new Map<string, GFile & { version: string }>();
  comments = new Map<string, FakeComment[]>();
  /** the anchored comment request of the Docs API (in preview): off to test the Drive fallback */
  anchoredComments = true;
  batches = 0;
  requests: Record<string, unknown>[][] = [];
  me = 'Me Owner';
  private n = 0;

  private touch(id: string, by: string): void {
    const f = this.files.get(id)!;
    f.version = String(Number(f.version) + 1);
    f.lastModifyingUser = { displayName: by, me: by === this.me };
  }

  async createDocument(title: string): Promise<GFile> {
    const id = 'doc' + ++this.n;
    this.docs.set(id, new FakeDoc(id, title));
    const f = { id, name: title, webViewLink: `https://docs.google.com/document/d/${id}/edit`, version: '1', trashed: false };
    this.files.set(id, f);
    this.comments.set(id, []);
    return { ...f };
  }
  async getDocument(id: string): Promise<DocsDocument> { return JSON.parse(JSON.stringify(this.doc(id).json())); }
  doc(id: string): FakeDoc { const d = this.docs.get(id); if (!d) throw new GoogleApiError('File not found', 404); return d; }

  /** a batch by `by` (the sync is "me"; a collaborator's edits are made through here as well) */
  async batchUpdate(id: string, requests: Record<string, unknown>[], requiredRevisionId?: string, by = this.me): Promise<{ replies: Record<string, unknown>[]; revisionId: string }> {
    const d = this.doc(id);
    if (requiredRevisionId && requiredRevisionId !== 'rev' + d.revision) throw new GoogleApiError('The document was changed since the revision', 400, 'FAILED_PRECONDITION');
    // all or nothing, like the real API
    const backup = JSON.stringify({ body: d.body, footnotes: [...d.footnotes], lists: [...d.lists] });
    const replies: Record<string, unknown>[] = [];
    try {
      for (const r of requests) {
        if ('insertComment' in r) {
          if (!this.anchoredComments) throw new GoogleApiError('Invalid JSON payload received. Unknown name "insertComment"', 400);
          const ic = (r as { insertComment: { content: string; range: { startIndex: number; endIndex: number } } }).insertComment;
          const chars = d.charsIn(ic.range.startIndex, ic.range.endIndex);
          this.comments.get(id)!.push({ id: 'c' + ++this.n, content: ic.content, author: { displayName: this.me, me: true }, createdTime: new Date().toISOString(), resolved: false, quotedFileContent: { value: chars.map(c => c.ch).join('') }, anchor: 'kix.anchor', anchorChars: chars, replies: [] });
          replies.push({});
          continue;
        }
        replies.push(d.apply(r));
      }
    } catch (e) {
      const b = JSON.parse(backup);
      d.body = b.body; d.footnotes = new Map(b.footnotes); d.lists = new Map(b.lists);
      throw e;
    }
    d.revision++;
    this.batches++;
    this.requests.push(requests);
    this.touch(id, by);
    return { replies, revisionId: 'rev' + d.revision };
  }
  async getFile(id: string): Promise<GFile> { const f = this.files.get(id); if (!f) throw new GoogleApiError('File not found', 404); return { ...f }; }

  async listComments(id: string): Promise<GComment[]> {
    const d = this.doc(id);
    return (this.comments.get(id) ?? []).map(c => ({ ...c, anchorChars: undefined, replies: (c.replies ?? []).map(r => ({ ...r })), ...(c.anchorChars ? { anchored: c.anchorChars.every(x => d.hasChar(x)) } : {}) }));
  }
  async createComment(id: string, c: { content: string; quoted?: string; range?: { startIndex: number; endIndex: number } }): Promise<GComment> {
    if (c.range && this.anchoredComments) {
      await this.batchUpdate(id, [{ insertComment: { content: c.content, range: c.range } }]);
      return { ...this.comments.get(id)!.at(-1)!, anchorChars: undefined } as GComment;
    }
    const made: FakeComment = { id: 'c' + ++this.n, content: c.content, author: { displayName: this.me, me: true }, createdTime: new Date().toISOString(), resolved: false, quotedFileContent: c.quoted ? { value: c.quoted } : undefined, replies: [] };
    this.comments.get(id)!.push(made);
    return { ...made };
  }
  async createReply(id: string, commentId: string, r: { content?: string; action?: 'resolve' | 'reopen' }, by = this.me): Promise<GReply> {
    const c = this.comments.get(id)!.find(x => x.id === commentId);
    if (!c) throw new GoogleApiError('Comment not found', 404);
    const reply: GReply = { id: 'r' + ++this.n, content: r.content ?? '', author: { displayName: by, me: by === this.me }, createdTime: new Date().toISOString(), ...(r.action ? { action: r.action } : {}) };
    (c.replies ??= []).push(reply);
    if (r.action === 'resolve') c.resolved = true;
    if (r.action === 'reopen') c.resolved = false;
    return { ...reply };
  }

  /* ---- a collaborator in Google Docs ---- */

  /** a comment by `by` on the body characters [start, end) */
  comment(id: string, start: number, end: number, content: string, by = 'Kirsten'): GComment {
    const d = this.doc(id);
    const chars = d.charsIn(start, end);
    const c: FakeComment = { id: 'c' + ++this.n, content, author: { displayName: by, me: false }, createdTime: '2026-10-04T09:30:00Z', resolved: false, quotedFileContent: { value: chars.map(x => x.ch).join('') }, anchor: 'kix.x', anchorChars: chars, replies: [] };
    this.comments.get(id)!.push(c);
    this.touch(id, by);
    return c;
  }
  /** the body index of `text` (its first occurrence) */
  indexOf(id: string, text: string): number {
    const raw = this.doc(id).json();
    for (const s of raw.body.content) {
      if (!s.paragraph) continue;
      const t = s.paragraph.elements.map(e => e.textRun?.content ?? '￼').join('');
      const k = t.indexOf(text);
      if (k >= 0) return (s.startIndex ?? 0) + k;
    }
    throw new Error('not in the Google Doc: ' + text);
  }
  /** is the comment still anchored to text that exists? */
  anchored(id: string, commentId: string): boolean {
    const c = this.comments.get(id)!.find(x => x.id === commentId)!;
    return !!c.anchorChars?.length && c.anchorChars.every(x => this.doc(id).hasChar(x));
  }
}

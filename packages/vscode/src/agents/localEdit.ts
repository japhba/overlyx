/**
 * The local tools' work: an agent on this computer (Claude Code, Codex) edits a document, and the
 * edit lands as tracked changes attributed to the agent — the same diff the server applies to its
 * MCP agents' edits (core lyx/docedit.ts), written the way the extension saves (untouched
 * paragraphs keep their LaTeX byte for byte). Where the text comes from and goes to is a TextStore:
 * the file itself, or — when a VS Code window has the document open — that window's editor, so the
 * diff applies to what the user sees, unsaved typing included (host/agents.ts). The user accepts or
 * rejects the changes in the editor.
 *
 * No VS Code API here: the tool server (agents/server.ts) runs as its own process, started by the
 * agent, and hands edits of open documents to the extension, which runs runTool itself.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  applyTrackedSource, applyPlainSource, replaceInSource, EditError, type EditableDoc,
} from '@overlyx/core/lyx/docedit.ts';
import { paragraph, textItem, textInset, insetItem, itemText, type LyxDocument, type Paragraph, type TextInset, type Item } from '@overlyx/core';
import { commentHeader, formatTimestamp, parseHeader, parseThread } from '@overlyx/core/comments.ts';
import { isMarkdownPath } from '@overlyx/core/md/index.ts';
import { primePreserveCache, type PreserveCache, type ParseTexResult } from '@overlyx/core/tex/index.ts';
import { parseDocumentText, writeDocumentText, includeResolver, type TexContext } from '../host/texdoc.ts';
import { projectDirFor, findMaster } from '../host/project.ts';
import { hasSettingsLine, MANAGED_BEGIN } from '@overlyx/core/tex/preamble.ts';

export { EditError };

export interface LocalContext {
  /** where relative paths start: the agent's working directory */
  cwd: string;
  /** LyX layout files (lyxlib.ts) */
  layoutDir: string;
  /** whose changes these are: "Claude Code", "Codex", … */
  author: string;
  /** whether a file is open in an OverLyX editor (openDocuments.ts) */
  isOpen: (absolutePath: string) => boolean;
  /** where a document's text is read from and written to (default: the file) */
  store?: (absolutePath: string) => TextStore | undefined;
}

/** A document's text: the file, or an open editor's (host/agents.ts). */
export interface TextStore {
  read(): string;
  write(text: string): Promise<void>;
}

const fileStore = (abs: string): TextStore => ({ read: () => readText(abs), write: async text => fs.writeFileSync(abs, text) });

const DOC_MAX = 8 * 1024 * 1024;

/** A document file: its project directory (project.ts projectDirFor — a child document's is its master's), path inside it, text. */
interface DocFile { abs: string; ctx: TexContext; relPath: string }

function locate(file: string, lc: LocalContext, mustExist = true): DocFile {
  if (!file?.trim()) throw new EditError('path is missing');
  const abs = path.resolve(lc.cwd, file);
  if (!abs.endsWith('.tex') && !isMarkdownPath(abs)) throw new EditError(`${file}: a .tex or .md document is expected — edit other files directly`);
  if (mustExist && !fs.existsSync(abs)) throw new EditError(`${file} does not exist (relative paths start at ${lc.cwd})`);
  const root = projectDirFor(abs);
  const f = { abs, ctx: { root, layoutDir: lc.layoutDir }, relPath: path.relative(root, abs) };
  if (fs.existsSync(abs) && !isOverlyxDocument(f, lc)) {
    throw new EditError(`${file} is not an OverLyX document (no "%% OverLyX" block, not open in the OverLyX editor): edit it directly with your own tools, as you would without OverLyX. If the user wants your edits in it as tracked changes, they open it in the OverLyX editor first.`);
  }
  return f;
}

/**
 * Tracked changes and comment threads only go where OverLyX is in use — never into a README or
 * somebody's plain LaTeX: a file open in an OverLyX editor, a .tex file OverLyX has written (its
 * block in the preamble), or a child document of such a master.
 */
function isOverlyxDocument(f: DocFile, lc: LocalContext): boolean {
  if (lc.isOpen(f.abs)) return true;
  if (!f.abs.endsWith('.tex')) return false;
  const written = (abs: string) => { try { const t = readText(abs); return hasSettingsLine(t) || t.includes(MANAGED_BEGIN); } catch { return false; } };
  if (written(f.abs)) return true;
  const master = findMaster(f.ctx.root, f.relPath);
  return !!master && written(path.join(f.ctx.root, master));
}

/** The file's text; a file that is not UTF-8 is refused (writing it back would change its other bytes). */
function readText(abs: string): string {
  const buf = fs.readFileSync(abs);
  if (buf.length > DOC_MAX) throw new EditError(`${path.basename(abs)} is too large`);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { throw new EditError(`${path.basename(abs)} is not UTF-8 — edit it directly`); }
}

/** Commands an edit stopped defining, per file, for later edits of the same session (docedit.ts retireMacros). */
const retired = new Map<string, Set<string>>();

/** The file as docedit.ts's EditableDoc: `text` is the document as it will be written. */
class FileDocument implements EditableDoc {
  private cache: PreserveCache = {};
  private fragment: boolean;
  retiredMacros: Set<string>;

  constructor(readonly f: DocFile, public text: string) {
    const parsed = this.parsed();
    this.fragment = parsed.fragment;
    primePreserveCache(this.cache, text, parsed);
    this.retiredMacros = retired.get(f.abs) ?? new Set();
    retired.set(f.abs, this.retiredMacros);
  }

  /** the current text's parse, with each body paragraph's source range */
  parsed(): ParseTexResult { return parseDocumentText(this.text, this.f.ctx, this.f.relPath); }
  parse(text: string): LyxDocument { return parseDocumentText(text, this.f.ctx, this.f.relPath).doc; }
  toLyxDocument(): LyxDocument { return this.parse(this.text); }
  toText(): string { return this.text; }
  textOf(doc: LyxDocument): string {
    return writeDocumentText(doc, this.f.ctx, this.f.relPath, this.fragment, includeResolver(this.f.ctx, this.f.relPath), { base: this.text, cache: this.cache }).text;
  }
  loadFromLyx(doc: LyxDocument): void { this.text = this.textOf(doc); }
  edited(): void { /* written by `change` */ }
}

/** One edit at a time per file (an agent's parallel tool calls): the second reads the first one's result. */
const locks = new Map<string, Promise<unknown>>();
async function serialized<T>(abs: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(abs) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  locks.set(abs, run);
  try { return await run; }
  finally { if (locks.get(abs) === run) locks.delete(abs); }
}

/**
 * Apply `edit` to the document's current text and write the result — unless the text changed while
 * it was computed (the user saved, another agent wrote): then again on the new text.
 */
async function change<T>(f: DocFile, lc: LocalContext, edit: (doc: FileDocument) => T): Promise<{ result: T; before: string; after: string }> {
  const store = lc.store?.(f.abs) ?? fileStore(f.abs);
  return serialized(f.abs, async () => {
    for (let attempt = 0; ; attempt++) {
      const before = store.read();
      const doc = new FileDocument(f, before);
      const result = edit(doc);
      if (doc.text === before) return { result, before, after: before };
      if (store.read() !== before && attempt < 3) continue;
      await store.write(doc.text);
      return { result, before, after: doc.text };
    }
  });
}

const parseWarnings = (f: DocFile, text: string): string[] => parseDocumentText(text, f.ctx, f.relPath).warnings.slice(0, 20);

const SAME = 'The edit parsed to the same document — nothing changed (e.g. only whitespace differed).';

export async function editDocument(file: string, a: { old_text: string; new_text: string; replace_all?: boolean; tracked?: boolean }, lc: LocalContext) {
  const f = locate(file, lc);
  const tracked = a.tracked ?? true;
  let warnings: string[] = [];
  const { result: st } = await change(f, lc, doc => {
    const after = replaceInSource(doc.text, a.old_text, a.new_text, !!a.replace_all);
    warnings = parseWarnings(f, after);
    return tracked ? applyTrackedSource(doc, doc.text, after, lc.author) : { ...applyPlainSource(doc, doc.text, after), inserted: 0, deleted: 0, direct: [] };
  });
  if (!tracked) return { ok: true, tracked: false, warnings, ...(st.changed ? {} : { note: SAME }), now_reads: st.excerpt };
  return {
    ok: true, inserted_chars: st.inserted, deleted_chars: st.deleted, warnings,
    ...(!st.changed ? { note: SAME }
      : st.inserted + st.deleted === 0 && !st.direct.length ? { note: 'Applied; nothing in it needed a tracked-change mark (e.g. it took back text of your own pending insertion).' } : {}),
    ...(st.direct.length ? { applied_directly: st.direct } : {}),
    now_reads: st.excerpt,
  };
}

export async function writeDocument(file: string, a: { tex: string; tracked?: boolean }, lc: LocalContext) {
  if (!a.tex?.trim()) throw new EditError('tex is missing');
  if (a.tex.length > DOC_MAX) throw new EditError('tex is too large');
  const f = locate(file, lc, false);
  if (!fs.existsSync(f.abs)) {
    const warnings = parseWarnings(f, a.tex);   // a source that does not parse fails here, before anything is written
    fs.mkdirSync(path.dirname(f.abs), { recursive: true });
    fs.writeFileSync(f.abs, a.tex, { flag: 'wx' });
    return { ok: true, created: true, warnings };
  }
  const tracked = a.tracked ?? true;
  const warnings = parseWarnings(f, a.tex);
  const { result: st } = await change(f, lc, doc => tracked ? applyTrackedSource(doc, doc.text, a.tex, lc.author) : { ...applyPlainSource(doc, doc.text, a.tex), inserted: 0, deleted: 0, direct: [] });
  if (!tracked) return { ok: true, created: false, tracked: false, changed: st.changed, warnings };
  return {
    ok: true, created: false, warnings, inserted_chars: st.inserted, deleted_chars: st.deleted,
    ...(st.direct.length ? { applied_directly: st.direct } : {}),
    note: st.changed ? 'Applied as tracked changes against the current file — only what differs is marked; the user accepts or rejects them in the OverLyX editor.' : 'The source parsed to the same document — nothing changed.',
  };
}

/* ------------------------------------------------------------------ comments */

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The comment threads of a document (Note Comment insets), anywhere: in floats, footnotes, table cells too. */
function commentInsets(doc: LyxDocument): TextInset[] {
  const out: TextInset[] = [];
  const visit = (pars: Paragraph[]): void => {
    for (const p of pars) for (const it of p.items) {
      if (it.kind !== 'inset') continue;
      const ins = it.inset;
      if (ins.type === 'Text' && ins.name === 'Note' && ins.arg === 'Comment') out.push(ins);
      else if (ins.type === 'Text') visit(ins.paragraphs);
      else if (ins.type === 'Tabular') for (const r of ins.rows) for (const c of r.cells) visit(c.paragraphs);
    }
  };
  visit(doc.body);
  return out;
}

const messageParagraphs = (author: string, text: string): Paragraph[] => [
  paragraph('Plain Layout', [textItem(commentHeader(author, formatTimestamp()))]),
  ...text.split('\n').map(line => paragraph('Plain Layout', [textItem(line)])),
];

/**
 * Where a comment on `at` goes: right after that passage when it is plain text within one stretch
 * of the paragraph, else at the end of the paragraph whose LaTeX contains it.
 */
function placeComment(doc: FileDocument, at: string | undefined, comment: Item): void {
  const parsed = doc.parsed();
  const lyx = parsed.doc;
  if (!lyx.body.length) throw new EditError('the document has no paragraphs');
  let target = lyx.body.length - 1;
  if (at?.trim()) {
    const needle = collapse(at);
    // 1. inside a text stretch of one paragraph: split it there
    for (const p of lyx.body) {
      for (let i = 0; i < p.items.length; i++) {
        const it = p.items[i];
        if (it.kind !== 'text' || it.change?.type === 'deleted') continue;
        const k = collapse(it.text).indexOf(needle);
        if (k < 0) continue;
        const end = rawOffset(it.text, k + needle.length);
        p.items.splice(i, 1, { ...it, text: it.text.slice(0, end) }, comment, ...(end < it.text.length ? [{ ...it, text: it.text.slice(end) }] : []));
        doc.loadFromLyx(lyx);
        return;
      }
    }
    // 2. the paragraph whose source (or plain text) contains it
    const text = doc.text.replace(/\r\n/g, '\n');
    const hits = parsed.sources.map((s, i) => ({ i, src: s ? collapse(text.slice(s.start, s.end)) : '' }))
      .filter(x => x.src.includes(needle) || collapse(lyx.body[x.i].items.map(itemText).join('')).includes(needle));
    if (!hits.length) throw new EditError(`"${at.slice(0, 80)}" was not found in the document — quote a passage of its text`);
    if (hits.length > 1) throw new EditError(`"${at.slice(0, 80)}" occurs in ${hits.length} paragraphs — quote more of it`);
    target = hits[0].i;
  }
  lyx.body[target].items.push(comment);
  doc.loadFromLyx(lyx);
}

/** The offset into `raw` at which its whitespace-collapsed form (leading whitespace dropped) reaches `n` characters. */
function rawOffset(raw: string, n: number): number {
  let seen = 0, i = 0, space = true;
  while (i < raw.length && /\s/.test(raw[i])) i++;
  for (; i < raw.length && seen < n; i++) {
    if (/\s/.test(raw[i])) { if (!space) { seen++; space = true; } }
    else { seen++; space = false; }
  }
  return i;
}

export async function addComment(file: string, a: { text: string; at?: string }, lc: LocalContext) {
  if (!a.text?.trim()) throw new EditError('text is missing');
  const f = locate(file, lc);
  const inset = textInset('Note', 'Comment', messageParagraphs(lc.author, a.text.trim()), 'open');
  await change(f, lc, doc => placeComment(doc, a.at, insetItem(inset)));
  return { ok: true, note: a.at ? 'Comment added at that passage.' : 'Comment added at the end of the document.' };
}

export async function replyToComment(file: string, a: { comment: string; text?: string; resolve?: boolean }, lc: LocalContext) {
  if (!a.comment?.trim()) throw new EditError('comment is missing: quote a passage of the thread');
  if (!a.text?.trim() && !a.resolve) throw new EditError('nothing to do: give text (a reply), resolve: true, or both');
  const f = locate(file, lc);
  const needle = collapse(a.comment);
  const { result } = await change(f, lc, doc => {
    const lyx = doc.toLyxDocument();
    const threads = commentInsets(lyx);
    const hits = threads.filter(t => collapse(t.paragraphs.map(p => p.items.map(itemText).join('')).join('\n')).includes(needle));
    if (!hits.length) throw new EditError(`no comment thread contains "${a.comment.slice(0, 80)}"${threads.length ? ` — the document's threads begin: ${threads.slice(0, 8).map(t => JSON.stringify(collapse(parseThread(t.paragraphs).messages[0]?.text ?? '').slice(0, 50))).join(', ')}` : ' — the document has none'}`);
    if (hits.length > 1) throw new EditError(`${hits.length} comment threads contain "${a.comment.slice(0, 80)}" — quote more of the one you mean`);
    const thread = hits[0];
    if (a.text?.trim()) thread.paragraphs.push(...messageParagraphs(lc.author, a.text.trim()));
    let resolved = parseThread(thread.paragraphs).resolved;
    if (a.resolve && !resolved) {
      const first = thread.paragraphs[0];
      const h = parseHeader(first.items.map(itemText).join('').trim());
      if (h) first.items = [textItem(commentHeader(h.author, h.time, true))];
      else thread.paragraphs.unshift(paragraph('Plain Layout', [textItem(commentHeader('', formatTimestamp(), true))]));
      resolved = true;
    }
    doc.loadFromLyx(lyx);
    return { resolved };
  });
  return { ok: true, replied: !!a.text?.trim(), resolved: result.resolved };
}

/* ------------------------------------------------------------------ the tools by name */

export const TOOL_NAMES = ['edit_document', 'write_document', 'add_comment', 'reply_to_comment'] as const;
export type ToolName = typeof TOOL_NAMES[number];

/** A tool call (the tool server's, or one it handed to the extension): `args` as the agent sent them. */
export function runTool(name: ToolName, args: Record<string, unknown>, lc: LocalContext): Promise<unknown> {
  const p = String(args.path ?? ''), a = args as never;   // the tools check their arguments themselves
  switch (name) {
    case 'edit_document': return editDocument(p, a, lc);
    case 'write_document': return writeDocument(p, a, lc);
    case 'add_comment': return addComment(p, a, lc);
    case 'reply_to_comment': return replyToComment(p, a, lc);
    default: throw new EditError(`unknown tool ${String(name)}`);
  }
}

/** The document a tool call is about, as an absolute path. */
export const toolTarget = (args: Record<string, unknown>, cwd: string): string => path.resolve(cwd, String(args.path ?? ''));

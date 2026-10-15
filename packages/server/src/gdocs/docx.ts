/**
 * A disposable, accepted-view DOCX for a Google Docs import (the first, and each upload of changed
 * formulas or images). With `comments`, the open comment threads go along as Word comments on the
 * text they follow (markThreads): Google's converter makes anchored Google Docs comments of them,
 * which the sync then takes over (sync.ts adoptComments).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { paramMap, parseThread, unquote, type CommentMessage, type Item, type LyxDocument, type Paragraph } from '@overlyx/core';
import { writeMarkdown } from '@overlyx/core/md/index.ts';
import { config } from '../config.ts';
import { resolveProjectPath } from '../projectfiles.ts';
import { sandboxed } from '../sandbox.ts';
import { toPng } from '../graphics.ts';
import { project, toParagraphs, itemRuns } from './model.ts';

const exec = promisify(execFile);
const MAX_BYTES = 50 * 1024 * 1024;

/** an open thread of the document, as it goes into the DOCX: a Word comment `content` (author and first message) */
export interface ExportedThread { n: number; messages: CommentMessage[]; content: string }

const MARK = (n: number, end: boolean) => `\uE000${end ? 'e' : 's'}${n}\uE001`;
const textOf = (it: Item) => itemRuns([it]).map(r => r.text).join('');

/** `mark` into a paragraph's items at `offset` of its text (a text item is split there) */
function insertMark(items: Item[], offset: number, mark: string): void {
  let pos = 0;
  for (let k = 0; k < items.length; k++) {
    const it = items[k];
    if (it.change?.type === 'deleted') continue;
    const len = textOf(it).length;
    if (offset < pos + len || offset === pos) {
      if (it.kind === 'text' && offset > pos) items.splice(k, 1, { ...it, text: it.text.slice(0, offset - pos) }, { ...it, text: mark }, { ...it, text: it.text.slice(offset - pos) });
      else items.splice(k, 0, { kind: 'text', text: mark, font: it.kind === 'text' ? it.font : {} } as Item);
      return;
    }
    pos += len;
  }
  items.push({ kind: 'text', text: mark, font: {} } as Item);
}

/**
 * The document with its open comment threads replaced by marks around the text each comments on —
 * the end of the sentence before it, at most 80 characters, as the sync quotes it — and those threads
 * in document order. (Threads are top-level, as the sync keeps them; resolved ones stay out.)
 */
export function markThreads(doc: LyxDocument): { doc: LyxDocument; threads: ExportedThread[] } {
  const body: Paragraph[] = structuredClone(doc.body);
  const threads: ExportedThread[] = [];
  for (const p of body) {
    let text = '';
    const items: Item[] = [];
    for (const it of p.items) {
      if (it.kind === 'inset' && it.inset.type === 'Text' && it.inset.name === 'Note' && it.inset.arg === 'Comment') {
        const t = parseThread(it.inset.paragraphs);
        const dot = text.lastIndexOf('. ', text.length - 2);
        let start = Math.max(dot >= 0 ? dot + 2 : 0, text.length - 80);
        while (start < text.length && /\s/.test(text[start])) start++;
        if (t.isStructured && t.messages.length && !t.resolved && text.slice(start).trim()) {
          const n = threads.length + 1;
          insertMark(items, start, MARK(n, false));
          items.push({ kind: 'text', text: MARK(n, true), font: {} } as Item);
          threads.push({ n, messages: t.messages, content: `${t.messages[0].author}: ${t.messages[0].text}` });
        } else items.push(it);
        continue;
      }
      items.push(it);
      if (it.change?.type !== 'deleted') text += textOf(it);
    }
    p.items = items;
  }
  return { doc: { ...doc, body }, threads };
}

/** inline Markdown text: every ASCII punctuation escaped, on one line */
const mdText = (s: string) => s.replace(/\s+/g, ' ').trim().replace(/[!-/:-@[-`{-~]/g, '\\$&');
const mdAttr = (s: string) => s.replace(/["\\\u0000-\u001f]/g, ' ').trim();

/** the marks of markThreads as Pandoc's Word comment spans (a thread whose marks did not come through intact is left out) */
function commentSpans(markdown: string, threads: ExportedThread[]): { text: string; any: boolean } {
  let text = markdown, any = false;
  for (const t of threads) {
    const s = MARK(t.n, false), e = MARK(t.n, true);
    const i = text.indexOf(s), j = text.indexOf(e);
    if (i < 0 || j < i || text.indexOf(s, i + 1) >= 0 || text.indexOf(e, j + 1) >= 0) continue;
    const when = new Date(t.messages[0].time.replace(' ', 'T'));
    const date = Number.isNaN(when.getTime()) ? '' : ` date="${when.toISOString().replace(/\.\d+Z$/, 'Z')}"`;
    text = text.replace(s, `[${mdText(t.content)}]{.comment-start id="${t.n}" author="${mdAttr(t.messages[0].author)}"${date}}`).replace(e, `[]{.comment-end id="${t.n}"}`);
    any = true;
  }
  return { text: text.replace(/\uE000[se]\d+\uE001/g, ''), any };
}

/** what Pandoc reads: the document's Markdown, its comment threads as Word comment spans (`any`: there are some) */
export function docxMarkdown(doc: LyxDocument, opts: { comments?: boolean } = {}): { text: string; any: boolean } {
  const marked = opts.comments ? markThreads(doc) : { doc, threads: [] };
  const projection = project(marked.doc, true);
  return commentSpans(writeMarkdown({ ...marked.doc, body: toParagraphs(projection.blocks, projection.headings, true) }).text, marked.threads);
}

export async function buildDocx(doc: LyxDocument, projectId: string, relPath: string, opts: { comments?: boolean } = {}): Promise<Buffer> {
  const marked = opts.comments ? markThreads(doc) : { doc, threads: [] };
  doc = marked.doc;
  const projection = project(doc, true);
  const copy = { ...doc, body: toParagraphs(projection.blocks, projection.headings, true) };
  const dir = await fs.mkdtemp(path.join(config.dataDir, 'cache', 'gdocs-docx-'));
  try {
    let image = 0, total = 0;
    const copyImages = async (paragraphs: Paragraph[]) => {
      for (const p of paragraphs) for (const item of p.items) {
        if (item.kind !== 'inset') continue;
        const ins = item.inset;
        if (ins.type === 'Leaf' && ins.name === 'Graphics') {
          const filename = unquote(paramMap(ins.params).get('filename'));
          if (/^[a-z]+:/i.test(filename) || path.isAbsolute(filename)) throw new Error('Google Docs export needs images stored inside the project: ' + filename);
          const src = resolveProjectPath(projectId, path.posix.join(path.posix.dirname(relPath), filename));
          const stat = await fs.stat(src);
          total += stat.size;
          if (!stat.isFile() || stat.size > MAX_BYTES || total > 2 * MAX_BYTES) throw new Error('The images are too large for Google Docs export.');
          const direct = /\.(png|jpe?g|gif)$/i.test(src);
          const local = direct ? src : await toPng(src, 1800);
          const name = 'image-' + image++ + (direct ? path.extname(src).toLowerCase() : '.png');
          await fs.copyFile(local, path.join(dir, name));
          ins.params = ins.params.map(p => /^\s*filename\s/.test(p) ? '\tfilename ' + name : p);
        } else if (ins.type === 'Text') await copyImages(ins.paragraphs);
        else if (ins.type === 'Tabular') for (const r of ins.rows) for (const c of r.cells) await copyImages(c.paragraphs);
      }
    };
    await copyImages(copy.body);
    const markdown = commentSpans(writeMarkdown(copy).text, marked.threads);
    await fs.writeFile(path.join(dir, 'document.md'), markdown.text);
    const binary = config.pandocBin;
    // (attributes + bracketed_spans: the comment spans — only then, as `{…}` after a link or code would read differently)
    const cmd = sandboxed(binary, ['document.md', `--from=commonmark+tex_math_dollars+footnotes+pipe_tables+strikeout${markdown.any ? '+attributes+bracketed_spans' : ''}`, '--to=docx', '--fail-if-warnings', '--resource-path=.', '--output=document.docx'], {
      rw: [dir], ro: path.isAbsolute(binary) ? [path.dirname(binary)] : [], cwd: dir,
      env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' }, home: false,
    });
    try {
      await exec(cmd.cmd, cmd.args, { cwd: dir, env: cmd.env, timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
    } catch (e) {
      const error = e as Error & { stderr?: string; code?: string };
      const detail = (error.stderr || error.message).slice(0, 1500);
      const missing = error.code === 'ENOENT' || /pandoc.*(?:No such file|not found)/i.test(detail);
      throw new Error('Could not create the Google Docs export. ' + (missing ? 'Install Pandoc on the server (or set OVERLYX_PANDOC_BIN). ' : '') + detail);
    }
    const stat = await fs.stat(path.join(dir, 'document.docx'));
    if (stat.size > MAX_BYTES) throw new Error('The DOCX export is too large for Google Docs (50 MB maximum).');
    return await fs.readFile(path.join(dir, 'document.docx'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

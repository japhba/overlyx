/**
 * Copying in a LaTeX or markdown document puts the selection's source on the clipboard as its
 * text (text/plain): LaTeX as the .tex file has it — `\section{…}`, `\emph{…}`, lists and
 * environments, `$…$`, `\cite{…}`, `\footnote{…}` — and markdown as the .md file has it — `# …`,
 * `*…*`, `- …`, `[^1]` with the footnote under it. The same writers that save the files write it
 * (clipsourcewriter.ts), against the document's own header (its class and modules), so a selection
 * pasted into a .tex / .md file, VS Code, Overleaf or a chat is the source of what was selected.
 * The HTML on the clipboard is unchanged: pasting inside OverLyX (and into Google Docs, Word …)
 * still keeps every inset and the formatting.
 *
 * What is copied is the text as it reads: tracked deletions are left out, insertions kept without
 * their marks, comment threads left out. The writers — and for LaTeX LyX's layout files, ~250 kB
 * once per browser — load in the background as soon as something is selected; until they are
 * there, and for what they do not write (cells selected in a table), the copy is cliptext.ts's
 * plain text as before.
 */
import { Plugin } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import type { Slice } from 'prosemirror-model';
import { pmToLyxBody, resolveChanges, isMarkdownPath, type LyxDocument, type Paragraph, type Item, type PMJSON } from '@overlyx/core';
import { ySyncPluginKey } from './collab';
import { viewDocId } from './context';
import { layoutHeader } from './layout/controller';
import { sliceText } from './cliptext';
import type { SourceKind, SourceWriter } from './clipsourcewriter';

/** what a document's source is: LaTeX for .tex files, markdown for .md (null: anything else — .lyx, HTML articles) */
export function sourceKind(docId: string): SourceKind | null {
  if (/\.tex$/i.test(docId)) return 'tex';
  if (isMarkdownPath(docId)) return 'md';
  return null;
}

const writers: Partial<Record<SourceKind, SourceWriter>> = {};
const loading = new Set<SourceKind>();

/** Load the writer for `kind` in the background (once; again a minute after a failure). */
export function prepareSourceCopy(kind: SourceKind | null): void {
  if (!kind || writers[kind] || loading.has(kind)) return;
  loading.add(kind);
  import('./clipsourcewriter')
    .then(m => m.loadSourceWriter(kind))
    .then(w => { writers[kind] = w; })
    .catch(e => { console.warn('copying as source is unavailable:', e); setTimeout(() => loading.delete(kind), 60_000); });
}

/** for the tests: a writer already loaded */
export function setSourceWriter(kind: SourceKind, w: SourceWriter | undefined): void { writers[kind] = w; }

function headerLines(view: EditorView): string[] {
  const raw = ySyncPluginKey.getState(view.state)?.doc?.getMap<string>('meta').get('header');
  if (raw) { try { return JSON.parse(raw); } catch { /* damaged: the shell's */ } }
  return layoutHeader() ?? [];
}

const isCommentThread = (it: Item) => it.kind === 'inset' && it.inset.type === 'Text' && it.inset.name === 'Note' && it.inset.arg === 'Comment';

/** the paragraphs without comment threads, in insets too */
function withoutComments(pars: Paragraph[]): Paragraph[] {
  return pars.map(p => ({
    ...p,
    items: p.items.filter(it => !isCommentThread(it)).map(it => {
      if (it.kind !== 'inset') return it;
      const ins = it.inset;
      if (ins.type === 'Text') return { ...it, inset: { ...ins, paragraphs: withoutComments(ins.paragraphs) } };
      if (ins.type === 'Tabular') return { ...it, inset: { ...ins, rows: ins.rows.map(r => ({ ...r, cells: r.cells.map(c => ({ ...c, paragraphs: withoutComments(c.paragraphs) })) })) } };
      return it;
    }),
  }));
}

/**
 * The selection `slice` as the source of the document `view` shows, or null where it has none or
 * its writer is not loaded yet.
 */
export function sliceSource(slice: Slice, docId: string, header: string[]): string | null {
  const kind = sourceKind(docId);
  const write = kind && writers[kind];
  if (!write || !slice.content.size) return null;
  try {
    let blocks = (slice.content.toJSON() ?? []) as PMJSON[];
    // a part of one paragraph: its text, written as a paragraph of the body (a heading's words copy as words)
    if (slice.content.firstChild!.isInline) blocks = [{ type: 'paragraph', attrs: { layout: 'Standard' }, content: blocks }];
    if (blocks.some(b => b.type !== 'paragraph')) return null;   // table cells (rows): their text, tab-separated
    const body = withoutComments(resolveChanges(pmToLyxBody({ type: 'doc', content: blocks }), true));
    if (!body.length) return null;
    const doc: LyxDocument = { preamble: [], format: 643, header: { lines: header }, body, trailer: [] };
    const text = write(doc).replace(/^\n+/, '').replace(/\s+$/, '');
    return text || null;
  } catch (e) {
    console.warn('the selection could not be written as source:', e);
    return null;
  }
}

/** the editors' `clipboardTextSerializer` (editor/assembly.ts): the source, else plain text */
export function clipboardText(slice: Slice, view: EditorView): string {
  return sliceSource(slice, viewDocId(view), headerLines(view)) ?? sliceText(slice);
}

/** loads the writer of the document's source when something is selected (ready by the time it is copied) */
export function sourceCopyPlugin(): Plugin {
  return new Plugin({
    view: () => ({
      update(view) {
        if (!view.state.selection.empty) prepareSourceCopy(sourceKind(viewDocId(view)));
      },
    }),
  });
}

/**
 * The writers behind copying a selection as its document's source (clipsource.ts), in a chunk of
 * their own: the .tex writer (core tex/write.ts, with LyX's layout files, e2e/lyxlib.ts) and the
 * markdown writer (core md/write.ts) — the same that save the files.
 */
import type { LyxDocument } from '@overlyx/core';
import { writeTex } from '@overlyx/core/tex/index.ts';
import { writeMarkdown } from '@overlyx/core/md/index.ts';
import { ensureLyxLib, LAYOUT_DIR } from '../e2e/lyxlib';

export type SourceKind = 'tex' | 'md';
export type SourceWriter = (doc: LyxDocument) => string;

export async function loadSourceWriter(kind: SourceKind): Promise<SourceWriter> {
  if (kind === 'md') return doc => writeMarkdown(doc).text;
  await ensureLyxLib();
  return doc => {
    // the body only: no settings line, no managed block (`fragment` writes a child document's body)
    const r = writeTex(doc, { layoutDir: LAYOUT_DIR, localDirs: [], fragment: true });
    return r.text.slice(r.bodyRange.start, r.bodyRange.end);
  };
}

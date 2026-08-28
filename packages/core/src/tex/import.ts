/**
 * One-time import of a .lyx file into a .tex document: the LyX settings become a real
 * preamble, child documents point to their .tex counterparts, graphics that pdflatex cannot
 * include (svg, eps, ...) are referenced as PDF (the caller converts them), notes / comments /
 * change tracking are kept in the file (see tex/write.ts).
 */
import type { LyxDocument } from '../lyx/ast.ts';
import { paramMap, walkInsets } from '../lyx/ast.ts';
import { parseLyx } from '../lyx/parser.ts';
import { writeTex, type WriteTexOptions } from './write.ts';

const PDFLATEX_FORMATS = new Set(['pdf', 'png', 'jpg', 'jpeg', 'mps']);

export interface ImportLyxOptions extends Omit<WriteTexOptions, 'fromLyx' | 'head'> {
  /** file name of the .lyx (for the import note) */
  sourceName?: string;
}

export interface ImportLyxResult {
  tex: string;
  warnings: string[];
  /** graphics to convert: src as referenced by the .lyx, dest as referenced by the .tex (relative to the document) */
  graphics: { src: string; dest: string }[];
  /** the .lyx file was a child document (no preamble of its own) */
  fragment: boolean;
}

/** Rewrite the document in place for the .tex world; returns the graphics conversions needed. */
export function prepareForTex(doc: LyxDocument): { src: string; dest: string }[] {
  const graphics: { src: string; dest: string }[] = [];
  for (const { inset } of walkInsets(doc.body)) {
    if (inset.type === 'Leaf' && inset.name === 'CommandInset' && inset.arg === 'include') {
      for (let i = 0; i < inset.params.length; i++) {
        const m = /^filename "(.*)\.lyx"$/i.exec(inset.params[i]);
        if (m) inset.params[i] = `filename "${m[1]}.tex"`;
      }
    }
    if (inset.type === 'Leaf' && inset.name === 'Graphics') {
      for (let i = 0; i < inset.params.length; i++) {
        const m = /^(\t?)filename (.*)$/.exec(inset.params[i]);
        if (!m) continue;
        const file = m[2].trim();
        const ext = file.includes('.') ? file.slice(file.lastIndexOf('.') + 1).toLowerCase() : '';
        if (!ext || PDFLATEX_FORMATS.has(ext)) continue;
        const dest = file.slice(0, file.lastIndexOf('.')) + '.pdf';
        if (!graphics.some(g => g.src === file)) graphics.push({ src: file, dest });
        inset.params[i] = `${m[1]}filename ${dest}`;
      }
    }
  }
  return graphics;
}

export function importLyx(lyxText: string, opts: ImportLyxOptions = {}): ImportLyxResult {
  const doc = parseLyx(lyxText);
  const graphics = prepareForTex(doc);
  const fragment = !!opts.fragment;
  const date = new Date().toISOString().slice(0, 10);
  const head = fragment ? [] : [`%% Imported from ${opts.sourceName ?? 'a LyX document'} by OverLyX on ${date}.`];
  // the LyX file's own comment lines ("#LyX 2.5 created this file") are not LaTeX
  doc.preamble = [];
  const r = writeTex(doc, { ...opts, fromLyx: !fragment, head });
  return { tex: r.text, warnings: r.warnings, graphics, fragment };
}

/** Convert a parsed LyX document (already in memory) to .tex text. */
export function lyxDocumentToTex(doc: LyxDocument, opts: ImportLyxOptions = {}): ImportLyxResult {
  const copy: LyxDocument = JSON.parse(JSON.stringify(doc));
  const graphics = prepareForTex(copy);
  copy.preamble = [];
  const fragment = !!opts.fragment;
  const r = writeTex(copy, { ...opts, fromLyx: !fragment });
  return { tex: r.text, warnings: r.warnings, graphics, fragment };
}

/**
 * External reloads (desktop LyX saves, version restores, a changed file at startup) are applied to
 * the live Y.Doc as a diff: untouched paragraphs keep their identity so that concurrent edits —
 * in particular those of a client that was offline — merge instead of vanishing.
 */
import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { yDocToProsemirrorJSON } from 'y-prosemirror';
import { parseLyx, writeLyx, pmToLyxBody, type PMJSON } from '@overlyx/core';
import { applyLyxDocument } from '../packages/server/src/ydiff.ts';

const HEADER = `#LyX 2.5 created this file. For more info see https://www.lyx.org/
\\lyxformat 643
\\begin_document
\\begin_header
\\save_transient_properties true
\\origin unavailable
\\textclass article
\\end_header

\\begin_body
`;
const TRAILER = `
\\end_body
\\end_document
`;
const par = (t: string) => `\n\\begin_layout Standard\n${t}\n\\end_layout\n`;
// normalised through the writer: LyX wraps lines after ". ! ? : ; ," followed by a space
const docText = (...ps: string[]) => writeLyx(parseLyx(HEADER + ps.map(par).join('') + TRAILER));

function toText(ydoc: Y.Doc): string {
  const m = ydoc.getMap<string>('meta');
  const g = (k: string) => JSON.parse(m.get(k)!);
  const json = yDocToProsemirrorJSON(ydoc, 'prosemirror') as PMJSON;
  return writeLyx({ preamble: g('preamble'), format: g('format'), header: { lines: g('header') }, body: pmToLyxBody(json), trailer: g('trailer') });
}

describe('diff-based document reload', () => {
  it('reproduces the loaded file exactly', () => {
    const ydoc = new Y.Doc();
    const a = docText('First paragraph.', 'Second paragraph.', 'Third paragraph.');
    applyLyxDocument(ydoc, parseLyx(a), 'file-load');
    expect(toText(ydoc)).toBe(a);
    const b = docText('First paragraph.', 'Second paragraph, changed.', 'Third paragraph.', 'Fourth paragraph.');
    applyLyxDocument(ydoc, parseLyx(b), 'file-load');
    expect(toText(ydoc)).toBe(b);
  });

  it('keeps untouched paragraphs so that concurrent (offline) edits survive an external save', () => {
    const server = new Y.Doc();
    const a = docText('First paragraph.', 'Second paragraph.', 'Third paragraph.');
    applyLyxDocument(server, parseLyx(a), 'file-load');

    // a client gets a copy and goes offline
    const client = new Y.Doc();
    Y.applyUpdate(client, Y.encodeStateAsUpdate(server));
    const firstPar = client.getXmlFragment('prosemirror').get(0) as Y.XmlElement;
    const text = firstPar.get(0) as Y.XmlText;
    text.insert(text.length, ' Offline addition.');

    // meanwhile the file is saved from desktop LyX with the third paragraph changed
    const b = docText('First paragraph.', 'Second paragraph.', 'Third paragraph, edited in LyX.');
    applyLyxDocument(server, parseLyx(b), 'file-load');
    expect(toText(server)).toBe(b);

    // the client comes back: its edit merges into the still-existing first paragraph
    Y.applyUpdate(server, Y.encodeStateAsUpdate(client, Y.encodeStateVector(server)));
    expect(toText(server)).toBe(docText('First paragraph. Offline addition.', 'Second paragraph.', 'Third paragraph, edited in LyX.'));
  });

  it('only rewrites the meta keys that changed', () => {
    const ydoc = new Y.Doc();
    applyLyxDocument(ydoc, parseLyx(docText('A')), 'file-load');
    let changes = 0;
    ydoc.getMap('meta').observe(() => changes++);
    applyLyxDocument(ydoc, parseLyx(docText('B')), 'file-load');
    expect(changes).toBe(0);
  });
});

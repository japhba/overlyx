/**
 * Positions between a document and its model-2 CRDT (packages/core/src/collab/positions.ts): every
 * document position goes to a relative position and back to itself, in paragraphs, insets, tables
 * and slides; and a relative position stays with its text when others edit before it.
 */
import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '@overlyx/core';
import { Reader, Writer, relativePosition, documentPosition } from '@overlyx/core/collab/index.ts';

const p = (...c: (PMNode | string)[]) => schema.nodes.paragraph.create(null, c.filter(x => x !== '').map(x => (typeof x === 'string' ? schema.text(x) : x)));
const note = (...pars: PMNode[]) => schema.nodes.inset.create({ name: 'Note', arg: 'Note' }, pars);
const math = (l: string) => schema.nodes.math_inline.create({ latex: l });
const cell = (...pars: PMNode[]) => schema.nodes.table_cell.create(null, pars);
const row = (...cells: PMNode[]) => schema.nodes.table_row.create(null, cells);
const table = (...rows: PMNode[]) => schema.nodes.table.create(null, rows);

function load(doc: PMNode): { ydoc: Y.Doc; doc: PMNode } {
  const ydoc = new Y.Doc();
  const reader = new Reader(schema, ydoc);
  ydoc.transact(() => new Writer(schema).writeDoc(ydoc, reader.read(), doc));
  const read = new Reader(schema, ydoc).read();
  expect(read.eq(doc)).toBe(true);
  return { ydoc, doc: read };
}

/** the positions that are inside a text block (where a cursor can be) */
function textPositions(doc: PMNode): number[] {
  const out: number[] = [];
  for (let pos = 0; pos <= doc.content.size; pos++) if (doc.resolve(pos).parent.inlineContent) out.push(pos);
  return out;
}

describe('collab positions', () => {
  it('every cursor position goes to a relative position and back', () => {
    const doc = schema.node('doc', null, [
      p('Hello ', math('x^2'), ' world'),
      p('before ', note(p('inside one'), p('inside ', math('y'), ' two')), ' after'),
      p(),
      p('a table ', table(row(cell(p('c11')), cell(p('c12'), p('second'))), row(cell(p('c21')), cell(p()))), ' done'),
      p('last'),
    ]);
    const { ydoc, doc: read } = load(doc);
    for (const pos of textPositions(read)) {
      for (const assoc of [0, -1]) {
        const rel = relativePosition(schema, ydoc, read, pos, assoc);
        expect(rel, `position ${pos}`).not.toBeNull();
        expect(documentPosition(schema, ydoc, read, rel!), `position ${pos} (assoc ${assoc})`).toBe(pos);
      }
    }
  });

  it('a relative position stays with its text when others edit before it', () => {
    const doc = schema.node('doc', null, [p('one two three'), p('four ', note(p('five six')), ' seven')]);
    const { ydoc, doc: read } = load(doc);
    const at = read.child(0).nodeSize + 1 + 'four '.length + 1 + 1 + 'five '.length;   // before "six" in the note
    expect(read.textBetween(at, at + 3)).toBe('six');
    const rel = relativePosition(schema, ydoc, read, at, 0)!;
    // somebody inserts text at the start and splits the first paragraph
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(ydoc));
    const r2 = new Reader(schema, other);
    const before = r2.read();
    const next = schema.node('doc', null, [p('zero '), p('one two'), p(' three'), before.child(1)]);
    other.transact(() => new Writer(schema).writeDoc(other, before, next));
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(other));
    const now = new Reader(schema, ydoc).read();
    const pos = documentPosition(schema, ydoc, now, rel)!;
    expect(now.textBetween(pos, pos + 3)).toBe('six');
  });

  it('positions in a slide\'s text boxes and notes', () => {
    const box = (x: number, ...pars: PMNode[]) => schema.nodes.ol_box.create({ x }, pars);
    const page = (...c: PMNode[]) => schema.nodes.ol_page.create(null, c);
    const doc = schema.node('doc', null, [
      page(box(1, p('Title')), box(2, p('body one'), p('body two')), schema.nodes.ol_notes.create(null, [p('notes')])),
      page(schema.nodes.ol_group.create(null, [box(3, p('grouped')), box(4, p('also'))])),
    ]);
    const { ydoc, doc: read } = load(doc);
    for (const pos of textPositions(read)) {
      const rel = relativePosition(schema, ydoc, read, pos, 0);
      expect(rel, `position ${pos}`).not.toBeNull();
      expect(documentPosition(schema, ydoc, read, rel!), `position ${pos}`).toBe(pos);
    }
  });
});

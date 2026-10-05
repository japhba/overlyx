// @vitest-environment happy-dom
/**
 * The clipboard's HTML (editor/cliphtml.ts): a paragraph holding a block — a comment's or a note's
 * paragraphs, a table — is a <div class="lyx-par">, so that an HTML parser cannot close it at the
 * inner block and push the inset's paragraphs out (e2e/clipboard.spec.ts pastes it in Chromium);
 * the schema reads it back as the same paragraph.
 */
import { describe, it, expect } from 'vitest';
import { DOMParser as PMDOMParser } from 'prosemirror-model';
import { schema } from '../packages/core/src/schema.ts';
import { clipboardSerializer } from '../packages/client/src/editor/cliphtml.ts';

const plain = (text: string) => schema.nodes.paragraph.create({ layout: 'Plain Layout' }, schema.text(text));
const note = (arg: string, ...pars: string[]) => schema.nodes.inset.create({ name: 'Note', arg, params: '[]', status: 'open' }, pars.map(plain));

describe('clipboard HTML', () => {
  const doc = schema.nodes.doc.create(null, [
    schema.nodes.paragraph.create({ layout: 'Section' }, schema.text('Alpha')),
    schema.nodes.paragraph.create({ layout: 'Standard' }, [schema.text('With a comment '), note('Comment', 'Ann (2026-10-05 10:00):', 'Text.'), schema.text(' and more.')]),
    schema.nodes.paragraph.create({ layout: 'Standard' }, schema.text('Plain.')),
  ]);
  const wrap = document.createElement('div');
  wrap.appendChild(clipboardSerializer().serializeFragment(doc.content, { document }));

  it('writes a paragraph with an inset of paragraphs as a div; the others stay <p>', () => {
    expect(Array.from(wrap.children).map(e => e.tagName)).toEqual(['P', 'DIV', 'P']);
    expect(wrap.children[1].className).toContain('lyx-par');
    expect(wrap.children[1].getAttribute('data-layout')).toBe('Standard');
    expect(wrap.querySelectorAll('.lyx-inset > p')).toHaveLength(2);
  });

  it('reads it back as the same document', () => {
    const back = PMDOMParser.fromSchema(schema).parse(wrap);
    expect(back.eq(doc)).toBe(true);
  });
});

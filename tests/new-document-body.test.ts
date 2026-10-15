import { expect, it } from 'vitest';
import { newDocumentText } from '../packages/core/src/newdoc.ts';
import { parseTex, writeTex, writeTexPreserving } from '../packages/core/src/tex/index.ts';

it('a new titled document exposes an empty body without changing the title or author when writing starts', () => {
  const source = newDocumentText({ title: 'Community notes', author: 'Taylor' });
  const parsed = parseTex(source);
  expect(parsed.doc.body.map(p => p.layout)).toEqual(['Title', 'Author', 'Standard']);
  expect(parsed.sources.at(-1)).toBeNull();
  expect(writeTexPreserving(parsed.doc, { base: source, parse: parseTex, write: writeTex }).text).toBe(source);
  parsed.doc.body.at(-1)!.items.push({ kind: 'text', text: 'A first research note.', font: {} });
  const saved = writeTexPreserving(parsed.doc, { base: source, parse: parseTex, write: writeTex }).text;
  expect(saved).toContain('\\title{Community notes}');
  expect(saved).toContain('\\author{Taylor}');
  expect(saved).toMatch(/\\maketitle\s+A first research note\./);
  expect(parseTex(saved).doc.body.at(-1)?.layout).toBe('Standard');
});

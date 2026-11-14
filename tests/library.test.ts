import { describe, it, expect, vi } from 'vitest';
import zlib from 'node:zlib';
import { rmSync } from 'node:fs';

// server code reads config.ts at import: a data directory of the test's own, never the real one
const ROOT = vi.hoisted(() => {
  const r = require('node:path').join(process.env.TMPDIR || require('node:os').tmpdir(), 'overlyx-library-test');
  process.env.OVERLYX_DATA_DIR = require('node:path').join(r, 'data');
  process.env.OVERLYX_PROJECTS_DIR = require('node:path').join(r, 'projects');
  process.env.OVERLYX_LITERATURE = 'off';
  return r;
});
rmSync(ROOT, { recursive: true, force: true });
const { addBibtex, editRef, bibtexForProject, setBibField, splitEntries, personName, pdfIdentifiers, attachPdf, deleteRef, forgetLibrary, getRef } = await import('../packages/server/src/library.ts');

const VASWANI = `@inproceedings{whatever,
  title = {Attention Is All You Need},
  author = {Vaswani, Ashish and Shazeer, Noam and Parmar, Niki},
  booktitle = {Advances in Neural Information Processing Systems},
  year = {2017},
  abstract = {The dominant sequence transduction models ...},
  doi = {10.5555/3295222.3295349}
}`;

describe('My library', () => {
  it('adds entries under Scholar-style keys, unique per account, and does not add a paper twice', () => {
    const a = addBibtex(1, VASWANI);
    expect(a.added).toHaveLength(1);
    expect(a.added[0].key).toBe('vaswani2017attention');
    expect(a.added[0].authors).toEqual(['Ashish Vaswani', 'Noam Shazeer', 'Niki Parmar']);
    // the same paper again (same DOI, another key): the existing entry
    const again = addBibtex(1, VASWANI.replace('whatever', 'other'));
    expect(again.added).toHaveLength(0);
    expect(again.duplicates[0].id).toBe(a.added[0].id);
    // another paper with the same key stem gets a letter
    const b = addBibtex(1, '@article{x, title = {Attention for the rest of us}, author = {Vaswani, Ada}, year = {2017}}');
    expect(b.added[0].key).toBe('vaswani2017attentiona');
    // another account's library is its own
    expect(addBibtex(2, VASWANI).added[0].key).toBe('vaswani2017attention');
  });

  it('imports a whole .bib file, skipping @string and @comment', () => {
    const text = '@string{nips = {NeurIPS}}\n@comment{x}\n@article{a, title={One}, author={A, B}, year={2001}}\n@book{b, title={Two}, author={C, D}, year={2002}}';
    expect(splitEntries(text)).toHaveLength(2);
    const r = addBibtex(3, text);
    expect(r.added.map(x => x.title)).toEqual(['One', 'Two']);
  });

  it('edits fields into the BibTeX, keeps tags and the note out of what a project gets', () => {
    const [ref] = addBibtex(4, VASWANI).added;
    const e = editRef(4, ref.id, { title: 'Attention Is All You Need & More', tags: ['transformers', 'nlp'], note: 'read twice', year: '2018' });
    expect(e.title).toBe('Attention Is All You Need & More');
    expect(e.year).toBe(2018);
    expect(e.bibtex).toContain('title = {Attention Is All You Need \\& More}');
    expect(e.tags).toEqual(['transformers', 'nlp']);
    const out = bibtexForProject(4, ref.id)!;
    expect(out.key).toBe(ref.key);
    expect(out.bibtex).not.toMatch(/abstract|read twice|transformers/);
    // another account cannot take it
    expect(bibtexForProject(5, ref.id)).toBeNull();
    expect(() => editRef(5, ref.id, { title: 'x' })).toThrow(/No such reference/);
    expect(() => editRef(4, ref.id, { key: 'has space' })).toThrow();
  });

  it('sets, adds and removes fields', () => {
    const bib = '@article{k,\n  title = {T},\n  year = 2001,\n  journal = "J {X}"\n}';
    expect(setBibField(bib, 'year', '2002')).toContain('year = {2002}');
    expect(setBibField(bib, 'journal', '')).not.toContain('journal');
    expect(setBibField(bib, 'doi', '10.1/x')).toMatch(/journal = "J \{X\}",\n {2}doi = \{10\.1\/x\}\n\}$/);
  });

  it('reads names as people write them', () => {
    expect(personName('G{\\"o}del, Kurt')).toBe('Kurt Gödel');
    expect(personName('Ashish Vaswani')).toBe('Ashish Vaswani');
  });

  it('finds the DOI or arXiv id a PDF names about itself', () => {
    const page = zlib.deflateSync(Buffer.from('BT /F1 9 Tf (arXiv:1706.03762v7  [cs.CL]  6 Dec 2017) Tj ET BT [(See 10.1000/)-20(xyz)] TJ ET'));
    const pdf = Buffer.concat([Buffer.from('%PDF-1.5\n1 0 obj << /Length 99 /Filter /FlateDecode >>\nstream\n'), page, Buffer.from('\nendstream\nendobj\n')]);
    expect(pdfIdentifiers(pdf).arxiv).toBe('1706.03762');
    const xmp = Buffer.from('%PDF-1.7\n<x:xmpmeta><prism:doi>10.1038/nature14539</prism:doi></x:xmpmeta>');
    expect(pdfIdentifiers(xmp).doi).toBe('10.1038/nature14539');
  });

  it('keeps PDFs per account and lets them go with the entry and the account', () => {
    const [ref] = addBibtex(6, VASWANI).added;
    expect(() => attachPdf(6, ref.id, Buffer.from('not a pdf'))).toThrow(/not a PDF/);
    expect(attachPdf(6, ref.id, Buffer.from('%PDF-1.4 hello')).pdf).toBe(true);
    expect(() => attachPdf(7, ref.id, Buffer.from('%PDF-1.4'))).toThrow(/No such reference/);
    deleteRef(6, ref.id);
    expect(getRef(6, ref.id)).toBeUndefined();
    addBibtex(6, VASWANI);
    forgetLibrary(6);
    expect(addBibtex(6, VASWANI).added).toHaveLength(1);
  });
});

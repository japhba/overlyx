import { describe, it, expect } from 'vitest';
import { bibRefs, bibtexNice } from '../packages/client/src/app/bibrefs';

describe('bibRefs (references in an agent reply)', () => {
  it('finds BibTeX entries with balanced braces and their keys', () => {
    const r = bibRefs('Here:\n```bibtex\n@article{smith2020,\n title={Deep {L}earning},\n year={2020}\n}\n```\nand @misc{k2, note={x{y}z}} done');
    expect(r.map(x => x.label)).toEqual(['smith2020', 'k2']);
    expect(r[0].bibtex).toContain('title={Deep {L}earning}');
  });
  it('finds bare DOIs and arXiv ids, skipping ones inside BibTeX', () => {
    const r = bibRefs('See 10.1016/j.jss.2020.110 and arXiv:1706.03762v5, plus @misc{a, doi={10.1234/inside}}');
    expect(r.map(x => x.label)).toEqual(['a', 'doi:10.1016/j.jss.2020.110', 'arXiv:1706.03762']);
    expect(r[2].doi).toBe('10.48550/arXiv.1706.03762');
  });
  it('labels: an author–year `nice` from BibTeX fields, the reference kind for the chip', () => {
    const r = bibRefs('@article{smith2020, author={Smith, John and Doe, Jane}, year={2020}, title={X}}');
    expect(r[0].nice).toBe('Smith et al. 2020');
    expect(r[0].kind).toBe('bibtex');
    expect(bibtexNice('@article{d21, author={Jane van Doe}, year={2021}}')).toBe('Doe 2021');
    expect(bibRefs('@misc{k, note={no author}}')[0].nice).toBeUndefined();
    expect(bibRefs('see 10.1234/x')[0].kind).toBe('doi');
    expect(bibRefs('see arXiv:1706.03762')[0].kind).toBe('arxiv');
  });
  it('dedupes and returns nothing for plain prose', () => {
    expect(bibRefs('DOI 10.1234/x and again 10.1234/x').length).toBe(1);
    expect(bibRefs('no references here')).toEqual([]);
  });
});

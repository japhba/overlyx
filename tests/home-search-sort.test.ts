/** The start page's project search (app/homesearch.ts) and the files' Recent · Name order (app/filesort.ts). */
import { describe, it, expect } from 'vitest';
import { matchProject, searchTerms, markTerms } from '../packages/client/src/app/homesearch';
import { sortFiles } from '../packages/client/src/app/filesort';
import type { Project, ProjectFile } from '../packages/client/src/api';

const file = (path: string, kind: ProjectFile['kind'] = 'other', mtime = 0): ProjectFile => ({ path, name: path.split('/').pop()!, size: 1, mtime, kind });
const paper = {
  name: 'ada/paper', title: 'Thesis draft', owner: { id: 1, name: 'Ada Example', username: 'ada' },
  files: [file('main.tex', 'doc', 100), file('main.aux', 'other', 900), file('sections/methods.tex', 'doc', 300), file('refs.bib', 'bib', 50), file('talk/index.html', 'html', 200), file('figures', 'dir')],
} as unknown as Project;

describe('project search', () => {
  it('finds a project by its name or owner, every word anywhere', () => {
    expect(matchProject(paper, searchTerms('thesis'))).toEqual({ files: [] });
    expect(matchProject(paper, searchTerms('ADA draft'))).toEqual({ files: [] });
    expect(matchProject(paper, searchTerms('thesis nothing'))).toBeNull();
  });
  it('a word found only in file names lists those files, documents first', () => {
    expect(matchProject(paper, searchTerms('methods'))?.files).toEqual(['sections/methods.tex']);
    expect(matchProject(paper, searchTerms('thesis tex'))?.files).toEqual(['main.tex', 'sections/methods.tex']);
    // build products are no match
    expect(matchProject(paper, searchTerms('aux'))).toBeNull();
  });
  it('marks the words in a text', () => {
    expect(markTerms('Thesis draft', ['the', 'dra'])).toEqual(['', 'The', 'sis ', 'dra', 'ft']);
    expect(markTerms('abc', [])).toEqual(['abc']);
  });
});

describe('files by recency', () => {
  const docs = ['main.tex', 'sections/methods.tex', 'talk/index.html'];
  it('Name keeps the order, Recent puts the newest first', () => {
    expect(sortFiles(paper, docs, 'name')).toEqual(docs);
    expect(sortFiles(paper, docs, 'recent')).toEqual(['sections/methods.tex', 'talk/index.html', 'main.tex']);
  });
  it('opening a file counts as much as changing it', () => {
    const p = { ...paper, opened: { 'main.tex': 1000 } } as Project;
    expect(sortFiles(p, docs, 'recent')[0]).toBe('main.tex');
    const q = { ...paper, lastFile: 'text:ada/paper/talk/index.html', lastOpened: 2000 } as Project;
    expect(sortFiles(q, docs, 'recent')[0]).toBe('talk/index.html');
  });
});

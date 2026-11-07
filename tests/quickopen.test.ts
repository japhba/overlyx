/** Go to File's matching and ranking (packages/client/src/app/quickopen.ts). */
import { describe, it, expect } from 'vitest';
import { fuzzyMatch, quickFiles, rankFiles } from '../packages/client/src/app/quickopen';
import type { Project, ProjectFile } from '../packages/client/src/api';

const file = (path: string, kind: ProjectFile['kind'] = 'other', extra: Partial<ProjectFile> = {}): ProjectFile =>
  ({ path, name: path.split('/').pop()!, size: 1, mtime: 0, kind, ...extra });
const project = { name: 'ada/paper', files: [
  file('main.tex', 'doc'), file('main.aux'), file('main.tex~', 'tex'), file('figures', 'dir'), file('figures/plot.pdf', 'pdf'),
  file('figures/model.png', 'image'), file('sections/methods.tex', 'doc'), file('macros.tex', 'tex'), file('refs.bib', 'bib'),
  file('talk/index.html', 'html', { deliverable: 'deck' }), file('notes.md', 'doc'),
] } as unknown as Project;
const files = quickFiles([project]);

describe('Go to File', () => {
  it('offers files, not folders, build products or backups', () => {
    expect(files.map(f => f.path)).not.toContain('figures');
    expect(files.map(f => f.path)).not.toContain('main.aux');
    expect(files.map(f => f.path)).not.toContain('main.tex~');
    expect(files.find(f => f.path === 'main.tex')!.id).toBe('ada/paper/main.tex');
    expect(files.find(f => f.path === 'macros.tex')!.id).toBe('text:ada/paper/macros.tex');
  });

  it('matches letters in order, preferring word starts and the file name', () => {
    expect(fuzzyMatch('xyz', 'main.tex')).toBeNull();
    expect(fuzzyMatch('mt', 'main.tex')!.positions).toEqual([0, 5]);
    expect(rankFiles(files, 'mtex')[0].path).toBe('main.tex');
    expect(rankFiles(files, 'figplot')[0].path).toBe('figures/plot.pdf');
    expect(rankFiles(files, 'meth')[0].path).toBe('sections/methods.tex');
    expect(rankFiles(files, 'bib')[0].path).toBe('refs.bib');
    expect(rankFiles(files, 'talk')[0].path).toBe('talk/index.html');
  });

  it('lists the recently shown files first, then the documents', () => {
    const none = rankFiles(files, '', ['text:ada/paper/macros.tex', 'ada/paper/notes.md']);
    expect(none.slice(0, 2).map(f => f.path)).toEqual(['macros.tex', 'notes.md']);
    expect(none.slice(2, 5).map(f => f.path)).toEqual(['main.tex', 'sections/methods.tex', 'talk/index.html']);
    // a recent file wins a tie
    expect(rankFiles(files, 'ma', ['text:ada/paper/macros.tex'])[0].path).toBe('macros.tex');
  });
});

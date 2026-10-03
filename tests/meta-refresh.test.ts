// @vitest-environment happy-dom
/**
 * What the editor draws from the document metadata follows `editorContext.meta` when it is replaced
 * (pre-beta findings): an author who just turned change tracking on is named in the change
 * descriptions, and a citation an agent inserted while the document was open shows author and year
 * once the refreshed metadata knows the key — no reload.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { schema } from '../packages/core/src/schema.ts';
import { editorContext, onMetaChange } from '../packages/client/src/editor/context.ts';
import { CommandView } from '../packages/client/src/editor/nodeviews/leaf.ts';
import { describeChange } from '../packages/client/src/editor/assembly.ts';
import type { DocMeta } from '../packages/client/src/api.ts';

const meta = (over: Partial<DocMeta>): DocMeta => ({ id: 'p/d.tex', project: 'p', path: 'd.tex', textclass: 'article', modules: [], language: 'english', useRefstyle: false, citeEngine: 'natbib', citeEngineType: 'authoryear', trackingChanges: false, secnumdepth: 3, tocdepth: 3, authors: [], macros: {}, macroList: [], bib: [], layouts: null, flexInsets: null, files: [], master: null, labels: [], health: [], ...over });

afterEach(() => { editorContext.meta = null; });

describe('editorContext.meta', () => {
  it('tells its listeners when it is replaced (not when the same object is assigned again)', () => {
    let n = 0;
    const off = onMetaChange(() => n++);
    const m = meta({});
    editorContext.meta = m;
    editorContext.meta = m;
    editorContext.meta = meta({});
    off();
    editorContext.meta = meta({});
    expect(n).toBe(2);
  });

  it('a new author is named in change descriptions as soon as the metadata has them', () => {
    editorContext.meta = meta({ authors: [] });
    expect(describeChange('deleted', -1812294520, 0)).toBe('Deleted by author -1812294520');
    editorContext.meta = meta({ authors: [{ id: -1812294520, name: 'Bob' }] });
    expect(describeChange('deleted', -1812294520, 0)).toBe('Deleted by Bob');
  });

  it('a citation drawn before its key was known shows author and year once the metadata is refreshed', () => {
    editorContext.meta = meta({ bib: [] });
    const node = schema.nodes.command.create({ cmd: 'citation', params: JSON.stringify(['LatexCommand citep', 'key "newmcpkey2023"', '']) });
    const view = { dom: document.createElement('div') } as never;
    const cite = new CommandView(node, view, () => 0);
    expect(cite.dom.textContent).toBe('(newmcpkey2023)');
    editorContext.meta = meta({ bib: [{ key: 'newmcpkey2023', author: 'New', year: '2023', title: 'T' }] as never });
    expect(cite.dom.textContent).toBe('(New 2023)');
    cite.destroy();
  });
});

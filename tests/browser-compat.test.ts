// @vitest-environment happy-dom
/**
 * Things that worked in Chromium only — findings of the e2e suite run in WebKit (Safari's engine) and
 * Firefox, and of probes of what a Safari / iPad user does (scratch/browsers/). One block per fix.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { schema } from '../packages/core/src/schema.ts';
import { editorContext } from '../packages/client/src/editor/context.ts';
import { CommandView } from '../packages/client/src/editor/nodeviews/leaf.ts';

afterEach(() => { editorContext.openInTab = undefined; editorContext.openInsetDialog = undefined; });

/**
 * The PDF viewer loads pdf.js's legacy build: the default one needs Map.getOrInsertComputed,
 * Math.sumPrecise and the Iterator global (Safari 26.2, Firefox 144, Chrome 147) and stopped the whole
 * app from starting in older Safari (`Iterator` is evaluated when pdf.js is imported).
 */
describe('pdf.js', () => {
  it('the web client and the VS Code PDF panel load the legacy build (and its worker), never the default one', () => {
    for (const f of ['packages/client/src/app/PdfViewer.tsx', 'packages/vscode/src/webview/pdfMain.tsx']) {
      const src = readFileSync(f, 'utf8');
      const imports = [...src.matchAll(/from '(pdfjs-dist[^']*)'|'(pdfjs-dist\/[^']*worker[^']*)'/g)].map(m => m[1] ?? m[2]);
      expect(imports.length, f).toBeGreaterThan(0);
      for (const i of imports) expect(i, f).toMatch(/^pdfjs-dist\/legacy\/build\//);
    }
  });
});

/**
 * A child document opens on the browser's own double-click: ProseMirror's handleDoubleClickOn counts the
 * clicks itself (500 ms apart at most), which a busy WebKit page missed, and WebKit sent the dblclick to
 * the paragraph when the link was drawn anew between the two clicks.
 */
describe('a child document (\\input / \\include inset)', () => {
  const include = (filename: string) => schema.nodes.command.create({ cmd: 'include', params: JSON.stringify(['LatexCommand input', `filename "${filename}"`, '']) });
  const viewIn = (project: string, docDir: string) => { const dom = document.createElement('div'); dom.dataset.project = project; dom.dataset.docDir = docDir; return { dom } as never; };

  it('opens on the dblclick event itself, relative to the document\'s folder; no inset dialog', () => {
    const opened: string[] = [];
    let dialogs = 0;
    editorContext.openInTab = (id: string) => { opened.push(id); };
    editorContext.openInsetDialog = () => { dialogs++; };
    const v = new CommandView(include('../shared/macros.tex'), viewIn('jan/paper', 'chapters'), () => 0);
    expect(v.dom.querySelector('a.lyx-include-link')?.getAttribute('href')).toBe('#/jan/paper/shared/macros.tex');
    const ev = new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 });
    v.dom.querySelector('a')!.dispatchEvent(ev);
    expect(opened).toEqual(['jan/paper/shared/macros.tex']);
    expect(dialogs).toBe(0);
    expect(ev.defaultPrevented).toBe(true);
    v.destroy?.();
  });

  it('keeps its link element when ProseMirror updates it unchanged (the second click of a double-click hits the same element)', () => {
    const v = new CommandView(include('a.tex'), viewIn('jan/paper', ''), () => 0);
    const link = v.dom.querySelector('a');
    expect(v.update(include('a.tex'))).toBe(true);
    expect(v.dom.querySelector('a')).toBe(link);
    expect(v.update(include('b.tex'))).toBe(true);   // another file: drawn anew
    expect(v.dom.querySelector('a')?.getAttribute('href')).toBe('#/jan/paper/b.tex');
    v.destroy?.();
  });

  it('other command insets still open their dialog on a double-click', () => {
    let dialogs = 0;
    editorContext.openInTab = () => { throw new Error('not a child document'); };
    editorContext.openInsetDialog = () => { dialogs++; };
    const label = schema.nodes.command.create({ cmd: 'label', params: JSON.stringify(['LatexCommand label', 'name "sec:intro"', '']) });
    const v = new CommandView(label, viewIn('jan/paper', ''), () => 0);
    v.dom.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }));
    expect(dialogs).toBe(1);
    v.destroy?.();
  });
});

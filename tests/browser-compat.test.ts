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
import { keepScrollOnFocus } from '../packages/client/src/editor/assembly.ts';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { idleCallback } from '../packages/client/src/editor/nodeviews/math.ts';
import { stashPendingImport, takePendingImport, pendingImportFlag } from '../packages/client/src/app/pendingImport.ts';

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

/**
 * Without requestIdleCallback (Safari) the idle-time rendering of formulas gets a deadline that runs
 * out: a constant one rendered every formula of a long paper in one task and froze the page.
 */
describe('idle time without requestIdleCallback (Safari)', () => {
  it('the deadline runs out: an idle task that renders while timeRemaining() lasts stops after ~8 ms', async () => {
    const spent = await new Promise<{ first: number; steps: number; ms: number }>(res => idleCallback(d => {
      const t0 = performance.now(), first = d.timeRemaining();
      let steps = 0;
      while (d.timeRemaining() > 0 && steps < 1e7) { steps++; for (let i = 0; i < 1000; i++) Math.sqrt(i); }
      res({ first, steps, ms: performance.now() - t0 });
    }, {}));
    expect(spent.first).toBeGreaterThan(0);
    expect(spent.first).toBeLessThanOrEqual(8);
    expect(spent.steps).toBeLessThan(1e7);   // it ended because the time was up
    expect(spent.ms).toBeLessThan(50);
  });
  it('requestIdleCallback is used where the browser has it', () => {
    const calls: unknown[] = [];
    idleCallback(() => {}, { requestIdleCallback: (cb: unknown, o: unknown) => { calls.push(o); } });
    expect(calls).toEqual([{ timeout: 500 }]);
  });
});

/**
 * An Overleaf zip chosen before the sign-in is parked in IndexedDB as bytes: Safari cannot store a Blob
 * there in a private window, and the import was lost.
 *
 * An IndexedDB with one object store per database, values kept by structured clone — and, as Safari's in a
 * private window, refusing a value that holds a Blob ("Error preparing Blob/File data to be stored in object store").
 */
function privateSafariIndexedDB() {
  const dbs = new Map<string, Map<string, Map<IDBValidKey, unknown>>>();
  const hasBlob = (v: unknown): boolean => v instanceof Blob || (Array.isArray(v) ? v.some(hasBlob) : !!v && typeof v === 'object' && !(v instanceof ArrayBuffer) && Object.values(v).some(hasBlob));
  const later = (f: () => void) => setTimeout(f, 0);
  return {
    open(name: string) {
      const req: any = {};
      later(() => {
        const fresh = !dbs.has(name);
        const stores = dbs.get(name) ?? new Map<string, Map<IDBValidKey, unknown>>();
        dbs.set(name, stores);
        const db: any = {
          objectStoreNames: { contains: (n: string) => stores.has(n) },
          createObjectStore: (n: string) => { stores.set(n, new Map()); },
          close() {},
          transaction(store: string) {
            const t: any = {};
            const data = stores.get(store)!;
            const op = (f: () => unknown) => { const r: any = {}; later(() => { try { r.result = f(); r.onsuccess?.(); later(() => t.oncomplete?.()); } catch (e) { r.error = e; t.error = e; r.onerror?.(); later(() => t.onerror?.()); } }); return r; };
            t.objectStore = () => ({
              put: (v: unknown, k: IDBValidKey) => op(() => { if (hasBlob(v)) throw new DOMException('Error preparing Blob/File data to be stored in object store', 'UnknownError'); data.set(k, structuredClone(v)); return k; }),
              get: (k: IDBValidKey) => op(() => structuredClone(data.get(k))),
              delete: (k: IDBValidKey) => op(() => { data.delete(k); }),
            });
            return t;
          },
        };
        req.result = db;
        if (fresh) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
}

describe('an Overleaf import chosen before the sign-in', () => {
  it('survives the sign-in where IndexedDB takes no Blobs (Safari, private window): the zips come back as Files', async () => {
    const saved = (globalThis as any).indexedDB;
    (globalThis as any).indexedDB = privateSafariIndexedDB();
    try {
      const zip = new File([new Uint8Array([80, 75, 3, 4, 1, 2, 3])], 'thesis.zip', { type: 'application/zip', lastModified: 1700000000000 });
      await stashPendingImport({ links: '', token: '', zips: [zip] });
      expect(pendingImportFlag()).toBe(true);
      const back = await takePendingImport();
      expect(back?.zips.map(f => [f.name, f.type, f.size, f instanceof File])).toEqual([['thesis.zip', 'application/zip', 7, true]]);
      expect([...new Uint8Array(await back!.zips[0].arrayBuffer())]).toEqual([80, 75, 3, 4, 1, 2, 3]);
      expect(pendingImportFlag()).toBe(false);
      expect(await takePendingImport()).toBeNull();   // taken: nothing waits any more
    } finally { (globalThis as any).indexedDB = saved; }
  });
});

/**
 * The editor getting the focus back keeps the page where it is: WebKit reveals the editor's previous
 * DOM selection on focus whatever preventScroll says (a click on a child document's link took the
 * focus, ProseMirror took it back, and Safari scrolled to where the caret had been).
 */
describe('focusing the editor', () => {
  it('leaves the scroll positions of its scrolling ancestors as they were', () => {
    const scroller = document.createElement('div');
    const place = document.createElement('div');
    scroller.appendChild(place); document.body.appendChild(scroller);
    const view = new EditorView(place, { state: EditorState.create({ schema }) });
    keepScrollOnFocus(view);
    scroller.scrollTop = 591;
    // what WebKit does on focus: the old caret, far down the page, is revealed
    const focusDom = view.dom.focus.bind(view.dom);
    view.dom.focus = (o?: FocusOptions) => { focusDom(o); scroller.scrollTop = 1847; };
    view.focus();
    expect(scroller.scrollTop).toBe(591);
    view.destroy(); scroller.remove();
  });
});

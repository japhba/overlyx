/**
 * The deliverable webview (HTML slide decks, posters, web pages — host/deliverables.ts): the web
 * app's deliverable editor (client deliverable/DeliverableEditor.tsx) on a host that keeps the text
 * in the file's TextDocument. Changes go to the extension as splices of the version this webview
 * knows; the TextDocument's changes (its own and anybody's) come back as the whole text. Undo is
 * VS Code's (the document's), presenting and printing happen in the browser.
 */
import { G, vscode, applyTheme } from './globals';   // must come first: sets OVERLYX_API_BASE
import { render } from 'preact';
import { useHostTheme } from '@client/app/theme';
import { DeliverableCanvas } from '@client/deliverable/DeliverableEditor';
import type { DeliverableHost, ChangeOrigin, Splice } from '@client/deliverable/host';
import type { HostToDeliverable } from '../host/deliverables';
import '@client/styles.css';

useHostTheme();
applyTheme(G.dark);

type Listener<T> = (v: T) => void;

function vscodeHost(init: Extract<HostToDeliverable, { type: 'dlInit' }>): DeliverableHost {
  /** the text as shown here (changes not yet in the document included) */
  let text = init.text;
  /** the document's version the next change is made on */
  let version = init.version;
  /** a change sent and not yet in the document; the ones made after it, waiting their turn */
  let inflight: string | null = null;
  const queue: { splices: Splice[]; after: string }[] = [];
  const changes = new Set<Listener<ChangeOrigin>>();
  const assets = new Set<(p: string, v: number) => void>();
  const uploads = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
  let uploadId = 0;
  const send = () => {
    const next = queue.shift();
    if (!next) return;
    inflight = next.after;
    vscode.postMessage({ type: 'dlApply', version, splices: next.splices });
  };
  addEventListener('message', (ev: MessageEvent<HostToDeliverable>) => {
    const m = ev.data;
    if (m?.type === 'dlText') {
      version = m.version;
      if (inflight !== null && m.text === inflight) {
        // our change, in the document now: the next one goes
        inflight = null;
        send();
        return;
      }
      if (inflight === null && !queue.length && m.text === text) return;
      // somebody else's change (or ours refused): the document's text wins, what waited is dropped
      inflight = null;
      queue.length = 0;
      if (m.text !== text) { text = m.text; for (const c of changes) c('remote'); }
    } else if (m?.type === 'dlAsset') for (const a of assets) a(m.path, m.v);
    else if (m?.type === 'dlUploaded') {
      const u = uploads.get(m.id);
      uploads.delete(m.id);
      if (m.error) u?.reject(new Error(m.error)); else u?.resolve();
    }
  });
  return {
    path: init.entry,
    text: () => text,
    apply(splices: Splice[], origin) {
      if (!splices.length) return;
      // at once here (the canvas shows it), then in the document — one change at a time, each on the version the one before made
      let t = text;
      for (const s of [...splices].sort((a, b) => b.from - a.from || b.to - a.to)) t = t.slice(0, s.from) + s.insert + t.slice(s.to);
      text = t;
      queue.push({ splices, after: t });
      if (inflight === null) send();
      for (const c of changes) c(origin);
    },
    onChange(cb) { changes.add(cb); return () => changes.delete(cb); },
    undo: () => vscode.postMessage({ type: 'dlUndo' }),
    redo: () => vscode.postMessage({ type: 'dlRedo' }),
    ready: () => true,
    onReady: () => () => {},
    online: () => true,
    onStatus: () => () => {},
    readOnly: () => init.readOnly,
    link: async () => ({ base: init.base, entry: init.entry }),
    upload: (rel, data) => new Promise<void>((resolve, reject) => {
      const id = ++uploadId;
      uploads.set(id, { resolve, reject });
      void data.arrayBuffer().then(buf => {
        let bin = '';
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        vscode.postMessage({ type: 'dlUpload', id, rel, data: btoa(bin) });
      });
    }),
    onAsset(cb) { assets.add(cb); return () => assets.delete(cb); },
    setSelection: () => {},
    onPeers: () => () => {},
    downloads: open => [
      { label: 'Print or save as PDF (in the browser)…', action: () => vscode.postMessage({ type: 'dlOpenExternal', url: open('print') + '#print' }) },
      { label: 'Open in the browser', action: () => vscode.postMessage({ type: 'dlOpenExternal', url: open('view') }) },
    ],
    present(url) { vscode.postMessage({ type: 'dlOpenExternal', url }); return true; },
    save: () => vscode.postMessage({ type: 'dlSave' }),
    // VS Code's own shortcuts (⌘P, ⌘W …): a key the page's frame got is handed to the webview's window, which VS Code listens to
    key(k) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: k.key, code: k.key.length === 1 ? 'Key' + k.key.toUpperCase() : k.key, ctrlKey: k.ctrl, shiftKey: k.shift, altKey: k.alt, metaKey: k.meta, bubbles: true }));
    },
  };
}

const notify = (text: string, kind?: 'info' | 'error') => vscode.postMessage({ type: 'notify', kind, text });

const onInit = (ev: MessageEvent<HostToDeliverable>) => {
  const m = ev.data;
  if (m?.type !== 'dlInit') return;
  removeEventListener('message', onInit);
  applyTheme(m.dark);
  render(<DeliverableCanvas host={vscodeHost(m)} notify={notify} />, document.getElementById('app')!);
};
addEventListener('message', onInit);
vscode.postMessage({ type: 'ready' });

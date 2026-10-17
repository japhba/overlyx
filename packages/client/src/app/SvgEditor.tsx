import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, fileUrl } from '../api';
import { DeliverableCanvas } from '../deliverable/DeliverableEditor';
import type { ChangeOrigin, DeliverableHost } from '../deliverable/host';
import { applyTo } from '../deliverable/sourceops';
import { svgCanvasSource, svgFileFromCanvas, SVG_FILE_ROOT } from '../deliverable/svgSource';
import { uiConfirm } from './Dialogs';
import type { SvgTarget } from '../editor/svgEditorEvents';

/** One overlay in each shell; view-specific project/path are captured by its menu. */
export function SvgEditorHost() {
  const [target, setTarget] = useState<SvgTarget | null>(null);
  useEffect(() => {
    const open = (e: Event) => setTarget((e as CustomEvent<SvgTarget>).detail);
    addEventListener('ol:edit-svg', open);
    return () => removeEventListener('ol:edit-svg', open);
  }, []);
  return target ? <SvgEditor key={target.project + '/' + target.path} target={target} onClose={() => setTarget(null)} /> : null;
}


function SvgEditor({ target, onClose }: { target: SvgTarget; onClose(): void }) {
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const original = useRef('');
  const exporter = useRef<((except?: string) => Promise<string>) | null>(null);
  const saveRef = useRef<() => void>(() => {});
  const active = useRef(true);
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef<() => void>(() => {});
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelector('.ctx-menu, .tb-popup, .dl-floatpop') || document.querySelectorAll('[role="dialog"][aria-modal="true"]').length > 1) return;
      if (e.key === 'Escape') { e.preventDefault(); closeRef.current(); }
      if (e.key === 'Tab') {
        const controls = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, textarea, iframe, [tabindex="0"]') ?? []).filter(el => el.getClientRects().length > 0);
        const first = controls[0], last = controls.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    addEventListener('keydown', key);
    return () => { removeEventListener('keydown', key); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    active.current = true;
    const controller = new AbortController();
    void fetch(fileUrl(target.project, target.path), { credentials: 'include', cache: 'no-store', signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error(`Could not read the SVG (HTTP ${response.status}).`);
      const text = await response.text();
      const html = svgCanvasSource(text);
      if (active.current) { original.current = text; setSource(html); }
    }).catch(e => { if (active.current && e.name !== 'AbortError') setError(String(e.message)); });
    return () => { active.current = false; controller.abort(); };
  }, [target]);
  const host = useMemo<DeliverableHost | null>(() => {
    if (source === null) return null;
    let text = source;
    const history: string[] = [], future: string[] = [];
    const listeners = new Set<(origin: ChangeOrigin) => void>();
    const changed = () => { setDirty(text !== source); listeners.forEach(cb => cb('canvas')); };
    const base = (globalThis as { OVERLYX_CANVAS_BASE?: string }).OVERLYX_CANVAS_BASE ?? new URL('/_ol/', location.href).href;
    return {
      path: target.path, text: () => text,
      folderBase: new URL(fileUrl(target.project, '') + target.path.split('/').slice(0, -1).map(encodeURIComponent).map(part => part + '/').join(''), location.href).href,
      apply(splices) { if (target.readOnly) return; const next = applyTo(text, splices); if (next === text) return; history.push(text); future.length = 0; text = next; changed(); },
      onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); },
      undo() { const previous = history.pop(); if (previous !== undefined) { future.push(text); text = previous; changed(); } },
      redo() { const next = future.pop(); if (next !== undefined) { history.push(text); text = next; changed(); } },
      ready: () => true, onReady: () => () => {}, online: () => true, onStatus: () => () => {}, readOnly: () => target.readOnly,
      link: async () => ({ base, entry: 'svg-frame.html' }),
      upload: async (path, data) => { if (target.readOnly) throw new Error('This drawing is read-only.'); await api.upload(target.project, path, data, { overwrite: false }); },
      onAsset: () => () => {}, setSelection() {}, onPeers: () => () => {}, downloads: () => [],
      bindSvgExporter(fn) { exporter.current = fn; return () => { exporter.current = null; }; },
      save: () => saveRef.current(),
    };
  }, [source, target]);
  const saved = useRef(false);
  const save = async () => {
    if (!host || !exporter.current || saving || target.readOnly) return;
    setSaving(true); setError('');
    try {
      // the file as it was with the edits made to it (the page as drawn only when the drawing is gone)
      const svg = svgFileFromCanvas(original.current, host.text(), await exporter.current(`[${SVG_FILE_ROOT}]`)) ?? await exporter.current();
      const response = await fetch(fileUrl(target.project, target.path), { credentials: 'include', cache: 'no-store' });
      if (!response.ok || await response.text() !== original.current) throw new Error('The SVG changed on disk while this editor was open. Reopen it before saving your changes.');
      await api.upload(target.project, target.path, new Blob([svg], { type: 'image/svg+xml' }));
      saved.current = true;
      if (active.current) { original.current = svg; target.onSaved?.(); onClose(); }
    } catch (e) { if (active.current) setError(String((e as Error).message)); }
    finally { if (active.current) setSaving(false); }
  };
  saveRef.current = () => { void save(); };
  // closed without saving: a drawing made a moment ago (Insert ▸ Drawing) goes again
  const leave = () => { if (!saved.current) target.onDiscard?.(); onClose(); };
  const close = () => { if (saving) return; if (!dirty) leave(); else void uiConfirm('Discard SVG changes?', 'Close this drawing without saving?').then(ok => { if (ok) leave(); }); };
  closeRef.current = close;
  return <div class="dialog-backdrop svg-lightbox" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
    <div ref={panel} class="svg-lightbox-panel" role="dialog" aria-modal="true" aria-label={`SVG editor — ${target.path}`}>
      <div class="svg-lightbox-bar"><strong>SVG editor — {target.path}</strong><span style="flex:1" />
        <button class="btn" disabled={saving} onClick={close}>Cancel</button>
        <button class="btn primary" disabled={!host || saving || target.readOnly || !dirty} onClick={() => void save()}>{saving ? 'Saving…' : 'Save SVG'}</button>
      </div>
      {error && <div class="svg-lightbox-error" role="alert">{error}</div>}
      {host ? <DeliverableCanvas host={host} notify={(message, kind) => { if (kind === 'error') setError(message); }} /> : !error && <p>Opening SVG…</p>}
    </div>
  </div>;
}

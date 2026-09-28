/**
 * File ▸ New slides / poster / page…: a layout document (pages of freely placed objects, a beamer
 * file) from one of the page presets — slides in beamer's aspect ratios, A0/A1 posters, A4 / Letter
 * pages. The server writes it from core's layout templates (POST /api/projects/:p/new, `layout`).
 */
import { useState } from 'preact/hooks';
import { PAGE_PRESETS } from '@overlyx/core';
import { api } from '../api';
import { Dialog } from './Dialogs';

export function NewLayoutDialog({ project, dir, onClose, onCreated, notify }: { project: string; dir?: string; onClose: () => void; onCreated: (id: string) => void; notify: (t: string, k?: 'info' | 'error') => void }) {
  const [preset, setPreset] = useState('slides169');
  const kind = PAGE_PRESETS.find(p => p.id === preset)?.kind ?? 'slides';
  const [name, setName] = useState('slides.tex');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const choose = (id: string) => {
    setPreset(id);
    const k = PAGE_PRESETS.find(p => p.id === id)?.kind;
    if (!touched) setName(k === 'poster' ? 'poster.tex' : k === 'page' ? 'page.tex' : 'slides.tex');
  };
  const create = () => {
    let n = name.trim() || 'slides.tex';
    if (!n.endsWith('.tex')) n += '.tex';
    setBusy(true);
    api.newDoc(project, (dir ? dir + '/' : '') + n, { title: n.replace(/\.tex$/, '').replace(/[-_]/g, ' '), layout: preset })
      .then(r => { onClose(); onCreated(r.id); })
      .catch(e => { setBusy(false); notify('Could not create the document: ' + (e as Error).message, 'error'); });
  };
  return (
    <Dialog title="New layout document" onClose={onClose} buttons={<>
      <button type="button" class="small-btn" onClick={onClose}>Cancel</button>
      <button type="button" class="small-btn primary" disabled={busy} onClick={create} data-create-layout>Create</button>
    </>}>
      <p class="dialog-hint">Pages of text boxes, shapes, images and formulas, placed freely — like Keynote or Inkscape. The file is an ordinary beamer <code>.tex</code> document: it compiles anywhere, and animations are beamer overlays.</p>
      <div class="ol-newgrid">
        {PAGE_PRESETS.map(p => {
          const s = 64 / Math.max(p.w, p.h);
          return (
            <button key={p.id} type="button" class={'ol-newcard' + (p.id === preset ? ' active' : '')} onClick={() => choose(p.id)} onDblClick={create} data-preset={p.id}>
              <span class="ol-newthumb" style={{ width: `${p.w * s}px`, height: `${p.h * s}px` }} />
              <span class="ol-newlabel">{p.label}</span>
              <span class="ol-newsize">{p.w} × {p.h} mm</span>
            </button>
          );
        })}
      </div>
      <label class="dialog-row">File name <input value={name} onInput={e => { setTouched(true); setName((e.target as HTMLInputElement).value); }} onKeyDown={e => { if (e.key === 'Enter') create(); }} data-layout-name /></label>
      <p class="dialog-hint">{kind === 'slides' ? 'Present it full screen with F5 (or View ▸ Presentation mode).' : kind === 'poster' ? 'Font sizes are in points, as printed: body text around 24–32 pt on A0.' : 'A single page; add more with the Layout toolbar.'}</p>
    </Dialog>
  );
}

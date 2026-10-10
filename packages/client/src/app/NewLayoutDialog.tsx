/**
 * File ▸ New slides / poster / page…: an HTML deliverable — a folder with an index.html that agents
 * design freely and people edit on a canvas, present and export (deliverable/, server
 * deliverables.ts) — made from core's starting points (html/deliverable.ts). The LaTeX layout
 * documents of before (beamer pages of freely placed objects, core PAGE_PRESETS) stay one click
 * away for those who need a .tex file.
 */
import { useState } from 'preact/hooks';
import { PAGE_PRESETS } from '@overlyx/core';
import { api } from '../api';
import { Dialog } from './Dialogs';

type Kind = 'deck' | 'poster' | 'page';
const KINDS: { id: Kind; label: string; hint: string; w: number; h: number; dir: string }[] = [
  { id: 'deck', label: 'Slide deck', hint: '16:9 slides, presented full screen', w: 16, h: 9, dir: 'talk' },
  { id: 'poster', label: 'Poster', hint: 'A0 portrait, printed as PDF', w: 841, h: 1189, dir: 'poster' },
  { id: 'page', label: 'Web page', hint: 'A project page or a small site', w: 12, h: 9, dir: 'site' },
];

export function NewLayoutDialog({ project, dir, onClose, onCreated, notify }: { project: string; dir?: string; onClose: () => void; onCreated: (id: string) => void; notify: (t: string, k?: 'info' | 'error') => void }) {
  const [latex, setLatex] = useState(false);
  const [kind, setKind] = useState<Kind>('deck');
  const [folder, setFolder] = useState('talk');
  const [title, setTitle] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  if (latex) return <LatexLayoutDialog project={project} dir={dir} onClose={onClose} onCreated={onCreated} notify={notify} onBack={() => setLatex(false)} />;
  const choose = (k: Kind) => { setKind(k); if (!touched) setFolder(KINDS.find(x => x.id === k)!.dir); };
  const create = () => {
    const f = folder.trim().replace(/^\/+|\/+$/g, '') || KINDS.find(x => x.id === kind)!.dir;
    setBusy(true);
    api.newDeliverable(project, (dir ? dir + '/' : '') + f, kind, title.trim() || undefined)
      .then(r => { onClose(); onCreated(r.id); })
      .catch(e => { setBusy(false); notify('Could not create it: ' + (e as Error).message, 'error'); });
  };
  return (
    <Dialog title="New slides, poster or web page" onClose={onClose} buttons={<>
      <button type="button" class="small-btn" onClick={onClose}>Cancel</button>
      <button type="button" class="small-btn primary" disabled={busy} onClick={create} data-create-deliverable>Create</button>
    </>}>
      <p class="dialog-hint">A folder with a web page (<code>index.html</code>) that you and agents can design any way you like. Edit it on the canvas or in its code, present it, and download it as a PDF or a website.</p>
      <div class="ol-newkinds">
        {KINDS.map(k => {
          const s = 48 / Math.max(k.w, k.h);
          return (
            <button key={k.id} type="button" class={'ol-newkind' + (k.id === kind ? ' active' : '')} onClick={() => choose(k.id)} onDblClick={create} data-kind={k.id}>
              <span class="ol-newthumb" style={{ width: `${k.w * s}px`, height: `${k.h * s}px` }} />
              <span>{k.label}</span>
              <small>{k.hint}</small>
            </button>
          );
        })}
      </div>
      <label class="dialog-row">Title <input value={title} placeholder="Untitled" onInput={e => setTitle((e.target as HTMLInputElement).value)} onKeyDown={e => { if (e.key === 'Enter') create(); }} data-deliverable-title /></label>
      <label class="dialog-row">Folder <input value={folder} onInput={e => { setTouched(true); setFolder((e.target as HTMLInputElement).value); }} onKeyDown={e => { if (e.key === 'Enter') create(); }} data-deliverable-folder /></label>
      <p class="dialog-hint">Ask your agent to design it — it is told what kind of deliverable this is. <a href="#" onClick={e => { e.preventDefault(); setLatex(true); }} data-latex-layout>A LaTeX (beamer) layout document instead…</a></p>
    </Dialog>
  );
}

/** the LaTeX layout documents (a beamer .tex of freely placed objects, from a page preset) */
function LatexLayoutDialog({ project, dir, onClose, onCreated, notify, onBack }: { project: string; dir?: string; onClose: () => void; onCreated: (id: string) => void; notify: (t: string, k?: 'info' | 'error') => void; onBack: () => void }) {
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
    <Dialog title="New LaTeX layout document" onClose={onClose} buttons={<>
      <button type="button" class="small-btn" onClick={onBack}>Back</button>
      <button type="button" class="small-btn" onClick={onClose}>Cancel</button>
      <button type="button" class="small-btn primary" disabled={busy} onClick={create} data-create-layout>Create</button>
    </>}>
      <p class="dialog-hint">Pages of text boxes, shapes, images and formulas, placed freely. The file is an ordinary beamer <code>.tex</code> document: it compiles anywhere, and animations are beamer overlays.</p>
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

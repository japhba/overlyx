import { useState } from 'preact/hooks';
import { vscode } from './globals';

/** Native window zoom scales toolbars, dialogs, canvases and pointer coordinates together. */
export function InterfaceZoom() {
  const [open, setOpen] = useState(false);
  const zoom = (action: 'in' | 'out' | 'reset') => vscode.postMessage({ type: 'interfaceZoom', action });
  return <span class="interface-zoom">
    <button class="small-btn" title="Interface zoom — scales the entire VS Code window" aria-expanded={open} onClick={() => setOpen(v => !v)}>UI zoom</button>
    {open && <span role="group" aria-label="Interface zoom">
      <button class="small-btn" title="Zoom interface out" aria-label="Zoom interface out" onClick={() => zoom('out')}>−</button>
      <button class="small-btn" title="Reset interface zoom" onClick={() => zoom('reset')}>Reset</button>
      <button class="small-btn" title="Zoom interface in" aria-label="Zoom interface in" onClick={() => zoom('in')}>+</button>
    </span>}
  </span>;
}

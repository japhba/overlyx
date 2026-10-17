export interface SvgTarget {
  project: string; path: string; readOnly: boolean;
  onSaved?(): void;
  /** closed without saving (Cancel, Esc): a drawing made a moment ago by Insert ▸ Drawing goes again */
  onDiscard?(): void;
}
export function openSvgEditor(target: SvgTarget) { window.dispatchEvent(new CustomEvent('ol:edit-svg', { detail: target })); }

/** Edit the SVG at `path` (project-relative) in the layout canvas pop-up (app/SvgEditor.tsx); its figures reload once it is saved. */
export function editSvgFile(project: string, path: string, readOnly: boolean, extra: Pick<SvgTarget, 'onDiscard'> = {}) {
  openSvgEditor({ project, path, readOnly, ...extra, onSaved: () => window.dispatchEvent(new CustomEvent('ol:svg-saved', { detail: { project, path } })) });
}

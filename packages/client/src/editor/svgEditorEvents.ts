export interface SvgTarget { project: string; path: string; readOnly: boolean; onSaved?(): void }
export function openSvgEditor(target: SvgTarget) { window.dispatchEvent(new CustomEvent('ol:edit-svg', { detail: target })); }

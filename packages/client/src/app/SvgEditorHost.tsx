import { useEffect, useState } from 'preact/hooks';
import type { SvgTarget } from '../editor/svgEditorEvents';

type SvgEditorComponent = typeof import('./SvgEditor').SvgEditor;
let editorModule: Promise<SvgEditorComponent> | null = null;

/**
 * One overlay in each shell; view-specific project/path are captured by its menu. The editor itself
 * (the slide canvas, its toolbars and fonts) is loaded on the first SVG opened: the VS Code
 * extension's document editor no longer loads and compiles it before showing the document.
 */
export function SvgEditorHost() {
  const [target, setTarget] = useState<SvgTarget | null>(null);
  const [Editor, setEditor] = useState<SvgEditorComponent | null>(null);
  useEffect(() => {
    let mounted = true;
    const open = (e: Event) => {
      const next = (e as CustomEvent<SvgTarget>).detail;
      void (editorModule ??= import('./SvgEditor').then(m => m.SvgEditor)).then(E => {
        if (!mounted) return;
        setEditor(() => E);
        setTarget(next);
      }, error => { editorModule = null; console.error('OverLyX: could not load the SVG editor', error); });
    };
    addEventListener('ol:edit-svg', open);
    return () => { mounted = false; removeEventListener('ol:edit-svg', open); };
  }, []);
  return target && Editor ? <Editor key={target.project + '/' + target.path} target={target} onClose={() => setTarget(null)} /> : null;
}

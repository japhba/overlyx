/**
 * Insert ▸ Drawing (Google Docs' Insert ▸ Drawing ▸ New): a new, empty SVG figure — figures/drawing.svg,
 * drawing-2.svg … — at the cursor, opened at once in the SVG editor (the layout canvas in a pop-up:
 * shapes, lines, pen, text, formulas). Closed without saving, the figure and its file go again.
 */
import type { EditorView } from 'prosemirror-view';
import { api } from '../api';
import { insertGraphics } from './commands';
import { uploadUnique } from './imagepaste';
import { editorContext, resolveDocPath, toDocRel, viewDocDir, viewProject } from './context';
import { editSvgFile } from './svgEditorEvents';
import { paramMap } from '@overlyx/core';

/** the empty drawing: a canvas of 16:9 in CSS px, transparent */
const BLANK = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"></svg>\n';

export async function insertDrawing(view: EditorView): Promise<void> {
  const project = viewProject(view) || editorContext.project;
  if (!project || !view.editable) return;
  let rel: string;
  try { rel = await uploadUnique(project, 'drawing', 'svg', new Blob([BLANK], { type: 'image/svg+xml' })); }
  catch (e) { editorContext.notify?.(`Could not make the drawing: ${(e as Error).message}`, 'error'); return; }
  const file = toDocRel(rel, viewDocDir(view));
  insertGraphics(file, { width: '60col%' })(view.state, view.dispatch);
  view.focus();
  editSvgFile(project, rel, false, {
    onDiscard: () => {
      // the figure that names this file, and the file itself
      const tr = view.state.tr;
      view.state.doc.descendants((n, pos) => {
        if (n.type.name !== 'graphics') return true;
        let p: Map<string, string>;
        try { p = paramMap(JSON.parse(n.attrs.params || '[]')); } catch { return false; }
        if (resolveDocPath(p.get('filename') ?? '', viewDocDir(view)) === rel) tr.delete(tr.mapping.map(pos), tr.mapping.map(pos + n.nodeSize));
        return false;
      });
      if (tr.docChanged) view.dispatch(tr);
      void api.fileOp(project, { op: 'delete', from: rel }).catch(() => {});
    },
  });
}

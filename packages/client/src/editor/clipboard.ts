/** Clipboard and file drops are identical in browser and VS Code editors. */
import type { DirectEditorProps } from 'prosemirror-view';
import { Fragment, Slice } from 'prosemirror-model';
import { schema } from '@overlyx/core';
import { api } from '../api';
import { editorContext } from './context';
import { imageFiles, insertImageFiles, isSvgMarkup, looksLikeImageFileName, svgFile } from './imagepaste';

export function editorClipboard(docId: string, readOnly: () => boolean): Pick<DirectEditorProps, 'handlePaste' | 'handleDrop'> {
  return {
    handlePaste(view, event) {
      // an image on the clipboard (a screenshot, a copied image file): upload it, insert a graphics inset
      const images = imageFiles(event.clipboardData);
      if (images.length) {
        if (!readOnly()) void insertImageFiles(view, images);
        return true;
      }
      const text = event.clipboardData?.getData('text/plain');
      const html = event.clipboardData?.getData('text/html');
      // SVG markup on the text clipboard ("Copy as SVG" in drawing tools): an image, not text
      if (text && !readOnly() && isSvgMarkup(text)) { void insertImageFiles(view, [svgFile(text)]); return true; }
      /** plain text without LaTeX: LyX semantics (blank line = new paragraph, no HTML structure) */
      const plainPaste = () => {
        const paras = text!.replace(/\r\n/g, '\n').split(/\n{2,}/);
        if (paras.length === 1) { view.dispatch(view.state.tr.insertText(text!.replace(/\n/g, ' '))); return; }
        let tr = view.state.tr.deleteSelection();
        paras.forEach((p, i) => {
          if (i > 0) tr = tr.split(tr.selection.from);
          tr = tr.insertText(p.replace(/\n/g, ' '));
        });
        view.dispatch(tr);
      };
      if (text && !html) {
        // just an image file's name: Safari (and Firefox on macOS) deliver only that for a file
        // copied in the Finder — paste it as text, but say how to get the image itself in
        if (looksLikeImageFileName(text)) {
          plainPaste();
          editorContext.notify?.('Only the file’s name was on the clipboard — to insert the image, drag the file into the text (or copy it in Chrome)');
          return true;
        }
        // pasted LaTeX (a \command, $…$, \[ …) is parsed on the server against this document's own
        // preamble and inserted as real structure — sections, formulas, citations, lists
        if (!readOnly() && /\\[a-zA-Z]+|\\\[|\\\(|\$[^$\n][^$]*\$/.test(text)) {
          void api.parseClip(view.dom.dataset.docId ?? docId, text).then(r => {
            const blocks = (r.blocks as unknown[]).map(b => schema.nodeFromJSON(b)).filter(n => n.type.name !== 'doc');
            if (!blocks.length) { plainPaste(); return; }
            // a single plain paragraph flows into the current one; anything structured is inserted as whole paragraphs (closed slice — an open one would dissolve the first block's layout)
            const single = blocks.length === 1 && blocks[0].type.name === 'paragraph' && blocks[0].attrs.layout === 'Standard' && !blocks[0].attrs.depth;
            const slice = single ? new Slice(Fragment.from(blocks[0].content), 0, 0) : new Slice(Fragment.from(blocks), 0, 0);
            view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView());
            view.focus();
          }).catch(e => { console.warn('LaTeX paste fell back to plain text:', e); plainPaste(); });
          return true;
        }
        plainPaste();
        return true;
      }
      return false;
    },
    // files dragged in from the computer: images are uploaded and inserted where they were dropped
    handleDrop(view, event, _slice, moved) {
      if (moved || !event.dataTransfer?.files.length) return false;   // internal drags and text drops: ProseMirror's own handling
      if (readOnly()) return true;
      const images = imageFiles(event.dataTransfer);
      if (!images.length) { editorContext.notify?.('Only images can be dropped into the text — other files go into the file browser', 'error'); return true; }
      const pos = view.posAtCoords({ left: event.clientX, top: event.clientY });
      void insertImageFiles(view, images, pos ? pos.pos : null);
      return true;
    },
  };
}

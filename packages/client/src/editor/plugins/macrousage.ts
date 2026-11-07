/**
 * What the editor can only show as TeX code, counted in the anonymous usage statistics (kind
 * `macro`: client usage.ts recordMacro, once per name and page load) so that the common commands get
 * drawn (the usage report lists them; the maintenance worker takes them up): a formula's commands and
 * environments nothing here knows, as they are drawn (core math/mathjax.ts onUnknownMathCommand), and
 * the command a TeX-code box of the text starts with, looked for a little after the document opens and
 * after edits. Only bare names; the document's own macros are left out.
 */
import { Plugin } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { onUnknownMathCommand } from '@overlyx/core';
import { recordMacro } from '../../usage';
import { editorContext } from '../context';

const own = (name: string) => !!editorContext.meta?.macros && Object.prototype.hasOwnProperty.call(editorContext.meta.macros, name.replace(/\*$/, ''));

/** The command a TeX-code box shows first: `\vspace{…}` → vspace, `\begin{tikzpicture}` → the environment; comments skipped. */
export function ertCommand(text: string): { kind: 'text' | 'env'; name: string } | null {
  const code = text.replace(/(^|[^\\])%.*$/gm, '$1');
  const m = /\\begin\s*\{([A-Za-z]+\*?)\}|\\([A-Za-z]+\*?)/.exec(code);
  if (!m) return null;
  return m[1] ? { kind: 'env', name: m[1] } : { kind: 'text', name: m[2] };
}

function scan(doc: PMNode): void {
  doc.descendants(n => {
    if (n.type.name === 'inset' && n.attrs.name === 'ERT') {
      const c = ertCommand(n.textContent);
      if (c && (c.kind === 'env' || !own(c.name))) recordMacro(c.kind, c.name);
      return false;
    }
    return !n.isText;
  });
}

export function macroUsagePlugin(): Plugin {
  onUnknownMathCommand((kind, name) => { if (kind === 'env' || !own(name)) recordMacro(kind, name); });
  return new Plugin({
    view(view) {
      let timer = 0;
      const later = (ms: number) => { if (!timer) timer = window.setTimeout(() => { timer = 0; if (!view.isDestroyed) scan(view.state.doc); }, ms); };
      later(3000);
      return {
        update(v, prev) { if (v.state.doc !== prev.doc) later(30000); },
        destroy() { clearTimeout(timer); },
      };
    },
  });
}

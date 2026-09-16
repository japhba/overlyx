/**
 * Math macro definitions of an open document — the server's (preamble, \input files, children)
 * and the FormulaMacro insets of the document itself — registered per editor view so formulas
 * render with them (lyxmath/macrotable.ts). Shared by the web client and the VS Code webview
 * through the editor assembly (assembly.ts).
 */
import { Plugin } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { setDocumentMacros, setInlineMacroDefs, markMacrosReady, macroTableFor, macrosReady, macroVersion, mathViews } from './lyxmath/macrotable';
import { editorContext } from './context';

type ServerMacros = Record<string, { def: string; args: number; expand: boolean }>;
interface InlineDef { pos: number; name: string; def: string; args: number }
const serverMacrosByView = new WeakMap<EditorView, { macros: ServerMacros; merge: boolean }>();

/**
 * Registers the positional macro definitions of every new document state *before* the view renders
 * it: node views of formulas ask for their macro table when they are created, so the definitions
 * must be known by then (otherwise every formula would be rendered twice on load).
 */
export function macroDefsPlugin(getView: () => EditorView | null): Plugin {
  return new Plugin({
    state: {
      init: () => '',
      apply(tr, sig: string, _old, newState) {
        if (!tr.docChanged) return sig;
        const view = getView();
        if (!view) return sig;
        const defs = inlineMacroDefs(newState.doc);
        const next = JSON.stringify(defs);
        if (next === sig) return sig;
        const server = serverMacrosByView.get(view);
        if (server) applyMacros(view, defs, server.macros, server.merge);
        else setInlineMacroDefs(view, defs);   // metadata still loading: positional defs only
        return next;
      },
    },
  });
}

/** FormulaMacro insets of a document (definition + position). */
function inlineMacroDefs(doc: import('prosemirror-model').Node): InlineDef[] {
  const defs: InlineDef[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'macro') return true;
    try {
      const lines: string[] = JSON.parse(node.attrs.lines);
      const m = /^\\(?:re)?newcommand\*?\{\\([A-Za-z]+)\}(?:\[(\d+)\])?\{([\s\S]*)\}$/.exec(lines[0]);
      if (m) {
        let display: string | undefined;
        if (lines[1]?.startsWith('{')) display = lines[1].slice(1, -1);
        defs.push({ pos, name: m[1], def: display || m[3], args: Number(m[2] ?? 0) });
      }
    } catch { /* ignore */ }
    return false;   // macro nodes have no formulas inside
  });
  return defs;
}

function applyMacros(view: EditorView, defs: InlineDef[], serverMacros: ServerMacros, merge: boolean): void {
  // server macros minus the ones this document defines itself (positional defs take over)
  const own = new Set(defs.map(d => d.name));
  const base: ServerMacros = {};
  for (const [k, v] of Object.entries(serverMacros)) if (!own.has(k)) base[k] = v;
  setDocumentMacros(view, base, merge);
  setInlineMacroDefs(view, defs);
}

/**
 * Macros: server-provided ones (preamble, \input files, child documents) apply everywhere;
 * FormulaMacro insets of this document apply from their position onwards (LyX semantics).
 * `merge` adds to the global dictionary instead of replacing it (child editors of a combined view).
 * The server macros are remembered per view; later document changes re-apply them through
 * `macroDefsPlugin`.
 */
export function refreshMacros(view: EditorView, serverMacros: ServerMacros | null, merge = false): void {
  // null: the metadata is unavailable right now (an offline blip, a failed fetch during a deploy) —
  // keep the macros this view already had instead of wiping every formula to "unknown"
  const remembered = serverMacrosByView.get(view);
  const macros = serverMacros ?? remembered?.macros ?? {};
  const mrg = serverMacros ? merge : remembered?.merge ?? merge;
  serverMacrosByView.set(view, { macros, merge: mrg });
  markMacrosReady(view);
  applyMacros(view, inlineMacroDefs(view.state.doc), macros, mrg);
}


// dev-only debugging hooks (the probes in scratch/ read these; absent from production builds)
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as { olMacroDebug?: unknown }).olMacroDebug = {
    macroTableFor, macrosReady, version: () => macroVersion, refreshMacros,
    remembered: (v: object) => serverMacrosByView.get(v as EditorView),
    views: () => [...mathViews].map(v => { const x = v as unknown as { field?: unknown; pending?: boolean; staticKey?: string; view?: object; dom?: HTMLElement }; return { field: !!x.field, pending: !!x.pending, key: x.staticKey?.split('|').slice(0, 2).join('|') ?? null, active: x.view === editorContext.activeView, attached: !!x.dom?.isConnected }; }),
  };
}

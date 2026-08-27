/**
 * Macro tables for the math editor: server-provided macros (preamble, \input files, master/child
 * documents) apply everywhere, FormulaMacro insets of a document apply from their position onwards
 * (LyX's positional semantics). Every formula asks for the table that applies at its position.
 */
import type { MacroTable } from '@overlyx/core';

interface InlineDef { pos: number; name: string; def: string; args: number }

/** Fallbacks for packages KaTeX does not know; document macros override them. */
const FALLBACK_MACROS: Record<string, { def: string; args: number }> = {
  llbracket: { def: '[\\![', args: 0 }, rrbracket: { def: ']\\!]', args: 0 },
  llangle: { def: '\\langle\\!\\langle', args: 0 }, rrangle: { def: '\\rangle\\!\\rangle', args: 0 },
  dv: { def: '\\frac{d #1}{d #2}', args: 2 }, pdv: { def: '\\frac{\\partial #1}{\\partial #2}', args: 2 },
  dd: { def: '\\mathrm{d}#1', args: 1 }, ev: { def: '\\left\\langle #1\\right\\rangle', args: 1 },
  abs: { def: '\\left|#1\\right|', args: 1 }, norm: { def: '\\left\\lVert #1\\right\\rVert', args: 1 },
  qty: { def: '\\left(#1\\right)', args: 1 }, order: { def: '\\mathcal{O}\\left(#1\\right)', args: 1 },
  tr: { def: '\\operatorname{tr}', args: 0 }, Tr: { def: '\\operatorname{Tr}', args: 0 },
  var: { def: '\\operatorname{Var}', args: 0 }, expval: { def: '\\left\\langle #1\\right\\rangle', args: 1 },
  intercal: { def: '\\top', args: 0 },
};

let docMacros: MacroTable = {};
let docVersion = 0;
let docSignature = '';
const inlineDefsByView = new WeakMap<object, InlineDef[]>();
const tableCache = new Map<string, MacroTable>();
const signatureByView = new WeakMap<object, string>();
/** bumped whenever any macro definition changes; fields compare it to re-render */
export let macroVersion = 0;

/** All live math node views (editable fields and statically rendered formulas). */
export const mathViews = new Set<{ refreshMacros(): void }>();
function refreshAllFields(): void { for (const v of mathViews) v.refreshMacros(); }

/**
 * Views whose document macros (server metadata) have been registered. Formulas of a view that is
 * not ready yet are only shown as placeholders: the document syncs while its metadata is still
 * loading, and rendering everything with an incomplete macro table would be wasted work.
 */
const readyViews = new WeakSet<object>();
export function markMacrosReady(view: object): void { readyViews.add(view); }
export function macrosReady(view: object | undefined): boolean { return !!view && readyViews.has(view); }

/** Set the macros that apply to every formula. `merge` keeps previously set macros (child editors of a combined view). */
export function setDocumentMacros(macros: Record<string, { def: string; args: number; expand?: boolean }>, merge = false): void {
  const next: MacroTable = merge ? { ...docMacros } : {};
  if (!merge) for (const [k, v] of Object.entries(FALLBACK_MACROS)) next[k] = { nargs: v.args, def: v.def };
  for (const [k, v] of Object.entries(macros)) next[k] = { nargs: v.args, def: v.def };
  // unchanged tables must not invalidate anything: every formula would re-render for nothing
  const sig = JSON.stringify(next);
  if (sig === docSignature) return;
  docSignature = sig;
  docMacros = next;
  docVersion++;
  tableCache.clear();
}

/** Register the positional macro definitions of a view; re-renders the fields if anything changed. */
export function setInlineMacroDefs(view: object, defs: InlineDef[]): void {
  inlineDefsByView.set(view, defs);
  const sig = docVersion + '|' + JSON.stringify(defs);
  if (sig === signatureByView.get(view)) return;
  signatureByView.set(view, sig);
  macroVersion++;
  tableCache.clear();
  refreshAllFields();
}

/** The macro table (document macros + positional definitions before `pos`) for a formula, with a cache key. */
export function macroTableFor(view: object | undefined, pos: number | undefined): { key: string; table: MacroTable } {
  const defs = view ? inlineDefsByView.get(view) ?? [] : [];
  const applicable = pos === undefined ? defs : defs.filter(d => d.pos < pos);
  const key = docVersion + '|' + applicable.map(d => `${d.name}=${d.args}:${d.def}`).join(';');
  let table = tableCache.get(key);
  if (!table) {
    table = { ...docMacros };
    for (const d of applicable) table[d.name] = { nargs: d.args, def: d.def };
    tableCache.set(key, table);
  }
  return { key, table };
}

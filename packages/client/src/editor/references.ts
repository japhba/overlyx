import type { Node as PMNode } from 'prosemirror-model';
import type { EditorState, Transaction } from 'prosemirror-state';
import { schema, paramMap, unquote } from '@overlyx/core';

export interface ReferenceTarget { key: string; title: string; kind: string; node: PMNode; labelAt: number; label?: string }
export interface ReferenceOptions { tuple?: 'list' | 'range'; caps?: boolean; targets?: ReferenceTarget[]; reserved?: string[] }

/** Numbered objects can be referenced before the author has created a label. */
export function referenceTargets(doc: PMNode, layouts: { name: string; isNumbered?: boolean; tocLevel?: number }[] = []): ReferenceTarget[] {
  const out: ReferenceTarget[] = [];
  doc.descendants((node, pos) => {
    let kind = '', at = pos + node.nodeSize - 1;
    if (node.type.name === 'paragraph') {
      const layout = layouts.find(l => l.name === node.attrs.layout);
      if ((layout?.tocLevel !== undefined && layout.tocLevel >= -2 && layout.tocLevel < 10) || /^(Part|Chapter|Section|Subsection|Subsubsection)$/.test(node.attrs.layout)) kind = 'section';
      else if (layout?.isNumbered || /^(Theorem|Lemma|Proposition|Corollary|Definition|Example)/.test(node.attrs.layout)) kind = 'theorem';
    } else if (node.type.name === 'inset' && ['Float', 'Wrap'].includes(node.attrs.name)) {
      kind = String(node.attrs.arg || 'figure');
      // Labels in floats follow the caption, which advances the counter.
      let caption: number | undefined;
      node.descendants((n, offset) => { if (n.type.name === 'inset' && n.attrs.name === 'Caption') { caption = pos + 1 + offset + n.nodeSize; return false; } return true; });
      if (caption === undefined) return true;
      at = caption;
    } else if (node.type.name === 'math_display') kind = 'equation';
    if (!kind) return true;
    let label: string | undefined;
    node.descendants(n => {
      if (n.type.name === 'command' && n.attrs.cmd === 'label') { label ??= unquote(paramMap(JSON.parse(n.attrs.params)).get('name')); return false; }
      return n.type.name !== 'inset' || n.attrs.name === 'Caption';
    });
    if (kind === 'equation') label = /\\label\{([^}]+)\}/.exec(String(node.attrs.latex))?.[1];
    const title = kind === 'equation' ? String(node.attrs.latex).replace(/\\(?:begin|end)\{[^}]+\}/g, '').trim().slice(0, 100) : node.textContent.trim().slice(0, 100);
    out.push({ key: '@target:' + pos, title: title || kind, kind, node, labelAt: at, label });
    return kind === 'section' || kind === 'theorem';
  });
  return out;
}

export function refParams(name: string, kind: string, options: ReferenceOptions = {}): string[] {
  return [`LatexCommand ${kind === 'cref' ? 'formatted' : kind}`, ...(kind === 'cref' ? ['package "cleveref"'] : []), `reference "${name}"`, `tuple "${options.tuple ?? 'list'}"`, 'plural "false"', `caps "${!!options.caps}"`, 'noprefix "false"', 'nolink "false"'];
}

/** Create missing labels and the reference in a single undoable editor transaction. */
export function referenceTransaction(state: EditorState, names: string, kind: string, options: ReferenceOptions = {}, editAt?: number): Transaction {
  const tr = state.tr;
  const reserved = new Set(options.reserved ?? []);
  state.doc.descendants(n => {
    if (n.type.name === 'command' && n.attrs.cmd === 'label') reserved.add(unquote(paramMap(JSON.parse(n.attrs.params)).get('name')));
    if (n.type.name === 'math_display') for (const m of String(n.attrs.latex).matchAll(/\\label\{([^}]+)\}/g)) reserved.add(m[1]);
  });
  const resolved: string[] = [];
  for (const name of names.split(',').map(n => n.trim()).filter(Boolean)) {
    if (!name.startsWith('@target:')) { resolved.push(name); continue; }
    const target = options.targets?.find(t => t.key === name);
    if (!target) throw new Error('The reference target is no longer available');
    let pos = -1;
    state.doc.descendants((node, at) => { if (node === target.node) { pos = at; return false; } return true; });
    if (pos < 0) throw new Error('The target changed while this dialog was open; select it again');
    if (target.label) { resolved.push(target.label); continue; }
    const prefix = ({ section: 'sec', figure: 'fig', table: 'tab', equation: 'eq', theorem: 'thm' } as Record<string, string>)[target.kind] ?? 'obj';
    const stem = prefix + ':' + (target.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'target');
    let label = stem, i = 2;
    while (reserved.has(label)) label = stem + '-' + i++;
    reserved.add(label); resolved.push(label);
    if (target.kind === 'equation') {
      const at = tr.mapping.map(pos), n = tr.doc.nodeAt(at)!;
      let latex = String(n.attrs.latex);
      if (/^\\\[/.test(latex)) latex = latex.replace(/^\\\[/, '\\begin{equation}').replace(/\\\]$/, '\\end{equation}');
      latex = latex.replace(/\\(begin|end)\{(equation|align|gather|multline|flalign|alignat|eqnarray)\*\}/g, '\\$1{$2}');
      // A reference labels the first numbered row of a multi-line equation.
      const rowEnd = latex.indexOf('\\\\');
      if (rowEnd >= 0) latex = latex.slice(0, rowEnd).replace(/\\(?:nonumber|notag)\b/g, '') + `\\label{${label}}` + latex.slice(rowEnd);
      else {
        latex = latex.replace(/\\(?:nonumber|notag)\b/g, '');
        latex = latex.replace(/(\\end\{[^}]+\}\s*)$/, `\\label{${label}}$1`);
      }
      tr.setNodeMarkup(at, undefined, { ...n.attrs, latex });
    } else {
      // target.labelAt is relative to the snapshot node's position.
      const originalPos = Number(target.key.slice('@target:'.length));
      tr.insert(tr.mapping.map(pos + target.labelAt - originalPos), schema.nodes.command.create({ cmd: 'label', params: JSON.stringify(['LatexCommand label', `name "${label}"`]) }));
    }
  }
  const params = JSON.stringify(refParams(resolved.join(','), kind, options));
  if (editAt !== undefined) {
    const pos = tr.mapping.map(editAt), node = tr.doc.nodeAt(pos);
    if (!node || node.type.name !== 'command' || node.attrs.cmd !== 'ref') throw new Error('The reference has moved');
    tr.setNodeMarkup(pos, undefined, { ...node.attrs, params });
  } else tr.replaceSelectionWith(schema.nodes.command.create({ cmd: 'ref', params }));
  return tr.scrollIntoView();
}

/**
 * Decorations that give the WYSIWYG view its LyX look: section numbers, list bullets and
 * numbers, float/caption numbers, footnote numbers, equation numbers, comment headers,
 * and paragraph depth/alignment classes.
 */
import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { ENUM_STYLES, ITEMIZE_BULLETS, isNumberedSection, sectionLevel } from '../layouts';
import { parseHeader } from '@overlyx/core';
import { parseDisplayMath, numberedRows } from '../math';
import { editorContext } from '../context';

export const numberingKey = new PluginKey<DecorationSet>('lyx-numbering');

interface Counters { sec: number[]; enumr: number[]; figure: number; table: number; foot: number; eq: number; theorem: number }

function build(doc: PMNode): DecorationSet {
  const decos: Decoration[] = [];
  const c: Counters = { sec: [0, 0, 0, 0, 0, 0, 0], enumr: [0, 0, 0, 0, 0, 0], figure: 0, table: 0, foot: 0, eq: 0, theorem: 0 };
  let prevLayout = '', prevDepth = 0;
  let appendix = false;
  const secLabel = (level: number) => {
    const parts: string[] = [];
    for (let i = 0; i <= level + 1; i++) parts.push(String(c.sec[i]));
    // drop leading chapter/part zeros for article-like classes
    while (parts.length > 1 && parts[0] === '0') parts.shift();
    if (appendix && parts.length) parts[0] = String.fromCharCode(64 + Number(parts[0]));
    return parts.join('.');
  };

  const walkInsets = (node: PMNode, pos: number, floatType: string | null) => {
    node.forEach((child, off) => {
      const p = pos + off;
      if (child.type.name === 'inset') {
        const name = child.attrs.name as string, arg = child.attrs.arg as string;
        if (name === 'Foot') {
          c.foot++;
          decos.push(Decoration.node(p, p + child.nodeSize, { 'data-number': String(c.foot) }));
        } else if (name === 'Caption') {
          const ft = floatType ?? 'figure';
          let label = '';
          if (ft === 'figure') { c.figure++; label = `Figure ${c.figure}:`; }
          else if (ft === 'table') { c.table++; label = `Table ${c.table}:`; }
          else label = `${ft[0].toUpperCase()}${ft.slice(1)}:`;
          decos.push(Decoration.node(p, p + child.nodeSize, { 'data-caption-label': label }));
        } else if (name === 'Note' && arg === 'Comment') {
          // comment thread headers
          child.forEach((para, poff) => {
            const h = parseHeader(para.textContent.trim());
            if (h) decos.push(Decoration.node(p + 1 + poff, p + 1 + poff + para.nodeSize, { class: 'comment-header' + (h.resolved ? ' resolved' : ''), 'data-author': h.author, 'data-time': h.time }));
          });
        }
        const inner = name === 'Float' || name === 'Wrap' ? arg : floatType;
        // recurse into paragraphs of the inset
        child.forEach((para, poff) => {
          if (para.type.name === 'paragraph') {
            decorateParagraph(para, p + 1 + poff, true);
            walkInsets(para, p + 1 + poff + 1, inner);
          }
        });
      } else if (child.type.name === 'table') {
        child.forEach((row, roff) => row.forEach((cell, coff) => cell.forEach((para, paoff) => {
          const pp = p + 1 + roff + 1 + coff + 1 + paoff;
          if (para.type.name === 'paragraph') { decorateParagraph(para, pp, true); walkInsets(para, pp + 1, floatType); }
        })));
      } else if (child.type.name === 'math_display') {
        const dm = parseDisplayMath(child.attrs.latex);
        const n = numberedRows(dm);
        if (n > 0) {
          const nums: string[] = [];
          for (let i = 0; i < n; i++) nums.push(String(++c.eq));
          decos.push(Decoration.node(p, p + child.nodeSize, { 'data-eqnum': nums.map(x => `(${x})`).join('\n') }));
        }
      }
    });
  };

  const decorateParagraph = (para: PMNode, pos: number, inInset: boolean) => {
    const layout = para.attrs.layout as string;
    const depth = para.attrs.depth as number;
    const attrs: Record<string, string> = {};
    let cls = '';
    if (!inInset) {
      if (para.attrs.appendix) appendix = true;
      const lvl = sectionLevel(layout);
      if (lvl !== null && isNumberedSection(layout)) {
        const idx = lvl + 1;
        c.sec[idx]++;
        for (let i = idx + 1; i < c.sec.length; i++) c.sec[i] = 0;
        if (lvl <= (editorContext.meta?.secnumdepth ?? 3)) attrs['data-label'] = secLabel(lvl);
      }
    }
    if (layout === 'Enumerate') {
      if (prevLayout !== 'Enumerate' || prevDepth < depth) { for (let d = depth; d < c.enumr.length; d++) c.enumr[d] = 0; }
      if (prevLayout === 'Enumerate' && prevDepth > depth) { /* continue outer numbering */ }
      c.enumr[depth] = (c.enumr[depth] ?? 0) + 1;
      attrs['data-label'] = ENUM_STYLES[depth % 4](c.enumr[depth]);
    } else if (layout === 'Itemize') {
      attrs['data-label'] = ITEMIZE_BULLETS[depth % 4];
    } else if (layout === 'Description' || layout === 'Labeling') {
      cls += ' lyx-description';
    } else if (/^(Theorem|Lemma|Corollary|Proposition|Conjecture|Definition|Example|Problem|Exercise|Remark|Claim|Fact|Case|Proof|Axiom|Notation|Solution|Question)\*?$/.test(layout)) {
      if (!layout.endsWith('*') && layout !== 'Proof') { c.theorem++; attrs['data-label'] = `${layout} ${c.theorem}.`; }
      else attrs['data-label'] = layout.replace(/\*$/, '') + '.';
      cls += ' lyx-theorem';
    }
    if (layout !== 'Enumerate' && !(layout === 'Itemize')) { /* keep enum counters when nested lists interleave */ }
    if (layout !== 'Enumerate' && depth === 0) { for (let d = 0; d < c.enumr.length; d++) if (!isListLayoutName(layout)) c.enumr[d] = 0; }
    if (para.attrs.align) attrs['data-align'] = para.attrs.align;
    if (Object.keys(attrs).length || cls) decos.push(Decoration.node(pos, pos + para.nodeSize, { ...attrs, ...(cls ? { class: cls.trim() } : {}) }));
    prevLayout = layout; prevDepth = depth;
  };

  doc.forEach((para, off) => {
    if (para.type.name !== 'paragraph') return;
    decorateParagraph(para, off, false);
    walkInsets(para, off + 1, null);
  });
  return DecorationSet.create(doc, decos);
}

function isListLayoutName(l: string): boolean { return l === 'Itemize' || l === 'Enumerate' || l === 'Description' || l === 'Labeling'; }

export function numberingPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: numberingKey,
    state: {
      init: (_c, state) => build(state.doc),
      apply: (tr, old, _o, newState) => (tr.docChanged ? build(newState.doc) : old),
    },
    props: { decorations: (state) => numberingKey.getState(state) ?? null },
  });
}

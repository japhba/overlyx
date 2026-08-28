/**
 * Plain-text form of a selection for the clipboard (text/plain): what a LaTeX user expects when
 * pasting into a .tex file or a chat — formulas as `$…$`, references as `\ref{…}`, citations as
 * `\cite{…}`, LyX's quote/space/special characters as the characters they stand for, paragraphs
 * separated by blank lines, table cells by tabs.
 */
import type { Node as PMNode, Slice, Fragment } from 'prosemirror-model';
import { quoteChar, spaceChar, specialText } from '@overlyx/core';

function param(node: PMNode, key: string): string {
  try {
    const lines: string[] = JSON.parse(node.attrs.params);
    const l = lines.find(x => x.startsWith(key + ' '));
    return l ? l.slice(key.length + 1).replace(/^"|"$/g, '') : '';
  } catch { return ''; }
}

function commandText(node: PMNode): string {
  const cmd = String(node.attrs.cmd);
  switch (cmd) {
    case 'label': return `\\label{${param(node, 'name')}}`;
    case 'ref': case 'eqref': case 'pageref': case 'vref': case 'vpageref': case 'nameref': case 'formatted': case 'labelonly':
      return `\\${cmd === 'formatted' ? 'ref' : cmd}{${param(node, 'reference')}}`;
    case 'citation': return `\\${param(node, 'LatexCommand') || 'cite'}{${param(node, 'key')}}`;
    case 'href': return param(node, 'name') || param(node, 'target');
    case 'include': case 'input': return `\\${cmd}{${param(node, 'filename')}}`;
    default: return '';
  }
}

export function nodeText(node: PMNode): string {
  switch (node.type.name) {
    case 'text': return node.text ?? '';
    case 'math_inline': return `$${node.attrs.latex}$`;
    case 'math_display': return `\n${node.attrs.latex}\n`;
    case 'macro': { try { return JSON.parse(node.attrs.lines)[0] ?? ''; } catch { return ''; } }
    case 'quotes': return quoteChar(node.attrs.kind);
    case 'space': return spaceChar(node.attrs.kind) || ' ';
    case 'newline': return '\n';
    case 'newpage': return '\n';
    case 'special': return specialText(node.attrs.token, node.attrs.arg);
    case 'command': return commandText(node);
    case 'graphics': return `[${param(node, 'filename')}]`;
    case 'table': return node.content.content.map(row => row.content.content.map(cell => blocksText(cell.content).replace(/\n+/g, ' ')).join('\t')).join('\n');
    case 'inset': return blocksText(node.content);
    case 'paragraph': return inlineText(node.content);
    default: return node.isTextblock ? inlineText(node.content) : blocksText(node.content);
  }
}

function inlineText(f: Fragment): string {
  let s = '';
  f.forEach(n => { s += nodeText(n); });
  return s;
}

function blocksText(f: Fragment): string {
  const parts: string[] = [];
  f.forEach(n => parts.push(nodeText(n)));
  return parts.join('\n\n');
}

export function sliceText(slice: Slice): string {
  const f = slice.content;
  // a partial paragraph selection is inline content; whole paragraphs are blocks
  if (f.firstChild && f.firstChild.isInline) return inlineText(f);
  return blocksText(f);
}

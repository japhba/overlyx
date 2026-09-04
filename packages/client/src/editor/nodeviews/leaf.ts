/**
 * Node views for leaf insets: graphics (rendered to PNG by the server), command insets
 * (label / ref / cite / href / include / bibtex / toc ...), and generic leaves.
 */
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorView, NodeView } from 'prosemirror-view';
import { paramMap, unquote } from '@overlyx/core';
import { graphicsUrl } from '../../api';
import { editorContext, resolveDocPath, viewDocDir, viewProject } from '../context';
import { applyChangeAttrs } from '../plugins/changes';

function params(node: PMNode): Map<string, string> {
  try { return paramMap(JSON.parse(node.attrs.params || '[]')); } catch { return new Map(); }
}

export class GraphicsView implements NodeView {
  dom: HTMLElement;
  img: HTMLImageElement;
  caption: HTMLElement;

  constructor(private node: PMNode, private view: EditorView, private getPos: () => number | undefined) {
    this.dom = document.createElement('span');
    this.dom.className = 'lyx-graphics';
    this.dom.contentEditable = 'false';
    this.img = document.createElement('img');
    this.img.draggable = false;
    this.caption = document.createElement('span');
    this.caption.className = 'graphics-caption';
    this.dom.append(this.img, this.caption);
    this.render();
    this.dom.addEventListener('dblclick', (ev) => { ev.preventDefault(); editorContext.openInsetDialog?.(this.view, this.getPos()); });
  }

  private render() {
    const p = params(this.node);
    const file = p.get('filename') ?? '';
    const project = viewProject(this.view) || editorContext.project;
    const width = p.get('width');
    const scale = p.get('scale');
    const lyxscale = p.get('lyxscale');
    this.img.alt = file;
    this.img.title = `${file}\nwidth: ${width ?? 'auto'}${scale ? `, scale ${scale}%` : ''} — double-click to edit, right-click to export as PNG`;
    if (project && file) {
      const url = graphicsUrl(project, resolveDocPath(file, viewDocDir(this.view)), 1600);
      if (this.img.dataset.src !== url) { this.img.dataset.src = url; this.img.src = url; }
      this.img.style.display = '';
      this.caption.textContent = '';
    } else {
      this.img.removeAttribute('src');
      this.img.style.display = 'none';
      this.caption.textContent = file ? `[graphics: ${file}]` : '[graphics: no file]';
    }
    // approximate LyX sizing: width in col%/text% -> percentage of the editor width; scale -> relative
    let cssWidth = '';
    if (width) {
      const m = /^([\d.]+)\s*(col%|text%|page%|line%|cm|mm|in|pt|em|ex|px|%)$/.exec(width.trim());
      if (m) {
        const v = parseFloat(m[1]);
        if (m[2].endsWith('%')) cssWidth = `${v}%`;
        else if (m[2] === 'cm') cssWidth = `${v}cm`; else if (m[2] === 'mm') cssWidth = `${v}mm`; else if (m[2] === 'in') cssWidth = `${v}in`; else if (m[2] === 'pt') cssWidth = `${v}pt`; else cssWidth = `${v}${m[2]}`;
      }
    } else if (scale) {
      cssWidth = '';
      this.img.style.transform = '';
    }
    this.img.style.width = cssWidth;
    this.img.style.maxWidth = '100%';
    const shrink = lyxscale ? Math.max(10, Math.min(100, Number(lyxscale))) : 100;
    if (!cssWidth && scale) this.img.style.width = `${Math.min(100, Number(scale))}%`;
    this.dom.style.setProperty('--lyxscale', String(shrink / 100));
    const rot = p.get('rotateAngle');
    this.img.style.rotate = rot ? `${-Number(rot)}deg` : '';
    applyChangeAttrs(this.dom, this.node);
  }
  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }
  selectNode() { this.dom.classList.add('ProseMirror-selectednode'); }
  deselectNode() { this.dom.classList.remove('ProseMirror-selectednode'); }
  ignoreMutation() { return true; }
}

const REF_LABEL: Record<string, string> = { ref: 'Ref', eqref: 'EqRef', pageref: 'Page', vref: 'vRef', vpageref: 'vPage', prettyref: 'Formatted', formatted: 'Formatted', nameref: 'Name', labelonly: 'Label' };

export class CommandView implements NodeView {
  dom: HTMLElement;

  constructor(private node: PMNode, private view: EditorView, private getPos: () => number | undefined) {
    this.dom = document.createElement('span');
    this.dom.contentEditable = 'false';
    this.render();
    this.dom.addEventListener('dblclick', (ev) => {
      ev.preventDefault();
      // child documents open in a tab on double-click (editor.ts handleDoubleClickOn), not a dialog
      if (this.node.attrs.cmd === 'include') return;
      editorContext.openInsetDialog?.(this.view, this.getPos());
    });
  }

  private render() {
    const cmd = String(this.node.attrs.cmd);
    const p = params(this.node);
    const latexCmd = p.get('LatexCommand') ?? cmd;
    this.dom.className = `lyx-command lyx-command-${cmd}`;
    let text = '';
    let title = '';
    switch (cmd) {
      case 'label':
        text = unquote(p.get('name'));
        title = 'Label: ' + text + ' (double-click to edit)';
        this.dom.classList.add('lyx-button');
        break;
      case 'ref': {
        const target = unquote(p.get('reference'));
        text = `${REF_LABEL[latexCmd] ?? latexCmd}: ${target}`;
        title = `Cross-reference (${latexCmd}) to ${target}`;
        this.dom.classList.add('lyx-button');
        break;
      }
      case 'citation': {
        const keys = unquote(p.get('key')).split(',').map(k => k.trim()).filter(Boolean);
        const before = unquote(p.get('before')), after = unquote(p.get('after'));
        const bib = editorContext.meta?.bib;
        const labels = keys.map(k => {
          const e = bib?.find(b => b.key === k);
          return e ? `${e.author || k}${e.year ? ' ' + e.year : ''}` : k;
        });
        const ay = editorContext.meta?.citeEngineType === 'authoryear';
        text = ay ? `(${before ? before + ' ' : ''}${labels.join('; ')}${after ? ', ' + after : ''})` : `[${labels.join('; ')}${after ? ', ' + after : ''}]`;
        if (latexCmd === 'citet' || latexCmd === 'citealt') text = labels.join('; ') + (after ? ' (' + after + ')' : '');
        if (latexCmd === 'nocite') text = 'nocite: ' + keys.join(', ');
        title = `Citation (${latexCmd}): ${keys.join(', ')}`;
        this.dom.classList.add('lyx-cite');
        break;
      }
      case 'href': {
        const name = unquote(p.get('name')), target = unquote(p.get('target'));
        text = name || target;
        title = 'Hyperlink: ' + target;
        this.dom.classList.add('lyx-href');
        break;
      }
      case 'include': {
        const fn = unquote(p.get('filename'));
        text = `${latexCmd === 'input' ? 'Input' : latexCmd === 'include' ? 'Include' : latexCmd}: ${fn}`;
        title = 'Child document: ' + fn + ' (double-click to open)';
        this.dom.classList.add('lyx-button', 'lyx-include');
        break;
      }
      case 'bibtex': {
        const files = unquote(p.get('bibfiles'));
        text = `BibTeX Generated Bibliography (${files})`;
        this.dom.classList.add('lyx-button', 'lyx-block-button');
        break;
      }
      case 'toc':
        text = latexCmd === 'tableofcontents' ? 'Table of Contents' : latexCmd === 'listoffigures' ? 'List of Figures' : latexCmd === 'listoftables' ? 'List of Tables' : latexCmd;
        this.dom.classList.add('lyx-button', 'lyx-block-button');
        break;
      case 'index_print': text = 'Index'; this.dom.classList.add('lyx-button', 'lyx-block-button'); break;
      case 'nomenclature': text = 'Nom: ' + unquote(p.get('symbol')); this.dom.classList.add('lyx-button'); break;
      case 'nomencl_print': text = 'Nomenclature'; this.dom.classList.add('lyx-button', 'lyx-block-button'); break;
      case 'bibitem': text = '[' + (unquote(p.get('label')) || unquote(p.get('key'))) + '] '; this.dom.classList.add('lyx-bibitem'); break;
      case 'line': text = '———'; this.dom.classList.add('lyx-line'); break;
      default:
        text = cmd;
        this.dom.classList.add('lyx-button');
    }
    if (cmd === 'include' && (viewProject(this.view) || editorContext.project)) {
      const fn = unquote(p.get('filename'));
      const a = document.createElement('a');
      a.href = '#/' + (viewProject(this.view) || editorContext.project) + '/' + resolveDocPath(fn, viewDocDir(this.view));
      a.textContent = text;
      a.className = 'lyx-include-link';
      a.addEventListener('click', (ev) => { if (!ev.ctrlKey && !ev.metaKey && !ev.shiftKey) ev.preventDefault(); });
      this.dom.replaceChildren(a);
    } else this.dom.textContent = text;
    this.dom.title = title || cmd;
    applyChangeAttrs(this.dom, this.node);   // after the className reset above
  }
  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }
  selectNode() { this.dom.classList.add('ProseMirror-selectednode'); }
  deselectNode() { this.dom.classList.remove('ProseMirror-selectednode'); }
  ignoreMutation() { return true; }
}

/** Generic leaf (VSpace, Info, External, Separator, ...) rendered as a LyX button. */
export class LeafView implements NodeView {
  dom: HTMLElement;
  constructor(private node: PMNode, private view: EditorView, private getPos: () => number | undefined) {
    this.dom = document.createElement('span');
    this.dom.contentEditable = 'false';
    this.render();
    this.dom.addEventListener('dblclick', (ev) => { ev.preventDefault(); editorContext.openInsetDialog?.(this.view, this.getPos()); });
  }
  private render() {
    this.renderContent();
    applyChangeAttrs(this.dom, this.node);   // after the className reset in renderContent
  }
  private renderContent() {
    const name = String(this.node.attrs.name), arg = String(this.node.attrs.arg ?? '');
    this.dom.className = `lyx-leaf lyx-leaf-${name.toLowerCase()} lyx-button`;
    const p = params(this.node);
    let text = name + (arg ? ' ' + arg : '');
    if (name === 'VSpace') { this.renderVSpace(arg); return; }
    else if (name === 'Separator') { text = arg === 'plain' ? '' : '— separator —'; if (arg === 'plain') { this.dom.classList.remove('lyx-button'); this.dom.classList.add('lyx-separator-plain'); } }
    else if (name === 'Info') text = `Info: ${p.get('type') ?? ''} ${p.get('arg') ?? ''}`;
    else if (name === 'External') text = `External: ${unquote(p.get('filename'))}`;
    else if (name === 'line') text = 'Horizontal line';
    this.dom.textContent = text;
    this.dom.title = name + (arg ? ' ' + arg : '');
  }
  /** Vertical space the way LyX draws it: the actual gap, outward arrows joined by a line
   *  (flat bars for a fill, inward for negative space) and a small brown label. */
  private renderVSpace(arg: string) {
    const protect = arg.endsWith('*');
    const amount = protect ? arg.slice(0, -1) : arg;
    const gui: Record<string, string> = {
      defskip: 'Default skip', smallskip: 'Small skip', medskip: 'Medium skip', bigskip: 'Big skip',
      halfline: 'Half line height', fullline: 'Line height', vfill: 'Vertical fill',
    };
    const heights: Record<string, string> = {
      defskip: '6pt', smallskip: '3pt', medskip: '6pt', bigskip: '12pt',
      halfline: '0.6em', fullline: '1.2em', vfill: '12px',
    };
    const neg = amount.startsWith('-');
    const cssLen = /^-?[\d.]+(pt|mm|cm|in|px|em|ex)$/.test(amount) ? amount.replace(/^-/, '') : null;
    this.dom.className = `lyx-leaf lyx-leaf-vspace lyx-vspace${amount === 'vfill' ? ' fill' : ''}${neg ? ' neg' : ''}`;
    this.dom.style.height = heights[amount] ?? cssLen ?? '12px';
    const label = (gui[amount] ?? amount) + (protect ? ', protected' : '');
    this.dom.replaceChildren();
    const glyph = document.createElement('span'); glyph.className = 'vs-glyph';
    for (const cls of ['vs-a top', 'vs-line', 'vs-a bot']) { const i = document.createElement('i'); i.className = cls; glyph.appendChild(i); }
    const lab = document.createElement('span'); lab.className = 'vs-label'; lab.textContent = `Vertical space (${label})`;
    this.dom.append(glyph, lab);
    this.dom.title = `\\vspace${protect ? '*' : ''}{${amount}}`;
  }
  update(node: PMNode): boolean { if (node.type !== this.node.type) return false; this.node = node; this.render(); return true; }
  ignoreMutation() { return true; }
}

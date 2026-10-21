/**
 * A raw inset (ERT). In an HTML article (core html/article.ts) one alone in its paragraph is an HTML
 * block — an interactive figure, an SVG, a canvas with its script — and shows running, as the page
 * shows it: a sandboxed frame of the page in the runtime's embed mode (deliverable/runtime/embed.ts,
 * server deliverables.ts embedHtml), which hides all of the page but this block and tells the frame's
 * height. Its source stays the inset's text: the label opens it below the frame, and the frame
 * follows what is typed there (a moment after). Math in an article whose TeX the page does not have
 * (MathML another tool wrote) shows rendered — its MathML, cleaned to MathML alone — beside its
 * source. Everywhere else a raw inset is the usual box.
 */
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import { blockKey } from '@overlyx/core/html/article.ts';
import { InsetView } from './inset';
import { isArticleDoc } from '../../articlekinds';
import { api } from '../../api';
import { openProjectPath } from '../../openpath';

/** an article's page in the sandbox (/ol-d/<token>/…): its address for this account, while the token holds */
const links = new Map<string, Promise<{ url: string; expires: number }>>();
function pageUrl(docId: string): Promise<string> {
  const hit = links.get(docId);
  const fresh = (l: { expires: number }) => !l.expires || l.expires > Date.now();
  const make = () => {
    const slash = docId.indexOf('/', docId.indexOf('/') + 1);
    const project = docId.slice(0, slash), path = docId.slice(slash + 1);
    const p = api.deliverableLink(project, path).then(l => ({ url: l.base + l.entry.split('/').map(encodeURIComponent).join('/'), expires: l.expires }));
    links.set(docId, p);
    p.catch(() => links.delete(docId));
    return p;
  };
  return (hit ?? make()).then(l => (fresh(l) ? l.url : make().then(x => x.url)));
}

const MATHML_NS = 'http://www.w3.org/1998/Math/MathML';
const MATHML_TAGS = new Set(['math', 'semantics', 'mrow', 'mi', 'mn', 'mo', 'ms', 'mtext', 'mspace', 'msup', 'msub', 'msubsup', 'mfrac', 'msqrt', 'mroot', 'mover', 'munder', 'munderover', 'mtable', 'mtr', 'mtd', 'mstyle', 'mpadded', 'mphantom', 'menclose', 'mfenced', 'merror', 'mlabeledtr', 'mmultiscripts', 'mprescripts', 'none']);
const MATHML_ATTRS = new Set(['display', 'mathvariant', 'stretchy', 'fence', 'separator', 'lspace', 'rspace', 'accent', 'accentunder', 'columnalign', 'rowalign', 'columnspacing', 'rowspacing', 'displaystyle', 'scriptlevel', 'linethickness', 'width', 'height', 'depth', 'notation', 'largeop', 'movablelimits', 'symmetric', 'minsize', 'maxsize', 'form', 'columnlines', 'rowlines', 'frame', 'framespacing', 'align', 'bevelled', 'open', 'close', 'separators']);

/** the first <math> of some HTML as MathML alone: known elements, their presentation attributes, text (no links, no handlers) */
export function safeMathML(src: string): Element | null {
  const math = new DOMParser().parseFromString(src, 'text/html').querySelector('math');
  const clean = (el: Element): Element | null => {
    if (!MATHML_TAGS.has(el.localName)) return null;
    const out = document.createElementNS(MATHML_NS, el.localName);
    for (const a of Array.from(el.attributes)) if (MATHML_ATTRS.has(a.name)) out.setAttribute(a.name, a.value);
    for (const c of Array.from(el.childNodes)) {
      if (c.nodeType === Node.TEXT_NODE) out.append(c.textContent ?? '');
      else if (c.nodeType === Node.ELEMENT_NODE) { const k = clean(c as Element); if (k) out.append(k); }
    }
    return out;
  };
  return math ? clean(math) : null;
}

/** a block that shows nothing (scripts, styles, comments only): a chip, no frame */
const QUIET = /^(\s*(<(script|style|template|noscript)\b[\s\S]*?<\/\3\s*>|<(link|meta)\b[^>]*>|<!--[\s\S]*?-->))+\s*$/i;

export class HtmlBlockView extends InsetView {
  private wrap: HTMLElement | null = null;
  private rendered: HTMLElement | null = null;
  private renderedSrc = '';
  private frame: HTMLIFrameElement | null = null;
  private key = '';
  private loads = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private retries = 0;
  private readonly onMessage = (e: MessageEvent) => {
    if (!this.frame || e.source !== this.frame.contentWindow) return;
    const d = e.data as { ol?: string; height?: number; found?: boolean; path?: string } | null;
    // a link in the block to another file of the project: opened in OverLyX (runtime/links.ts)
    if (d?.ol === 'openPath' && typeof d.path === 'string') { const id = this.view.dom.dataset.docId ?? ''; const cut = id.indexOf('/', id.indexOf('/') + 1); if (cut > 0) openProjectPath(id.slice(0, cut), d.path); return; }
    if (d?.ol !== 'embedSize') return;
    // the server has not got the block's newest text yet: ask again in a moment
    if (!d.found && this.retries < 6) { this.retries++; clearTimeout(this.timer); this.timer = setTimeout(() => this.load(), 500 + 300 * this.retries); return; }
    this.frame.style.height = Math.max(8, Number(d.height) || 0) + 'px';
    this.dom.classList.toggle('ol-htmlblock-empty', !d.found);
  };

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined) {
    super(node, view, getPos);
    window.addEventListener('message', this.onMessage);
    this.sync();
    // (while the view is being built, neither its document nor the position are known yet)
    queueMicrotask(() => this.sync());
  }

  /** the block's source: the inset's lines, as they read with suggestions taken (core rawSource) */
  private source(): string {
    const lines: string[] = [];
    this.node.forEach(p => {
      let line = '';
      p.forEach(n => { if (n.isText && !n.marks.some(m => m.type.name === 'change' && m.attrs.type === 'deleted')) line += n.text; });
      lines.push(line);
    });
    return lines.join('\n');
  }

  /** an HTML block: a raw inset alone in a top-level paragraph of an article */
  private isBlock(): boolean {
    if (!isArticleDoc(this.view.dom.dataset.docId)) return false;
    const pos = this.getPos();
    if (pos === undefined) return false;
    try {
      const $p = this.view.state.doc.resolve(pos);
      if ($p.depth !== 1) return false;
      let others = false;
      $p.parent.forEach(n => { if (n !== this.node && !(n.isText && !n.text?.trim())) others = true; });
      return !others;
    } catch { return false; }
  }

  private sync(): void {
    // in an article raw text is HTML (not TeX)
    if (isArticleDoc(this.view.dom.dataset.docId)) { this.label.textContent = 'HTML'; this.label.title = 'HTML — click to show or hide its source, double-click for settings'; }
    const block = this.isBlock();
    this.syncMath(block);
    const src = block ? this.source() : '';
    const shown = block && !QUIET.test(src);
    this.dom.classList.toggle('ol-htmlblock', block);
    this.dom.classList.toggle('ol-htmlblock-quiet', block && !shown);
    if (!shown) { this.wrap?.remove(); this.wrap = null; this.frame = null; this.key = ''; return; }
    // a figure as wide as the page's wide ones (`class="… wide …"` on its first element)
    this.dom.classList.toggle('wide', /^\s*<[a-z][\w-]*\b[^>]*\bclass\s*=\s*["'][^"']*\bwide\b/i.test(src));
    if (!this.wrap) {
      this.wrap = document.createElement('span');
      this.wrap.className = 'ol-block-frame';
      this.wrap.contentEditable = 'false';
      this.frame = document.createElement('iframe');
      this.frame.setAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals');
      this.frame.setAttribute('loading', 'lazy');
      this.frame.title = 'HTML block, running as on the page';
      this.wrap.append(this.frame);
      this.contentDOM.before(this.wrap);
    }
    const key = blockKey(src);
    if (key === this.key) return;
    this.key = key;
    this.retries = 0;
    clearTimeout(this.timer);
    // the first time at once; while its source is typed, once the typing pauses (and the server has it)
    if (this.loads === 0) this.load(); else this.timer = setTimeout(() => this.load(), 700);
  }

  /** math the page has no TeX for, inline in an article: rendered beside its source (open) or alone (collapsed) */
  private syncMath(block: boolean): void {
    const src = !block && isArticleDoc(this.view.dom.dataset.docId) ? this.source() : '';
    const math = /<math\b/i.test(src) ? src : '';
    this.dom.classList.toggle('ol-rawmath', !!math);
    if (!math) { this.rendered?.remove(); this.rendered = null; this.renderedSrc = ''; return; }
    if (math === this.renderedSrc) return;
    this.renderedSrc = math;
    const el = safeMathML(math);
    if (!this.rendered) {
      this.rendered = document.createElement('span');
      this.rendered.className = 'ol-rawmath-shown';
      this.rendered.contentEditable = 'false';
      this.rendered.title = 'A formula as the page has it (MathML, no TeX) — click the label for its source';
      this.contentDOM.before(this.rendered);
    }
    this.rendered.replaceChildren(...(el ? [el] : []));
  }

  private load(): void {
    const docId = this.view.dom.dataset.docId, frame = this.frame, key = this.key;
    if (!docId || !frame) return;
    this.loads++;
    void pageUrl(docId).then(url => { if (this.frame === frame && this.key === key) frame.src = `${url}?ol=embed&b=${encodeURIComponent(key)}&n=${this.loads}`; }).catch(() => { this.dom.classList.add('ol-htmlblock-empty'); });
  }

  override update(node: PMNode): boolean {
    if (!super.update(node)) return false;
    this.sync();
    return true;
  }

  override stopEvent(ev: Event): boolean {
    return super.stopEvent(ev) || !!this.wrap?.contains(ev.target as Node);
  }

  destroy(): void {
    window.removeEventListener('message', this.onMessage);
    clearTimeout(this.timer);
  }
}

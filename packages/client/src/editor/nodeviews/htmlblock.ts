/**
 * A raw inset (ERT). In an HTML article (core html/article.ts) one alone in its paragraph is an HTML
 * block — an interactive figure, an SVG, a canvas with its script — and shows running, as the page
 * shows it: a sandboxed frame of the page in the runtime's embed mode (deliverable/runtime/embed.ts,
 * server deliverables.ts embedHtml), which hides all of the page but this block and tells the frame's
 * height. Its source stays the inset's text: the label opens it below the frame, and the frame
 * follows what is typed there (a moment after). Everywhere else a raw inset is the usual box.
 */
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import { blockKey } from '@overlyx/core/html/article.ts';
import { InsetView } from './inset';
import { isArticleDoc } from '../../articlekinds';
import { api } from '../../api';

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

/** a block that shows nothing (scripts, styles, comments only): a chip, no frame */
const QUIET = /^(\s*(<(script|style|template|noscript)\b[\s\S]*?<\/\3\s*>|<(link|meta)\b[^>]*>|<!--[\s\S]*?-->))+\s*$/i;

export class HtmlBlockView extends InsetView {
  private wrap: HTMLElement | null = null;
  private frame: HTMLIFrameElement | null = null;
  private key = '';
  private loads = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private retries = 0;
  private readonly onMessage = (e: MessageEvent) => {
    if (!this.frame || e.source !== this.frame.contentWindow) return;
    const d = e.data as { ol?: string; height?: number; found?: boolean } | null;
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

  /** the block's source: the inset's lines */
  private source(): string {
    const lines: string[] = [];
    this.node.forEach(p => lines.push(p.textContent));
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

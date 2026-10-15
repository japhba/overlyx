/** Export the layout canvas as a real SVG, keeping imported SVG artwork as vectors. */
import { isForeign } from './env';

const NS = 'http://www.w3.org/2000/svg';
const PAINT = ['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'color', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'dominant-baseline', 'visibility', 'opacity'] as const;
const number = (v: string, fallback = 0) => Number.parseFloat(v) || fallback;
const make = (tag: string, attrs: Record<string, string | number> = {}) => {
  const el = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  return el;
};

export function exportPageSvg(page: Element | null | undefined): string {
  if (!page) throw new Error('There is no drawing to export.');
  const style = getComputedStyle(page);
  const width = number(style.width, page.clientWidth || 800), height = number(style.height, page.clientHeight || 600);
  const out = make('svg', { width, height, viewBox: `0 0 ${width} ${height}` });
  if (style.backgroundColor && style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'transparent') out.append(make('rect', { width, height, fill: style.backgroundColor }));
  const copy = (el: Element): Element | null => {
    if (isForeign(el) || el.matches('script, style, link, meta, .notes, [data-ol-deleted]')) return null;
    const css = getComputedStyle(el);
    if (css.display === 'none') return null;
    const w = number(css.width, el.clientWidth), h = number(css.height, el.clientHeight);
    const x = (el as HTMLElement).offsetLeft ?? number(css.left), y = (el as HTMLElement).offsetTop ?? number(css.top);
    const group = make('g');
    const origin = css.transformOrigin.split(' ').map(v => number(v));
    group.setAttribute('transform', `translate(${x} ${y})${css.transform && css.transform !== 'none' ? ` translate(${origin[0] || 0} ${origin[1] || 0}) ${css.transform} translate(${-origin[0] || 0} ${-origin[1] || 0})` : ''}`);
    if (css.opacity !== '1') group.setAttribute('opacity', css.opacity);
    if (el.localName === 'svg') {
      const svg = el.cloneNode(true) as SVGSVGElement;
      const source = [el, ...el.querySelectorAll('*')], target = [svg, ...svg.querySelectorAll('*')];
      source.forEach((node, i) => {
        if (!target[i]) return;
        const paint = getComputedStyle(node);
        for (const key of PAINT) {
          // Keep authored url(#...) paints and filters; the computed form may
          // otherwise refer to this temporary canvas's URL.
          const value = paint.getPropertyValue(key).replace(/url\(["']?[^)#]*#([^)'" ]+)["']?\)/g, 'url(#$1)');
          if (value) (target[i] as SVGElement).style.setProperty(key, value);
        }
        for (const attr of Array.from(target[i].attributes)) if (attr.name.startsWith('data-ol-') || attr.name.startsWith('on')) target[i].removeAttributeNode(attr);
      });
      for (const node of Array.from(svg.querySelectorAll('script, [data-ol-runtime]'))) node.remove();
      for (const key of ['position', 'left', 'top', 'right', 'bottom', 'transform', 'transform-origin', 'width', 'height', 'max-width', 'opacity']) svg.style.removeProperty(key);
      svg.setAttribute('x', '0'); svg.setAttribute('y', '0'); svg.setAttribute('width', String(w)); svg.setAttribute('height', String(h));
      group.append(svg);
      return group;
    }
    if (el.localName === 'img') {
      group.append(make('image', { href: (el as HTMLImageElement).getAttribute('src') ?? '', width: w, height: h, preserveAspectRatio: 'xMidYMid meet' }));
      return group;
    }
    const background = css.backgroundColor;
    const border = number(css.borderTopWidth);
    if (background !== 'rgba(0, 0, 0, 0)' || border) {
      group.append(make('rect', { width: w, height: h, rx: number(css.borderTopLeftRadius), fill: background === 'rgba(0, 0, 0, 0)' ? 'none' : background, stroke: border ? css.borderTopColor : 'none', 'stroke-width': border }));
    }
    // The canvas's positioned groups contain objects; text boxes contain rich
    // text. Native SVG text keeps ordinary labels portable to TeX converters.
    if (el.hasAttribute('data-ol-group')) {
      for (const child of Array.from(el.children)) { const object = copy(child); if (object) group.append(object); }
    } else if (el.textContent?.trim()) {
      const size = number(css.fontSize, 16), lineHeight = number(css.lineHeight, size * 1.2);
      const text = make('text', { fill: css.color, 'font-family': css.fontFamily, 'font-size': size, 'font-weight': css.fontWeight, 'font-style': css.fontStyle });
      const label = el as HTMLElement;
      const lines = (label.innerText ?? label.textContent ?? '').split('\n');
      const align = css.textAlign;
      const px = number(css.paddingLeft), py = number(css.paddingTop);
      const anchor = align === 'center' ? w / 2 : align === 'right' || align === 'end' ? w - number(css.paddingRight) : px;
      text.setAttribute('text-anchor', align === 'center' ? 'middle' : align === 'right' || align === 'end' ? 'end' : 'start');
      lines.forEach((line, i) => { const span = make('tspan', { x: anchor, y: py + size + i * lineHeight }); span.textContent = line; text.append(span); });
      group.append(text);
    } else {
      for (const child of Array.from(el.children)) { const object = copy(child); if (object) group.append(object); }
    }
    return group;
  };
  for (const el of Array.from(page.children)) { const object = copy(el); if (object) out.append(object); }
  return new XMLSerializer().serializeToString(out);
}

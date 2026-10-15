import { inlineSvgHtml } from './sourceops';

export function svgCanvasSource(source: string): string {
  const svg = inlineSvgHtml(source, null, 'drawing', true);
  if (!svg) throw new Error('This file could not be opened as an SVG drawing.');
  const root = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
  const width = Math.max(8, Number.parseFloat(root.style.width) || 300);
  const height = Math.max(8, Number.parseFloat(root.style.height) || 150);
  const css = root.style;
  for (const [key, value] of Object.entries({ position: 'absolute', left: '0', top: '0', width: width + 'px', height: height + 'px', overflow: 'visible' })) css.setProperty(key, value);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="overlyx" content="poster"><style>html,body{margin:0}.slide{position:relative;width:${width}px;height:${height}px;overflow:hidden;background:transparent}*{box-sizing:border-box}</style></head><body><section class="slide" style="position:relative;width:${width}px;height:${height}px">${new XMLSerializer().serializeToString(root)}</section></body></html>`;
}

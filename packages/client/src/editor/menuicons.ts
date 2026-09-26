/**
 * Line icons for the right-click menus and the link box (24×24 grid, drawn with the text colour).
 * OverLyX's own drawings, kept as SVG path markup so that menus need no image requests.
 */
export const MENU_ICONS = {
  cut: '<circle cx="6" cy="18" r="2.6"/><circle cx="18" cy="18" r="2.6"/><path d="M8 16.2 17.5 3.5M16 16.2 6.5 3.5"/>',
  copy: '<rect x="8.5" y="8.5" width="11.5" height="11.5" rx="1.8"/><path d="M15.5 8.5V5.8A1.8 1.8 0 0 0 13.7 4H5.8A1.8 1.8 0 0 0 4 5.8v7.9a1.8 1.8 0 0 0 1.8 1.8h2.7"/>',
  paste: '<path d="M9 4.5H7A1.8 1.8 0 0 0 5.2 6.3v12.9A1.8 1.8 0 0 0 7 21h10a1.8 1.8 0 0 0 1.8-1.8V6.3A1.8 1.8 0 0 0 17 4.5h-2"/><rect x="9" y="3" width="6" height="3.2" rx="1"/>',
  pastePlain: '<path d="M9 4.5H7A1.8 1.8 0 0 0 5.2 6.3v12.9A1.8 1.8 0 0 0 7 21h10a1.8 1.8 0 0 0 1.8-1.8V6.3A1.8 1.8 0 0 0 17 4.5h-2"/><rect x="9" y="3" width="6" height="3.2" rx="1"/><path d="M9 11h6M9 14.5h6M9 18h3.5"/>',
  delete: '<path d="M4.5 7h15M10 11v6M14 11v6M6.5 7l.8 12.2A1.8 1.8 0 0 0 9.1 21h5.8a1.8 1.8 0 0 0 1.8-1.8L17.5 7M9.5 7V4.5h5V7"/>',
  comment: '<path d="M4 5.8A1.8 1.8 0 0 1 5.8 4h12.4A1.8 1.8 0 0 1 20 5.8v8.4a1.8 1.8 0 0 1-1.8 1.8H9l-5 4z"/><path d="M12 7.2v5.6M9.2 10h5.6"/>',
  link: '<path d="M10 14a4.2 4.2 0 0 0 6 0l3.2-3.2a4.2 4.2 0 0 0-6-6L12 6"/><path d="M14 10a4.2 4.2 0 0 0-6 0l-3.2 3.2a4.2 4.2 0 0 0 6 6L12 18"/>',
  unlink: '<path d="M16.5 12.8l2.7-2.7a4.2 4.2 0 0 0-6-6L12 5.4M7.5 11.2l-2.7 2.7a4.2 4.2 0 0 0 6 6l1.2-1.3M4 4l16 16"/>',
  open: '<path d="M14 4h6v6M20 4l-9 9M18.5 14v4.7a1.3 1.3 0 0 1-1.3 1.3H5.3A1.3 1.3 0 0 1 4 18.7V6.8a1.3 1.3 0 0 1 1.3-1.3H10"/>',
  edit: '<path d="M4 20h4L19.2 8.8a2 2 0 0 0 0-2.8l-1.2-1.2a2 2 0 0 0-2.8 0L4 16z"/><path d="M13.5 6.5l4 4"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.3 3.6 5.1 3.6 8.5s-1.2 6.2-3.6 8.5c-2.4-2.3-3.6-5.1-3.6-8.5S9.6 5.8 12 3.5z"/>',
  text: '<path d="M5 7V4.5h14V7M12 4.5v15M9 19.5h6"/>',
  ai: '<path d="M11 3.5l1.9 5.1L18 10.5l-5.1 1.9L11 17.5l-1.9-5.1L4 10.5l5.1-1.9z"/><path d="M18.5 14.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
  format: '<path d="M4 19 9 5h1.2l5 14M5.9 14h7.6"/><path d="M16.5 10.5h4M18.5 8.5v4"/>',
  clearFormat: '<path d="M7 4.5h12V7M13.5 4.5 10 19.5M7.5 19.5h5M4 4l16 16"/>',
  paragraph: '<path d="M13 4.5v15M17 4.5v15M19 4.5H9.8a4.3 4.3 0 0 0 0 8.6H13"/>',
  layout: '<path d="M4 6h16M4 10h10M4 14h16M4 18h10"/>',
  insert: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M12 8.5v7M8.5 12h7"/>',
  formula: '<path d="M18 5H6.5l6 7-6 7H18"/>',
  table: '<rect x="3.5" y="5" width="17" height="14" rx="1.5"/><path d="M3.5 9.7h17M3.5 14.3h17M9.2 5v14M14.8 5v14"/>',
  track: '<path d="M4 6.5h9M4 11h6M4 15.5h4"/><path d="M13 20l.8-3.4 5.4-5.4a1.7 1.7 0 0 1 2.4 2.4l-5.4 5.4z"/>',
  spell: '<path d="M3.5 15 7 5.5 10.5 15M4.7 12h4.6"/><path d="M12.5 16.5l3 3 5.5-6.5"/>',
  sections: '<path d="M5 6h14M8 12h11M8 18h11M5 11v8"/>',
  label: '<path d="M3.5 12V4.5a1 1 0 0 1 1-1H12l8.5 8.5-8.5 8.5z"/><circle cx="8" cy="8" r="1.5"/>',
  ref: '<path d="M4.5 12h14M13 6.5l5.5 5.5-5.5 5.5"/>',
  cite: '<path d="M6.5 7.5h4v4c0 3-1.7 5-4 6M13.5 7.5h4v4c0 3-1.7 5-4 6"/>',
  image: '<rect x="3.5" y="5" width="17" height="14" rx="1.5"/><circle cx="9" cy="10" r="1.6"/><path d="M4 17.5l5-4.5 3.5 3 3-2.5 4.5 4"/>',
  inset: '<rect x="3.5" y="6" width="17" height="12" rx="2"/><path d="M8 12h8"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2.3M12 18.2v2.3M3.5 12h2.3M18.2 12h2.3M6 6l1.6 1.6M16.4 16.4 18 18M6 18l1.6-1.6M16.4 7.6 18 6"/>',
} as const;

export type MenuIcon = keyof typeof MENU_ICONS;

/** An icon as an `<svg>` element (18 px unless the stylesheet sizes it). */
export function menuIcon(name: MenuIcon, cls = 'ctx-svg'): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', cls);
  svg.innerHTML = MENU_ICONS[name];
  return svg;
}

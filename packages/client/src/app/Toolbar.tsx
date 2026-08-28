/**
 * Toolbars (a port of LyX's lib/ui/stdtoolbars.inc): the Standard and Extra rows, and the
 * contextual Math / Table / Review rows. Buttons are plain, toggles (`active`) or palettes
 * (a popup grid of KaTeX-rendered symbols, LyX's "IconPalette" / "PopupMenu").
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import katex from 'katex';
import { createInsetMath, nargs, KATEX_BASE_MACROS } from '@overlyx/core';
import type { LayoutInfo } from '../api';
import { MATH_PANELS, type PanelItem } from './mathpanels';

export interface PaletteItem { label: string; html?: string; title?: string; action: () => void; active?: boolean }
export interface Palette {
  title: string;
  /** grid of items (LyX IconPalette) … */
  items?: PaletteItem[];
  cols?: number;
  /** … or a custom body (delimiter table, table size picker) */
  render?: (close: () => void) => ComponentChildren;
  /** list style (LyX PopupMenu: label next to the symbol) */
  list?: boolean;
}
export interface ToolButton {
  id: string; title: string;
  /** key into ICONS, or (when not found) the text shown on the button */
  icon: string;
  /** pre-rendered HTML (KaTeX) instead of an icon */
  html?: string;
  action?: () => void;
  active?: boolean; disabled?: boolean;
  kind?: 'text' | 'math';
  /** a popup palette instead of an action */
  palette?: Palette;
}
export interface ToolbarProps {
  id: string;
  groups: ToolButton[][];
  layouts?: LayoutInfo[];
  layout?: string;
  onLayout?: (name: string) => void;
  /** LyX-style label of a contextual toolbar (shown at the left) */
  label?: string;
}

export const ICONS: Record<string, string> = {
  new: '<svg viewBox="0 0 16 16"><path d="M3 1h7l3 3v11H3z" fill="none" stroke="currentColor"/><path d="M10 1v3h3" fill="none" stroke="currentColor"/></svg>',
  open: '<svg viewBox="0 0 16 16"><path d="M1 3h5l1 2h8v9H1z" fill="none" stroke="currentColor"/></svg>',
  save: '<svg viewBox="0 0 16 16"><path d="M2 2h10l2 2v10H2z" fill="none" stroke="currentColor"/><rect x="5" y="9" width="6" height="4" fill="currentColor"/></svg>',
  undo: '<svg viewBox="0 0 16 16"><path d="M6 4L2 8l4 4M2 8h7a4 4 0 010 8" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  redo: '<svg viewBox="0 0 16 16"><path d="M10 4l4 4-4 4M14 8H7a4 4 0 000 8" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  cut: '<svg viewBox="0 0 16 16"><circle cx="4.5" cy="12" r="2" fill="none" stroke="currentColor"/><circle cx="11.5" cy="12" r="2" fill="none" stroke="currentColor"/><path d="M6 10.5L12 2M10 10.5L4 2" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
  copy: '<svg viewBox="0 0 16 16"><rect x="5" y="5" width="9" height="10" fill="none" stroke="currentColor"/><path d="M3 11V1h8" fill="none" stroke="currentColor"/></svg>',
  paste: '<svg viewBox="0 0 16 16"><rect x="3" y="3" width="10" height="12" fill="none" stroke="currentColor"/><rect x="6" y="1.5" width="4" height="3" fill="#fff" stroke="currentColor"/><path d="M5.5 8h5M5.5 11h5" stroke="currentColor"/></svg>',
  find: '<svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.8"/></svg>',
  emph: '<svg viewBox="0 0 16 16"><text x="4" y="13" font-size="13" font-style="italic" font-family="serif">E</text></svg>',
  italic: '<svg viewBox="0 0 16 16"><text x="5" y="13" font-size="13" font-style="italic" font-family="serif">I</text></svg>',
  textcolor: '<svg viewBox="0 0 16 16"><text x="3" y="11" font-size="12" font-family="serif">A</text><rect x="2" y="12.5" width="12" height="2.5" fill="none" stroke="currentColor" stroke-width="0.8"/></svg>',
  noun: '<svg viewBox="0 0 16 16"><text x="2" y="13" font-size="11" font-family="serif" font-variant="small-caps">Nn</text></svg>',
  bold: '<svg viewBox="0 0 16 16"><text x="3" y="13" font-size="13" font-weight="bold" font-family="serif">B</text></svg>',
  underline: '<svg viewBox="0 0 16 16"><text x="4" y="12" font-size="12" font-family="serif" text-decoration="underline">U</text></svg>',
  strike: '<svg viewBox="0 0 16 16"><text x="3" y="12" font-size="12" font-family="serif" text-decoration="line-through">S</text></svg>',
  tt: '<svg viewBox="0 0 16 16"><text x="2" y="12" font-size="11" font-family="monospace">tt</text></svg>',
  textstyle: '<svg viewBox="0 0 16 16"><text x="1" y="13" font-size="13" font-family="serif">A</text><text x="9" y="13" font-size="9" font-family="serif" font-style="italic">a</text></svg>',
  math: '<svg viewBox="0 0 16 16"><text x="2" y="13" font-size="13" font-style="italic" font-family="serif">∑</text></svg>',
  dmath: '<svg viewBox="0 0 16 16"><text x="1" y="12" font-size="9" font-family="serif">∫dx</text></svg>',
  graphics: '<svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" fill="none" stroke="currentColor"/><path d="M3 12l3-4 3 3 2-2 3 3" fill="none" stroke="currentColor"/><circle cx="11" cy="6" r="1.2" fill="currentColor"/></svg>',
  table: '<svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" fill="none" stroke="currentColor"/><path d="M1.5 6.5h13M1.5 10h13M6 2.5v11M10.5 2.5v11" stroke="currentColor"/></svg>',
  float: '<svg viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="9" fill="none" stroke="currentColor"/><path d="M4 13.5h8" stroke="currentColor"/></svg>',
  tablefloat: '<svg viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="8" fill="none" stroke="currentColor"/><path d="M2 5.5h12M6 2v8M10 2v8M4 13.5h8" stroke="currentColor"/></svg>',
  footnote: '<svg viewBox="0 0 16 16"><text x="2" y="12" font-size="10" font-family="serif">A</text><text x="9" y="8" font-size="7" font-family="serif">1</text></svg>',
  note: '<svg viewBox="0 0 16 16"><path d="M2 2h12v9l-3 3H2z" fill="#fff3a0" stroke="#b09a20"/><path d="M11 14v-3h3" fill="none" stroke="#b09a20"/></svg>',
  comment: '<svg viewBox="0 0 16 16"><path d="M2 2h12v8H7l-3 3v-3H2z" fill="#dbe9ff" stroke="#4c7bb8"/></svg>',
  label: '<svg viewBox="0 0 16 16"><path d="M2 2h6l6 6-6 6-6-6z" fill="none" stroke="currentColor"/><circle cx="5" cy="5" r="1" fill="currentColor"/></svg>',
  ref: '<svg viewBox="0 0 16 16"><path d="M3 8h9M9 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  cite: '<svg viewBox="0 0 16 16"><text x="2" y="12" font-size="10" font-family="serif">[1]</text></svg>',
  index: '<svg viewBox="0 0 16 16"><text x="1" y="12" font-size="9" font-family="serif" font-weight="bold">Idx</text></svg>',
  nomencl: '<svg viewBox="0 0 16 16"><text x="1" y="12" font-size="9" font-family="serif" font-weight="bold">Nom</text></svg>',
  ert: '<svg viewBox="0 0 16 16"><text x="1" y="12" font-size="9" font-family="serif" font-style="italic">TeX</text></svg>',
  href: '<svg viewBox="0 0 16 16"><path d="M6.5 9.5l3-3M5 11a2.5 2.5 0 01-3.5-3.5l2-2M11 5a2.5 2.5 0 013.5 3.5l-2 2" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
  depthin: '<svg viewBox="0 0 16 16"><path d="M2 3h12M6 7h8M6 10h8M2 13h12M2 6l2 2.5L2 11" fill="none" stroke="currentColor"/></svg>',
  depthout: '<svg viewBox="0 0 16 16"><path d="M2 3h12M6 7h8M6 10h8M2 13h12M4 6L2 8.5 4 11" fill="none" stroke="currentColor"/></svg>',
  pdf: '<svg viewBox="0 0 16 16"><path d="M3 1h7l3 3v11H3z" fill="none" stroke="currentColor"/><text x="4" y="12" font-size="5" font-family="sans-serif" font-weight="bold">PDF</text></svg>',
  pdfmaster: '<svg viewBox="0 0 16 16"><path d="M1 3h6l2 2v9H1z" fill="none" stroke="currentColor"/><path d="M7 1h6l2 2v9H9" fill="none" stroke="currentColor"/><text x="2" y="12" font-size="4.5" font-family="sans-serif" font-weight="bold">PDF</text></svg>',
  track: '<svg viewBox="0 0 16 16"><path d="M2 12l8-8 2 2-8 8H2z" fill="none" stroke="currentColor"/></svg>',
  margin: '<svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="8" height="11" fill="none" stroke="currentColor"/><rect x="11" y="4" width="3.5" height="3" fill="currentColor"/></svg>',
  marginal: '<svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="8" height="11" fill="none" stroke="currentColor"/><path d="M11 5h3.5M11 7h3.5M11 9h3.5" stroke="currentColor"/></svg>',
  outline: '<svg viewBox="0 0 16 16"><path d="M2 3h12M4 7h10M6 11h8" stroke="currentColor" stroke-width="1.5"/></svg>',
  box: '<svg viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="10" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  toggleinset: '<svg viewBox="0 0 16 16"><rect x="2" y="4" width="12" height="8" rx="2" fill="none" stroke="currentColor"/><path d="M5 8h6" stroke="currentColor"/></svg>',
  include: '<svg viewBox="0 0 16 16"><path d="M2 2h6l2 2v10H2z" fill="none" stroke="currentColor"/><path d="M8 8h6M12 6l2 2-2 2" fill="none" stroke="currentColor"/></svg>',
  macro: '<svg viewBox="0 0 16 16"><text x="1" y="12" font-size="9" font-family="serif" font-style="italic">\\f</text><text x="9" y="12" font-size="9" font-family="serif">≔</text></svg>',
  paragraph: '<svg viewBox="0 0 16 16"><text x="3" y="13" font-size="13" font-family="serif">¶</text></svg>',
  enumerate: '<svg viewBox="0 0 16 16"><text x="1" y="6" font-size="5" font-family="sans-serif">1.</text><text x="1" y="11" font-size="5" font-family="sans-serif">2.</text><text x="1" y="16" font-size="5" font-family="sans-serif">3.</text><path d="M6 4h9M6 9h9M6 14h9" stroke="currentColor"/></svg>',
  itemize: '<svg viewBox="0 0 16 16"><circle cx="3" cy="4" r="1.3" fill="currentColor"/><circle cx="3" cy="9" r="1.3" fill="currentColor"/><circle cx="3" cy="14" r="1.3" fill="currentColor"/><path d="M6 4h9M6 9h9M6 14h9" stroke="currentColor"/></svg>',
  labeling: '<svg viewBox="0 0 16 16"><path d="M1 4h4M1 9h4M1 14h4" stroke="currentColor" stroke-width="1.5"/><path d="M7 4h8M7 9h8M7 14h8" stroke="currentColor"/></svg>',
  description: '<svg viewBox="0 0 16 16"><path d="M1 4h5M1 9h5M1 14h5" stroke="currentColor" stroke-width="2"/><path d="M8 4h7M8 9h7M8 14h7" stroke="currentColor"/></svg>',
  section: '<svg viewBox="0 0 16 16"><text x="2" y="12" font-size="11" font-family="serif" font-weight="bold">§</text></svg>',
  standard: '<svg viewBox="0 0 16 16"><path d="M2 4h12M2 7h12M2 10h12M2 13h7" stroke="currentColor"/></svg>',
  changenext: '<svg viewBox="0 0 16 16"><path d="M2 12l6-6 2 2-6 6H2z" fill="none" stroke="currentColor"/><path d="M10 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  changeprev: '<svg viewBox="0 0 16 16"><path d="M8 12l6-6-2-2-6 6v2z" fill="none" stroke="currentColor"/><path d="M6 4L2 8l4 4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  accept: '<svg viewBox="0 0 16 16"><path d="M2.5 8.5l3.5 3.5 7.5-8" fill="none" stroke="#2a8a2a" stroke-width="2"/></svg>',
  reject: '<svg viewBox="0 0 16 16"><path d="M3 3l10 10M13 3L3 13" stroke="#b02020" stroke-width="2"/></svg>',
  acceptall: '<svg viewBox="0 0 16 16"><path d="M1 8l3 3 5-6" fill="none" stroke="#2a8a2a" stroke-width="1.8"/><path d="M7 8l3 3 5-6" fill="none" stroke="#2a8a2a" stroke-width="1.8"/></svg>',
  rejectall: '<svg viewBox="0 0 16 16"><path d="M2 3l6 6M8 3L2 9" stroke="#b02020" stroke-width="1.6"/><path d="M8 7l6 6M14 7l-6 6" stroke="#b02020" stroke-width="1.6"/></svg>',
  changesoutput: '<svg viewBox="0 0 16 16"><path d="M3 1h7l3 3v11H3z" fill="none" stroke="currentColor"/><path d="M5 7h6M5 10h6" stroke="#b02020"/><path d="M5 12.5h4" stroke="#2a8a2a"/></svg>',
  mathtb: '<svg viewBox="0 0 16 16"><text x="1" y="13" font-size="12" font-family="serif" font-style="italic">√x</text></svg>',
  tabletb: '<svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" fill="none" stroke="currentColor"/><path d="M1.5 6.5h13M6 2.5v11" stroke="currentColor"/></svg>',
  reviewtb: '<svg viewBox="0 0 16 16"><path d="M2 12l8-8 2 2-8 8H2z" fill="none" stroke="currentColor"/><path d="M9 13l2 2 3-4" fill="none" stroke="#2a8a2a" stroke-width="1.5"/></svg>',
  // table toolbar
  addrow: '<svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="7" fill="none" stroke="currentColor"/><path d="M1.5 6h13M6 2.5v7M10.5 2.5v7" stroke="currentColor"/><path d="M8 11v4M6 13h4" stroke="#2a8a2a" stroke-width="1.6"/></svg>',
  addcol: '<svg viewBox="0 0 16 16"><rect x="1.5" y="1.5" width="7" height="13" fill="none" stroke="currentColor"/><path d="M5 1.5v13M1.5 6h7M1.5 10.5h7" stroke="currentColor"/><path d="M12.5 6v4M10.5 8h4" stroke="#2a8a2a" stroke-width="1.6"/></svg>',
  delrow: '<svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="7" fill="none" stroke="currentColor"/><path d="M1.5 6h13M6 2.5v7M10.5 2.5v7" stroke="currentColor"/><path d="M6 13h4" stroke="#b02020" stroke-width="1.6"/></svg>',
  delcol: '<svg viewBox="0 0 16 16"><rect x="1.5" y="1.5" width="7" height="13" fill="none" stroke="currentColor"/><path d="M5 1.5v13M1.5 6h7M1.5 10.5h7" stroke="currentColor"/><path d="M10.5 8h4" stroke="#b02020" stroke-width="1.6"/></svg>',
  rowup: '<svg viewBox="0 0 16 16"><rect x="1.5" y="6.5" width="13" height="7" fill="none" stroke="currentColor"/><path d="M1.5 10h13" stroke="currentColor"/><path d="M8 5V1M5.5 3.5L8 1l2.5 2.5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  rowdown: '<svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="7" fill="none" stroke="currentColor"/><path d="M1.5 6h13" stroke="currentColor"/><path d="M8 11v4M5.5 12.5L8 15l2.5-2.5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  colleft: '<svg viewBox="0 0 16 16"><rect x="6.5" y="1.5" width="8" height="13" fill="none" stroke="currentColor"/><path d="M10.5 1.5v13" stroke="currentColor"/><path d="M5 8H1M3.5 5.5L1 8l2.5 2.5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  colright: '<svg viewBox="0 0 16 16"><rect x="1.5" y="1.5" width="8" height="13" fill="none" stroke="currentColor"/><path d="M5.5 1.5v13" stroke="currentColor"/><path d="M11 8h4M12.5 5.5L15 8l-2.5 2.5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  linetop: '<svg viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="10" fill="none" stroke="#bbb"/><path d="M2 3h12" stroke="currentColor" stroke-width="2.2"/></svg>',
  linebottom: '<svg viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="10" fill="none" stroke="#bbb"/><path d="M2 13h12" stroke="currentColor" stroke-width="2.2"/></svg>',
  lineleft: '<svg viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="10" fill="none" stroke="#bbb"/><path d="M2 3v10" stroke="currentColor" stroke-width="2.2"/></svg>',
  lineright: '<svg viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="10" fill="none" stroke="#bbb"/><path d="M14 3v10" stroke="currentColor" stroke-width="2.2"/></svg>',
  lineborder: '<svg viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="10" fill="none" stroke="currentColor" stroke-width="2"/><path d="M2 8h12M8 3v10" stroke="#bbb"/></svg>',
  lineinner: '<svg viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="10" fill="none" stroke="#bbb"/><path d="M2 8h12M8 3v10" stroke="currentColor" stroke-width="2"/></svg>',
  lineall: '<svg viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="10" fill="none" stroke="currentColor" stroke-width="2"/><path d="M2 8h12M8 3v10" stroke="currentColor" stroke-width="2"/></svg>',
  linenone: '<svg viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="10" fill="none" stroke="#bbb" stroke-dasharray="2 2"/><path d="M2 8h12M8 3v10" stroke="#bbb" stroke-dasharray="2 2"/></svg>',
  lineformal: '<svg viewBox="0 0 16 16"><path d="M2 3h12M2 6.5h12M2 13h12" stroke="currentColor" stroke-width="1.6"/><path d="M4 9.5h8" stroke="#bbb"/></svg>',
  alignleft: '<svg viewBox="0 0 16 16"><path d="M2 3h12M2 6h8M2 9h12M2 12h8" stroke="currentColor" stroke-width="1.5"/></svg>',
  aligncenter: '<svg viewBox="0 0 16 16"><path d="M2 3h12M4 6h8M2 9h12M4 12h8" stroke="currentColor" stroke-width="1.5"/></svg>',
  alignright: '<svg viewBox="0 0 16 16"><path d="M2 3h12M6 6h8M2 9h12M6 12h8" stroke="currentColor" stroke-width="1.5"/></svg>',
  aligndecimal: '<svg viewBox="0 0 16 16"><text x="1" y="12" font-size="9" font-family="sans-serif">1.5</text><path d="M8 3v11" stroke="currentColor" stroke-dasharray="2 1"/></svg>',
  valigntop: '<svg viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="12" fill="none" stroke="#bbb"/><path d="M4 4.5h8M4 7h5" stroke="currentColor" stroke-width="1.5"/></svg>',
  valignmiddle: '<svg viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="12" fill="none" stroke="#bbb"/><path d="M4 7h8M4 9.5h5" stroke="currentColor" stroke-width="1.5"/></svg>',
  valignbottom: '<svg viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="12" fill="none" stroke="#bbb"/><path d="M4 9.5h8M4 12h5" stroke="currentColor" stroke-width="1.5"/></svg>',
  rotatecell: '<svg viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="12" fill="none" stroke="#bbb"/><text x="9" y="13" font-size="9" font-family="serif" transform="rotate(-90 9 9)">ab</text></svg>',
  rotatetable: '<svg viewBox="0 0 16 16"><rect x="3" y="2" width="10" height="12" fill="none" stroke="currentColor"/><path d="M3 6h10M3 10h10" stroke="currentColor"/><path d="M14 1a4 4 0 010 5" fill="none" stroke="currentColor"/></svg>',
  multicolumn: '<svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" fill="none" stroke="currentColor"/><path d="M1.5 8h13M6 8v5.5M10.5 8v5.5" stroke="currentColor"/><path d="M4 5.5h8M10 4l2 1.5-2 1.5" fill="none" stroke="currentColor"/></svg>',
  multirow: '<svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" fill="none" stroke="currentColor"/><path d="M8 2.5v11M8 6h6.5M8 10h6.5" stroke="currentColor"/><path d="M4.5 4v8M3 10l1.5 2 1.5-2" fill="none" stroke="currentColor"/></svg>',
  tablesettings: '<svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" fill="none" stroke="currentColor"/><path d="M1.5 6.5h13M6 2.5v11" stroke="currentColor"/><circle cx="11" cy="10.5" r="2.2" fill="#fff" stroke="currentColor"/></svg>',
  // math toolbar
  display: '<svg viewBox="0 0 16 16"><path d="M1 3h5M1 13h5M10 3h5M10 13h5" stroke="#bbb"/><text x="4" y="12" font-size="11" font-family="serif" font-style="italic">∑</text></svg>',
  sub: '<svg viewBox="0 0 16 16"><text x="2" y="11" font-size="11" font-family="serif" font-style="italic">x</text><text x="9" y="14" font-size="7" font-family="serif" font-style="italic">n</text></svg>',
  sup: '<svg viewBox="0 0 16 16"><text x="2" y="13" font-size="11" font-family="serif" font-style="italic">x</text><text x="9" y="7" font-size="7" font-family="serif" font-style="italic">n</text></svg>',
  delim: '<svg viewBox="0 0 16 16"><text x="1" y="13" font-size="13" font-family="serif">(</text><text x="5.5" y="12" font-size="8" font-family="serif" font-style="italic">x</text><text x="11" y="13" font-size="13" font-family="serif">)</text></svg>',
  delimsize: '<svg viewBox="0 0 16 16"><text x="0" y="14" font-size="15" font-family="serif">(</text><text x="5" y="13" font-size="12" font-family="serif">(</text><text x="9" y="12" font-size="9" font-family="serif">(</text><text x="12.5" y="11" font-size="6" font-family="serif">(</text></svg>',
};

/* ------------------------------------------------------------------ KaTeX previews */

const PREVIEW_MACROS: Record<string, string> = {
  ...KATEX_BASE_MACROS,
  '\\llangle': '\\langle\\mkern-4.5mu\\langle', '\\rrangle': '\\rangle\\mkern-4.5mu\\rangle',
  '\\llbracket': '[\\mkern-3mu[', '\\rrbracket': ']\\mkern-3mu]',
  '\\root': '\\sqrt[n]{a}', '\\cases': '\\begin{cases}a\\\\b\\end{cases}',
  '\\smasht': '\\smash{a}', '\\smashb': '\\smash{a}', '\\mathds': '\\mathbb', '\\utilde': '\\underset{\\sim}',
  '\\unitone': '\\mathrm{km}', '\\unittwo': '864\\,\\mathrm{m}', '\\unitfrac': '{}^{\\mathrm{km}}\\!/\\!{}_{\\mathrm{h}}', '\\unitfracthree': '20\\,{}^{\\mathrm{km}}\\!/\\!{}_{\\mathrm{h}}',
  '\\nicefrac': '{}^{3}\\!/\\!{}_{4}', '\\cfracleft': '\\cfrac{a}{b}', '\\cfracright': '\\cfrac{a}{b}',
  '\\sideset': '{}_a^b\\!\\sum\\!{}_c^d', '\\sidesetr': '\\sum{}_c^d', '\\sidesetl': '{}_a^b\\!\\sum', '\\sidesetn': '\\sum',
  '\\stackrelthree': '\\overset{a}{\\underset{c}{=}}', '\\iddots': '\\cdot^{\\cdot^{\\cdot}}', '\\ddddot': '\\overset{\\cdots\\!\\cdot}{a}',
  '\\mathcircumflex': '\\hat{}', '\\textdegree': '{}^{\\circ}', '\\mathdollar': '\\$', '\\mathparagraph': '\\P', '\\mathsection': '\\S',
  '\\brokenvert': '\\vert', '\\wasylozenge': '\\lozenge', '\\varangle': '\\measuredangle', '\\Square': '\\square', '\\CheckedBox': '\\boxed{\\checkmark}', '\\XBox': '\\boxed{\\times}',
  '\\lhook': '\\hookleftarrow', '\\rhook': '\\hookrightarrow', '\\Join': '\\bowtie',
};

/** Explicit preview sources for commands whose arity KaTeX or our parser does not know. */
const PREVIEW_SRC: Record<string, string> = {
  cfrac: '\\cfrac{a}{b}', cancelto: '\\cancelto{0}{ab}', utilde: '\\underset{\\sim}{a}', dddot: '\\dddot{a}', ddddot: '\\overset{\\cdots\\!\\cdot}{a}',
  overset: '\\overset{a}{x}', underset: '\\underset{a}{x}', stackrel: '\\stackrel{a}{=}', binom: '\\binom{n}{k}', tbinom: '\\tbinom{n}{k}', dbinom: '\\dbinom{n}{k}',
  tfrac: '\\tfrac{a}{b}', dfrac: '\\dfrac{a}{b}', phantom: '\\phantom{a}b', hphantom: '\\hphantom{a}b', vphantom: '\\vphantom{a}b', smash: '\\smash{a}',
  mathllap: '\\mathllap{a}', mathclap: '\\mathclap{a}', mathrlap: '\\mathrlap{a}', mathrel: '\\mathrel{R}', mathbin: '\\mathbin{\\ast}', mathop: '\\mathop{op}', mathord: '\\mathord{o}',
  displaystyle: '\\displaystyle\\sum_i', textstyle: '\\textstyle\\sum_i', scriptstyle: '\\scriptstyle\\sum_i', scriptscriptstyle: '\\scriptscriptstyle\\sum_i',
};

/** Arity-aware sample arguments for a math command (so \frac shows as a/b, accents over a letter). */
function previewSource(latex: string): string {
  const m = /^\\([A-Za-z]+\*?)(\s+.*)?$/.exec(latex);
  if (!m) return latex;
  const name = m[1];
  if (PREVIEW_SRC[name]) return PREVIEW_SRC[name];
  if (m[2]) {   // "\mathrm T", "\textrm \AA"
    const arg = m[2].trim();
    return `\\${name}{${arg}}`;
  }
  if (PREVIEW_MACROS['\\' + name] !== undefined && !(name in KATEX_BASE_MACROS)) return latex;
  let n = 0;
  try { n = nargs(createInsetMath(name, {})); } catch { n = 0; }
  if (n === 0) return latex;
  const args = ['a', 'b', 'c', 'd'].slice(0, n);
  if (/^(over|under)(brace|line|leftarrow|rightarrow|leftrightarrow)$/.test(name) || /cancel/.test(name)) return `\\${name}{ab}`;
  return `\\${name}` + args.map(a => `{${a}}`).join('');
}

const previewCache = new Map<string, string | null>();
/** KaTeX HTML for a symbol / command, or null when KaTeX cannot render it (the label is shown instead). */
export function mathPreview(latex: string): string | null {
  const cached = previewCache.get(latex);
  if (cached !== undefined) return cached;
  let html: string | null = null;
  try {
    const src = previewSource(latex);
    html = katex.renderToString(src, { throwOnError: false, strict: false, trust: true, output: 'html', macros: { ...PREVIEW_MACROS } });
    if (html.includes('katex-error') || html.includes('mord text') && /\\[A-Za-z]/.test(src) && !src.startsWith('\\text')) html = null;
  } catch { html = null; }
  previewCache.set(latex, html);
  return html;
}

/* ------------------------------------------------------------------ delimiters */

export interface DelimPair { label: string; left: string; right: string; title: string }
/** Delimiter pairs offered by the palette (LyX's Math Delimiters dialog list + ⟪ ⟫). Names as in LaTeX. */
export const DELIM_PAIRS: DelimPair[] = [
  { label: '( )', left: '(', right: ')', title: 'Parentheses' },
  { label: '[ ]', left: '[', right: ']', title: 'Brackets' },
  { label: '{ }', left: '\\{', right: '\\}', title: 'Braces' },
  { label: '| |', left: '|', right: '|', title: 'Vertical bars (absolute value)' },
  { label: '‖ ‖', left: '\\Vert', right: '\\Vert', title: 'Double vertical bars (norm)' },
  { label: '⟨ ⟩', left: '\\langle', right: '\\rangle', title: 'Angle brackets' },
  { label: '⟪ ⟫', left: '\\llangle', right: '\\rrangle', title: 'Double angle brackets (OverLyX adds the \\llangle macro to the preamble)' },
  { label: '⌊ ⌋', left: '\\lfloor', right: '\\rfloor', title: 'Floor' },
  { label: '⌈ ⌉', left: '\\lceil', right: '\\rceil', title: 'Ceiling' },
  { label: '⟦ ⟧', left: '\\llbracket', right: '\\rrbracket', title: 'Double brackets (stmaryrd)' },
  { label: '/ \\', left: '/', right: '\\backslash', title: 'Slashes' },
  { label: '↑ ↑', left: '\\uparrow', right: '\\uparrow', title: 'Up arrows' },
  { label: '↓ ↓', left: '\\downarrow', right: '\\downarrow', title: 'Down arrows' },
  { label: '↕ ↕', left: '\\updownarrow', right: '\\updownarrow', title: 'Up-down arrows' },
  { label: '⇑ ⇑', left: '\\Uparrow', right: '\\Uparrow', title: 'Double up arrows' },
  { label: '⇓ ⇓', left: '\\Downarrow', right: '\\Downarrow', title: 'Double down arrows' },
  { label: '⇕ ⇕', left: '\\Updownarrow', right: '\\Updownarrow', title: 'Double up-down arrows' },
];
/** Sizes: '' = variable (\left … \right), 'none' = plain symbols, else \bigl … \bigr etc. */
export const DELIM_SIZES: { id: string; label: string; title: string }[] = [
  { id: '', label: 'auto', title: 'Variable size: \\left … \\right (adapts to the content)' },
  { id: 'none', label: 'plain', title: 'Plain symbols (no scaling)' },
  { id: 'big', label: 'big', title: '\\bigl … \\bigr' },
  { id: 'Big', label: 'Big', title: '\\Bigl … \\Bigr' },
  { id: 'bigg', label: 'bigg', title: '\\biggl … \\biggr' },
  { id: 'Bigg', label: 'Bigg', title: '\\Biggl … \\Biggr' },
];

export interface DelimChoice { pair: DelimPair; size: string }

function delimPreview(pair: DelimPair, size: string): string {
  const inner = '\\square';
  // KaTeX has no double delimiters: build ⟪ ⟫ / ⟦ ⟧ from two glyphs of the same size
  const two = (name: string): [string, string] | null =>
    name === '\\llangle' ? ['\\langle', '4.5mu'] : name === '\\rrangle' ? ['\\rangle', '4.5mu'] : name === '\\llbracket' ? ['[', '3mu'] : name === '\\rrbracket' ? [']', '3mu'] : null;
  const wrap = (cmd: string, name: string): string => {
    const t = two(name);
    if (!t) return cmd + name;
    return `${cmd}${t[0]}\\mkern-${t[1]}${cmd}${t[0]}`;   // with \left/\right this nests two balanced pairs
  };
  const lcmd = size === '' ? '\\left' : size === 'none' ? '' : `\\${size}l`;
  const rcmd = size === '' ? '\\right' : size === 'none' ? '' : `\\${size}r`;
  const src = wrap(lcmd, pair.left) + inner + wrap(rcmd, pair.right);
  try { return katex.renderToString(src, { throwOnError: false, strict: false, output: 'html' }); } catch { return pair.label; }
}

/** The delimiter palette: pairs × sizes (LyX's "braces of varying sizes"). */
export function DelimPalette({ onPick, onDialog, close }: { onPick: (c: DelimChoice) => void; onDialog?: () => void; close: () => void }) {
  const cells = useMemo(() => DELIM_PAIRS.map(p => DELIM_SIZES.map(s => delimPreview(p, s.id))), []);
  return (
    <div class="tb-delims" onMouseDown={e => e.preventDefault()}>
      <table>
        <thead><tr><th /> {DELIM_SIZES.map(s => <th key={s.id} title={s.title}>{s.label}</th>)}</tr></thead>
        <tbody>
          {DELIM_PAIRS.map((p, i) => (
            <tr key={p.label}>
              <th title={p.title}>{p.label}</th>
              {DELIM_SIZES.map((s, j) => (
                <td key={s.id}><button type="button" class="tb-delim" title={`${p.title}, ${s.title}`} data-delim={`${p.left.replace(/^\\/, '')}|${s.id || 'auto'}`} onClick={() => { close(); onPick({ pair: p, size: s.id }); }} dangerouslySetInnerHTML={{ __html: cells[i][j] }} /></td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div class="tb-delims-foot">
        <span>Selected text is placed between the delimiters.</span>
        {onDialog && <button type="button" class="small-btn" onClick={() => { close(); onDialog(); }}>Mixed pairs / one-sided…</button>}
      </div>
    </div>
  );
}

/** LaTeX for a delimiter choice as LyX writes it; `#0` marks where the cursor (or the selection) goes. */
export function delimLatex(c: DelimChoice): string {
  const { pair, size } = c;
  if (size === '') return `\\left${pair.left} #0 \\right${pair.right}`;
  if (size === 'none') return `${pair.left} #0 ${pair.right}`;
  return `\\${size}l${pair.left} #0 \\${size}r${pair.right}`;
}

/* ------------------------------------------------------------------ math panels */

/** LyX's math panel palettes (Greek, arrows, relations, …) as toolbar palettes. */
export function mathPanelPalettes(insert: (item: PanelItem) => void): { id: string; title: string; palette: Palette }[] {
  return MATH_PANELS.map(p => ({
    id: p.id, title: p.title,
    palette: {
      title: p.title,
      list: ['functions', 'space', 'style', 'frac-square', 'font', 'sqrt-square'].includes(p.id),
      cols: p.id === 'functions' ? 6 : 8,
      items: p.items.map(it => ({ label: it.label, title: it.latex, html: mathPreview(it.latex) ?? undefined, action: () => insert(it) })),
    },
  }));
}

/* ------------------------------------------------------------------ table size picker */

export function TableSizePicker({ onPick, close, max = 10 }: { onPick: (rows: number, cols: number) => void; close: () => void; max?: number }) {
  const [hover, setHover] = useState<[number, number]>([2, 3]);
  const cells: ComponentChildren[] = [];
  for (let r = 1; r <= max; r++) for (let c = 1; c <= max; c++) cells.push(
    <span key={`${r}-${c}`} class={'tb-grid-cell' + (r <= hover[0] && c <= hover[1] ? ' on' : '')} onMouseEnter={() => setHover([r, c])} onClick={() => { close(); onPick(r, c); }} />,
  );
  return (
    <div class="tb-tablepick" onMouseDown={e => e.preventDefault()}>
      <div class="tb-grid" style={{ gridTemplateColumns: `repeat(${max}, 14px)` }}>{cells}</div>
      <div class="tb-grid-label">{hover[0]} × {hover[1]} table</div>
    </div>
  );
}

/* ------------------------------------------------------------------ components */

function PaletteButton({ b }: { b: ToolButton }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', h); document.addEventListener('keydown', k);
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k); };
  }, [open]);
  // keep the popup inside the window
  useLayoutEffect(() => {
    const el = popRef.current;
    if (!open || !el) return;
    el.style.left = '0'; el.style.right = 'auto';
    const r = el.getBoundingClientRect();
    if (r.right > window.innerWidth - 8) { el.style.left = 'auto'; el.style.right = '0'; }
    const r2 = el.getBoundingClientRect();
    if (r2.left < 4) { el.style.right = 'auto'; el.style.left = `${4 - (ref.current?.getBoundingClientRect().left ?? 0)}px`; }
  }, [open]);
  const p = b.palette!;
  const close = () => setOpen(false);
  return (
    <span ref={ref} class={'tb-pal' + (open ? ' open' : '')}>
      <button type="button" class={'tb-btn has-pal' + (b.active ? ' active' : '') + (b.kind === 'math' ? ' math' : '')} title={b.title} disabled={b.disabled} data-tb={b.id}
        onMouseDown={e => e.preventDefault()} onClick={() => setOpen(o => !o)}>
        {b.html ? <span dangerouslySetInnerHTML={{ __html: b.html }} /> : ICONS[b.icon] ? <span dangerouslySetInnerHTML={{ __html: ICONS[b.icon] }} /> : <span>{b.icon}</span>}
        <span class="tb-caret">▾</span>
      </button>
      {open && (
        <div ref={popRef} class={'tb-popup' + (p.list ? ' list' : '')} role="menu" data-palette={b.id}>
          <div class="tb-popup-title">{p.title}</div>
          {p.render ? p.render(close) : (
            <div class="tb-popup-grid" style={p.list ? undefined : { gridTemplateColumns: `repeat(${p.cols ?? 8}, minmax(30px, auto))` }}>
              {p.items!.map((it, i) => (
                <button key={i} type="button" class={'tb-pal-item' + (it.active ? ' active' : '')} title={it.title ?? it.label} onMouseDown={e => e.preventDefault()} onClick={() => { close(); it.action(); }}>
                  {it.html ? <span class="tb-pal-sym" dangerouslySetInnerHTML={{ __html: it.html }} /> : <span class="tb-pal-sym text">{it.label}</span>}
                  {p.list && <span class="tb-pal-label">{it.label}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </span>
  );
}

export function Toolbar({ id, layouts, layout, onLayout, groups, label }: ToolbarProps) {
  const names = layouts ? layouts.map(l => l.name) : [];
  if (layouts && layout && !names.includes(layout)) names.unshift(layout);
  return (
    <div class={'toolbar toolbar-' + id} data-toolbar={id} onMouseDown={e => { if ((e.target as HTMLElement).tagName !== 'SELECT') e.preventDefault(); }}>
      {label && <span class="tb-label">{label}</span>}
      {layouts && (
        <select value={layout} onChange={e => onLayout?.((e.target as HTMLSelectElement).value)} title="Paragraph layout (Alt+P …)">
          {names.map(n => <option key={n} value={n}>{n}</option>)}
        </select>
      )}
      {groups.map((g, gi) => (
        <span key={gi} style="display:contents">
          {(gi > 0 || layouts || label) && <span class="tb-sep" />}
          {g.map(b => b.palette ? <PaletteButton key={b.id} b={b} /> : (
            <button key={b.id} type="button" class={'tb-btn' + (b.active ? ' active' : '') + (b.kind === 'math' ? ' math' : '')} title={b.title} disabled={b.disabled} data-tb={b.id} onClick={b.action}
              dangerouslySetInnerHTML={b.html ? { __html: b.html } : ICONS[b.icon] ? { __html: ICONS[b.icon] } : undefined}>{b.html || ICONS[b.icon] ? undefined : b.icon}</button>
          ))}
        </span>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- text colour palette */

/** LyX's named text colours (what `\color` / `\textcolor{…}` accept) with the swatch shown for each. */
export const NAMED_COLORS: [string, string][] = [
  ['black', '#000'], ['darkgray', '#444'], ['gray', '#888'], ['lightgray', '#bbb'], ['white', '#fff'],
  ['red', '#d00'], ['orange', '#e80'], ['yellow', '#aa0'], ['lime', '#5c0'], ['green', '#080'],
  ['olive', '#880'], ['teal', '#088'], ['cyan', '#0aa'], ['blue', '#00d'], ['violet', '#80f'],
  ['purple', '#808'], ['magenta', '#c0c'], ['pink', '#e6a'], ['brown', '#840'],
];
const swatchOf = (c: string | null): string | null => (c ? (c.startsWith('#') ? c : NAMED_COLORS.find(([n]) => n === c)?.[1] ?? null) : null);

/** The toolbar icon: an "A" over a bar in the current colour (outlined when no colour is set). */
export function colorIcon(current: string | null): string {
  const sw = swatchOf(current);
  return `<svg viewBox="0 0 16 16"><text x="3" y="11" font-size="12" font-family="serif">A</text>${sw ? `<rect x="2" y="12.5" width="12" height="2.5" fill="${sw}"/>` : '<rect x="2" y="12.5" width="12" height="2.5" fill="none" stroke="currentColor" stroke-width="0.8"/>'}</svg>`;
}

/** Popup: LyX's named colours as swatches, "default" and a native colour picker (custom colours are written as \textcolor[HTML]{…}). */
export function ColorPalette({ current, onPick, close }: { current: string | null; onPick: (color: string | null) => void; close: () => void }) {
  const [custom, setCustom] = useState(current && current.startsWith('#') ? current : '#ff8800');
  const pick = (c: string | null) => { close(); onPick(c); };
  return (
    <div class="tb-colors" data-color-palette>
      <div class="tb-color-grid">
        {NAMED_COLORS.map(([name, css]) => (
          <button key={name} type="button" class={'tb-swatch' + (current === name ? ' active' : '')} style={{ background: css }} title={name} data-color={name} onMouseDown={e => e.preventDefault()} onClick={() => pick(name)} />
        ))}
        <label class={'tb-swatch custom' + (current && current.startsWith('#') ? ' active' : '')} title="Custom colour…" style={{ background: custom }} data-color="custom">
          <input type="color" value={custom} data-color-custom onInput={e => setCustom((e.target as HTMLInputElement).value)} onChange={e => pick((e.target as HTMLInputElement).value)} />
        </label>
      </div>
      <div class="tb-colors-foot">
        <button type="button" class="small-btn" data-color="none" onMouseDown={e => e.preventDefault()} onClick={() => pick(null)}>Default colour</button>
        <span>{current ? current : 'no colour'}</span>
      </div>
    </div>
  );
}

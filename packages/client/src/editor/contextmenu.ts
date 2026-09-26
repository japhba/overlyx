/**
 * Lightweight DOM context menu (no framework dependency, usable from node views and math fields),
 * laid out like a word processor's: an icon column, the label, the shortcut on the right. The
 * keyboard works too: ↑/↓ choose, → opens a submenu, ← closes it, Enter runs the entry.
 */
import { menuIcon, type MenuIcon } from './menuicons';

export interface MenuItem {
  label?: string;
  action?: () => void;
  disabled?: boolean;
  sep?: boolean;
  shortcut?: string;
  checked?: boolean;
  sub?: MenuItem[];
  /** non-interactive heading line */
  info?: boolean;
  /** the icon before the label (menuicons.ts) */
  icon?: MenuIcon;
}

let open: HTMLElement[] = [];
let cleanup: (() => void) | null = null;

export function closeContextMenu(): void {
  for (const m of open) m.remove();
  open = [];
  cleanup?.();
  cleanup = null;
}

/** open `it`'s submenu next to its row (closing deeper ones); its first entry is marked when `select` */
function openSub(row: HTMLElement, it: MenuItem, level: number, select: boolean): void {
  for (const m of open.splice(level + 1)) m.remove();
  const r = row.getBoundingClientRect();
  const child = build(it.sub!, r.right - 2, r.top - 6, level + 1);
  open.push(child);
  document.body.appendChild(child);
  place(child, r.right - 2, r.top - 6, r.left);
  if (select) mark(child, rows(child)[0] ?? null);
}

const rows = (menu: HTMLElement) => [...menu.querySelectorAll<HTMLElement>(':scope > .ctx-item:not(.disabled):not(.info)')];
function mark(menu: HTMLElement, row: HTMLElement | null): void {
  for (const r of menu.querySelectorAll('.ctx-item.active')) r.classList.remove('active');
  row?.classList.add('active');
}

function build(items: MenuItem[], x: number, y: number, level: number): HTMLElement {
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.setAttribute('role', 'menu');
  // an icon column when any entry has an icon or a check mark (the labels line up)
  const icons = items.some(it => it.icon || it.checked !== undefined);
  if (icons) menu.classList.add('with-icons');
  for (const it of items) {
    if (it.sep) { const s = document.createElement('div'); s.className = 'ctx-sep'; menu.appendChild(s); continue; }
    const row = document.createElement('div');
    row.className = 'ctx-item' + (it.disabled ? ' disabled' : '') + (it.checked ? ' checked' : '') + (it.info ? ' info' : '') + (it.sub ? ' has-sub' : '');
    row.setAttribute('role', it.info ? 'presentation' : it.checked !== undefined ? 'menuitemcheckbox' : 'menuitem');
    if (it.checked !== undefined) row.setAttribute('aria-checked', String(!!it.checked));
    if (icons && !it.info) {
      const slot = document.createElement('span');
      slot.className = 'ctx-icon';
      // a check mark is drawn by the stylesheet (.checked .ctx-icon::before): not part of the entry's text
      if (it.icon && !it.checked) slot.appendChild(menuIcon(it.icon));
      row.appendChild(slot);
    }
    const label = document.createElement('span'); label.className = 'ctx-label'; label.textContent = it.label ?? ''; row.appendChild(label);
    if (it.shortcut) { const sc = document.createElement('span'); sc.className = 'shortcut'; sc.textContent = it.shortcut; row.appendChild(sc); }
    if (it.sub) { const arrow = document.createElement('span'); arrow.className = 'arrow'; arrow.textContent = '▸'; row.appendChild(arrow); }
    row.addEventListener('mousedown', (ev) => ev.preventDefault());
    if (it.sub) {
      row.addEventListener('mouseenter', () => { mark(menu, row); openSub(row, it, level, false); });
      (row as any).__open = (select: boolean) => openSub(row, it, level, select);
    } else if (!it.disabled && !it.info) {
      const run = () => { closeContextMenu(); it.action?.(); };
      row.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); run(); });
      row.addEventListener('mouseenter', () => { mark(menu, row); for (const m of open.splice(level + 1)) m.remove(); });
      (row as any).__run = run;
    }
    menu.appendChild(row);
  }
  menu.style.left = x + 'px'; menu.style.top = y + 'px';
  return menu;
}

/** keep the menu inside the window; a submenu that does not fit on the right opens to the left of `flipX` */
function place(menu: HTMLElement, x: number, y: number, flipX?: number): void {
  const r = menu.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  if (x + r.width > vw - 4) x = flipX !== undefined && flipX - r.width + 2 >= 4 ? flipX - r.width + 2 : Math.max(4, vw - r.width - 4);
  if (y + r.height > vh - 4) y = Math.max(4, vh - r.height - 4);
  menu.style.left = x + 'px'; menu.style.top = y + 'px';
}

/** ↑/↓/→/←/Enter in the deepest open menu */
function menuKey(ev: KeyboardEvent): boolean {
  const menu = open[open.length - 1];
  if (!menu) return false;
  const list = rows(menu);
  const cur = menu.querySelector<HTMLElement>(':scope > .ctx-item.active');
  const i = cur ? list.indexOf(cur) : -1;
  switch (ev.key) {
    case 'ArrowDown': mark(menu, list[(i + 1) % list.length] ?? null); return true;
    case 'ArrowUp': mark(menu, list[(i - 1 + list.length) % list.length] ?? null); return true;
    case 'ArrowRight': if (cur && (cur as any).__open) (cur as any).__open(true); return true;
    case 'ArrowLeft': if (open.length > 1) open.pop()!.remove(); return true;
    case 'Enter': case ' ':
      if (cur && (cur as any).__run) (cur as any).__run();
      else if (cur && (cur as any).__open) (cur as any).__open(true);
      return true;
    default: return false;
  }
}

export function showContextMenu(x: number, y: number, items: MenuItem[]): void {
  closeContextMenu();
  if (!items.length) return;
  // no separator first, last or twice in a row (entries that depend on the context come and go)
  const tidy = items.filter((it, i, a) => !it.sep || (i > 0 && i < a.length - 1 && !a[i + 1].sep && !a[i - 1].sep));
  const menu = build(tidy, x, y, 0);
  open.push(menu);
  document.body.appendChild(menu);
  place(menu, x, y);
  const onDown = (ev: MouseEvent) => { if (!(ev.target as HTMLElement).closest('.ctx-menu')) closeContextMenu(); };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') { closeContextMenu(); ev.stopPropagation(); ev.preventDefault(); return; }
    if (menuKey(ev)) { ev.stopPropagation(); ev.preventDefault(); }
  };
  const onScroll = () => closeContextMenu();
  setTimeout(() => {
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('blur', onScroll);
  }, 0);
  cleanup = () => {
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('blur', onScroll);
  };
}

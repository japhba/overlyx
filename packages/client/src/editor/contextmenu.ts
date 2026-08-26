/**
 * Lightweight DOM context menu (no framework dependency, usable from node views and MathLive fields).
 */
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
}

let open: HTMLElement[] = [];
let cleanup: (() => void) | null = null;

export function closeContextMenu(): void {
  for (const m of open) m.remove();
  open = [];
  cleanup?.();
  cleanup = null;
}

function build(items: MenuItem[], x: number, y: number, level: number): HTMLElement {
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.setAttribute('role', 'menu');
  for (const it of items) {
    if (it.sep) { const s = document.createElement('div'); s.className = 'ctx-sep'; menu.appendChild(s); continue; }
    const row = document.createElement('div');
    row.className = 'ctx-item' + (it.disabled ? ' disabled' : '') + (it.checked ? ' checked' : '') + (it.info ? ' info' : '') + (it.sub ? ' has-sub' : '');
    const label = document.createElement('span'); label.textContent = it.label ?? ''; row.appendChild(label);
    if (it.shortcut) { const sc = document.createElement('span'); sc.className = 'shortcut'; sc.textContent = it.shortcut; row.appendChild(sc); }
    if (it.sub) { const arrow = document.createElement('span'); arrow.className = 'arrow'; arrow.textContent = '▸'; row.appendChild(arrow); }
    row.addEventListener('mousedown', (ev) => ev.preventDefault());
    if (it.sub) {
      let child: HTMLElement | null = null;
      row.addEventListener('mouseenter', () => {
        // close sibling submenus of this level
        for (const m of open.splice(level + 1)) m.remove();
        const r = row.getBoundingClientRect();
        child = build(it.sub!, r.right - 2, r.top - 4, level + 1);
        open.push(child);
        document.body.appendChild(child);
        place(child, r.right - 2, r.top - 4);
      });
    } else if (!it.disabled && !it.info) {
      row.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); closeContextMenu(); it.action?.(); });
      row.addEventListener('mouseenter', () => { for (const m of open.splice(level + 1)) m.remove(); });
    }
    menu.appendChild(row);
  }
  menu.style.left = x + 'px'; menu.style.top = y + 'px';
  return menu;
}

function place(menu: HTMLElement, x: number, y: number): void {
  const r = menu.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  if (x + r.width > vw - 4) x = Math.max(4, vw - r.width - 4);
  if (y + r.height > vh - 4) y = Math.max(4, vh - r.height - 4);
  menu.style.left = x + 'px'; menu.style.top = y + 'px';
}

export function showContextMenu(x: number, y: number, items: MenuItem[]): void {
  closeContextMenu();
  if (!items.length) return;
  const menu = build(items, x, y, 0);
  open.push(menu);
  document.body.appendChild(menu);
  place(menu, x, y);
  const onDown = (ev: MouseEvent) => { if (!(ev.target as HTMLElement).closest('.ctx-menu')) closeContextMenu(); };
  const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { closeContextMenu(); ev.stopPropagation(); } };
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

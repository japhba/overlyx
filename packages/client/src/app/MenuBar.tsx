import { useEffect, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { User } from '../api';

export interface MenuEntry { label?: string; shortcut?: string; action?: () => void; checked?: boolean; disabled?: boolean; sep?: boolean; sub?: MenuEntry[] }
export interface MenuDef { title: string; items: MenuEntry[] }

function MenuList({ items, close }: { items: MenuEntry[]; close: () => void }) {
  return (
    <div class="menu-list" onMouseDown={e => e.preventDefault()}>
      {items.map((it, i) => {
        if (it.sep) return <div key={i} class="menu-sep" />;
        if (it.sub) return <div key={i} class="menu-item menu-sub"><span>{it.label}</span><SubMenu items={it.sub} close={close} /></div>;
        return (
          <div key={i} class={'menu-item' + (it.checked ? ' checked' : '') + (it.disabled ? ' disabled' : '')} onClick={() => { if (!it.disabled) { close(); it.action?.(); } }}>
            <span>{it.label}</span>{it.shortcut && <span class="shortcut">{it.shortcut}</span>}
          </div>
        );
      })}
    </div>
  );
}

function SubMenu({ items, close }: { items: MenuEntry[]; close: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <span style="position:absolute;inset:0" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      {open && <MenuList items={items} close={close} />}
    </span>
  );
}

export function MenuBar({ menus, user, right, onLogout }: { menus: MenuDef[]; user: User; right?: ComponentChildren; onLogout: () => void }) {
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    if (open === null) return;
    const h = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('.menubar')) setOpen(null); };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(null); };
    document.addEventListener('mousedown', h); document.addEventListener('keydown', k);
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k); };
  }, [open]);
  return (
    <div class="menubar">
      <span class="brand">OverLyX <span>· LyX-compatible collaborative editor</span></span>
      {menus.map((m, i) => (
        <div key={m.title} class={'menu' + (open === i ? ' open' : '')} onMouseEnter={() => { if (open !== null) setOpen(i); }}>
          <button onMouseDown={e => { e.preventDefault(); setOpen(open === i ? null : i); }}>{m.title}</button>
          {open === i && <MenuList items={m.items} close={() => setOpen(null)} />}
        </div>
      ))}
      <span class="spacer" />
      {right}
      <span class="userbox">
        <span class="avatar" style={{ background: user.color }}>{user.name.slice(0, 1).toUpperCase()}</span>
        <span>{user.name}</span>
        <button class="small-btn" onClick={onLogout}>Sign out</button>
      </span>
    </div>
  );
}

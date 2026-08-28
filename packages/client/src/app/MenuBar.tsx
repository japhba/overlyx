import { useEffect, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { User } from '../api';
import { Wordmark } from './Logo';
import { AvatarContent, initials } from './Avatar';
import { toggleTheme, useTheme } from './theme';

/** Sun / moon button: flips between light and dark (View ▸ Theme ▸ System follows the OS again). */
function ThemeToggle() {
  const { theme, pref } = useTheme();
  const dark = theme === 'dark';
  return (
    <button type="button" class="theme-toggle" data-theme-toggle data-current={theme} onClick={toggleTheme}
      title={`${dark ? 'Dark' : 'Light'} theme${pref === 'system' ? ' (following the system)' : ''} — click for ${dark ? 'light' : 'dark'}`}>
      {dark
        ? <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.2" /><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8" /></svg>
        : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z" /></svg>}
    </button>
  );
}

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

export function MenuBar({ menus, user, right, onLogout, onHome }: { menus: MenuDef[]; user: User; right?: ComponentChildren; onLogout: () => void; onHome: () => void }) {
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
      <a class="brand" href="#/" title="Start screen" onClick={e => { e.preventDefault(); onHome(); }}><Wordmark /></a>
      {menus.map((m, i) => (
        <div key={m.title} class={'menu' + (open === i ? ' open' : '')} onMouseEnter={() => { if (open !== null) setOpen(i); }}>
          <button onMouseDown={e => { e.preventDefault(); setOpen(open === i ? null : i); }}>{m.title}</button>
          {open === i && <MenuList items={m.items} close={() => setOpen(null)} />}
        </div>
      ))}
      <span class="spacer" />
      {right}
      <ThemeToggle />
      <span class="userbox">
        <span class="avatar" style={{ background: user.color }} data-initials={user.avatar ? undefined : initials(user.name).length}><AvatarContent name={user.name} src={user.avatar} /></span>
        <span>{user.name}</span>
        <button class="small-btn" onClick={onLogout}>Sign out</button>
      </span>
    </div>
  );
}

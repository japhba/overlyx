import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { User } from '../api';
import { Wordmark } from './Logo';
import { AvatarContent, initials } from './Avatar';
import { toggleTheme, useTheme } from './theme';
import { formatShortcut } from './shortcuts';
import { canonical, effectiveShortcut, getBindings, isCustom, keyFromEvent, setBinding, subscribeBindings } from './keybindings';

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
/** `search`: the menu starts with the command palette (a search over all menus and shortcuts) — the Help menu */
export interface MenuDef { title: string; items: MenuEntry[]; search?: boolean }
/**
 * Something the palette can find: a menu item (with its menu path) or a reference entry (a
 * shortcut from the table). `id` = the menu path, the key of a user shortcut; `fixed` entries
 * cannot be given one (the shortcut is informational).
 */
export interface SearchEntry { id: string; label: string; path: string[]; shortcut?: string; checked?: boolean; action?: () => void; fixed?: boolean }

/** the Help menu item that opens the palette (its id = 'Help ▸ ' + label); rebindable like any other */
export const PALETTE_LABEL = 'Search menus and shortcuts (command palette)';
export const PALETTE_DEFAULT = 'Ctrl+Shift+P';
const PALETTE_ID = 'Help ▸ ' + PALETTE_LABEL;
/** opens the palette from outside (the Help menu item) */
export const openPalette = () => window.dispatchEvent(new Event('ol:palette'));

const cleanLabel = (s: string) => s.replace(/\s*▸\s*$/, '').replace(/…$/, '').trim();
const entryId = (path: string[], label: string) => [...path, cleanLabel(label)].join(' ▸ ');

/** every runnable item of every menu, with its path (File ▸ Export ▸ …) */
export function collectEntries(menus: MenuDef[]): SearchEntry[] {
  const out: SearchEntry[] = [];
  const walk = (items: MenuEntry[], path: string[]) => {
    for (const it of items) {
      if (it.sep || !it.label) continue;
      if (it.sub) { walk(it.sub, [...path, cleanLabel(it.label)]); continue; }
      if (it.disabled || !it.action) continue;
      out.push({ id: entryId(path, it.label), label: cleanLabel(it.label), path, shortcut: it.shortcut, checked: it.checked, action: it.action });
    }
  };
  for (const m of menus) walk(m.items, [m.title]);
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/[⌘⌥⇧⌃]/g, c => ({ '⌘': 'cmd ', '⌥': 'alt ', '⇧': 'shift ', '⌃': 'control ' })[c] ?? c);

/** ranked matches: label start, a word start in the label, inside the label, the path, the shortcut (every word of the query must occur) */
export function searchEntries(entries: SearchEntry[], query: string, limit = 12): SearchEntry[] {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const scored: [number, SearchEntry][] = [];
  for (const e of entries) {
    const shortcut = effectiveShortcut(e.id, e.shortcut) ?? '';
    const label = norm(e.label), path = norm(e.path.join(' ')), sc = norm(shortcut + ' ' + formatShortcut(shortcut));
    let score = 0;
    for (const w of words) {
      const s = label.startsWith(w) ? 5 : (' ' + label).includes(' ' + w) ? 4 : label.includes(w) ? 3 : path.includes(w) ? 2 : sc.includes(w) ? 1 : 0;
      if (!s) { score = 0; break; }
      score += s;
    }
    if (score) scored.push([score, e]);
  }
  return scored.sort((a, b) => b[0] - a[0] || a[1].label.length - b[1].label.length).slice(0, limit).map(x => x[1]);
}

/** re-render when the user's shortcuts change */
function useBindings() {
  const [, tick] = useState(0);
  useEffect(() => subscribeBindings(() => tick(t => t + 1)), []);
  return getBindings();
}

function MenuList({ items, path, close, style }: { items: MenuEntry[]; path: string[]; close: () => void; style?: string }) {
  return (
    <div class="menu-list" style={style} onMouseDown={e => e.preventDefault()}>
      {items.map((it, i) => {
        if (it.sep) return <div key={i} class="menu-sep" />;
        if (it.sub) return <div key={i} class="menu-item menu-sub"><span>{cleanLabel(it.label ?? '')}</span><SubMenu items={it.sub} path={[...path, cleanLabel(it.label ?? '')]} close={close} /></div>;
        const sc = it.label ? effectiveShortcut(entryId(path, it.label), it.shortcut) : it.shortcut;
        return (
          <div key={i} class={'menu-item' + (it.checked ? ' checked' : '') + (it.disabled ? ' disabled' : '')} onClick={() => { if (!it.disabled) { close(); it.action?.(); } }}>
            <span>{it.label}</span>{sc && <span class="shortcut">{formatShortcut(sc)}</span>}
          </div>
        );
      })}
    </div>
  );
}

/**
 * A submenu opens beside its item. The list is positioned `fixed` at the item's screen position:
 * the parent menu scrolls (overflow: auto) when it is taller than the window, which would clip an
 * absolutely positioned child sticking out of it. Near the right edge of the window it opens to
 * the left instead.
 */
function SubMenu({ items, path, close }: { items: MenuEntry[]; path: string[]; close: () => void }) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const open = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const width = 240;
    const left = r.right + width > window.innerWidth - 8 ? Math.max(0, r.left - width) : r.right;
    const top = Math.min(r.top - 5, Math.max(0, window.innerHeight - 8 - Math.min(items.length * 24 + 10, window.innerHeight * 0.8)));
    setPos({ top, left });
  };
  return (
    <span style="position:absolute;inset:0" onMouseEnter={open} onMouseLeave={() => setPos(null)}>
      {pos && <MenuList items={items} path={path} close={close} style={`position:fixed;top:${pos.top}px;left:${pos.left}px`} />}
    </span>
  );
}

/**
 * The command palette (Help menu): a search box over every menu item and shortcut, then the
 * menu's own items. Every result has a ✎ button that records a new shortcut for it — press the
 * keys; Backspace removes the shortcut, Esc cancels; a key that another command uses asks first.
 */
function SearchMenu({ menu, entries, close, recording, setRecording }: { menu: MenuDef; entries: SearchEntry[]; close: () => void; recording: string | null; setRecording: (id: string | null) => void }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const results = useMemo(() => searchEntries(entries, q), [entries, q]);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => { setSel(0); }, [q]);
  useEffect(() => () => setRecording(null), []);
  const run = (e: SearchEntry) => { close(); e.action?.(); };

  /** a recorded key for `id`: collisions are confirmed, the other command then loses the key */
  const assign = (id: string, key: string) => {
    const me = entries.find(e => e.id === id);
    const other = entries.find(e => e.id !== id && canonical(effectiveShortcut(e.id, e.shortcut)) === key);
    if (other) {
      const ok = confirm(`${formatShortcut(key)} is already used by “${[...other.path, other.label].join(' ▸ ')}”.\n\nUse it for “${[...(me?.path ?? []), me?.label ?? id].join(' ▸ ')}” instead? The other command keeps working from the menu, without a shortcut.`);
      if (!ok) return;
      setBinding(other.id, null);
    }
    setBinding(id, key);
    setRecording(null);
  };
  const onKey = (ev: KeyboardEvent) => {
    if (recording) {
      ev.preventDefault(); ev.stopPropagation();
      if (ev.key === 'Escape') { setRecording(null); return; }
      if ((ev.key === 'Backspace' || ev.key === 'Delete') && !ev.ctrlKey && !ev.altKey && !ev.metaKey) { setBinding(recording, null); setRecording(null); return; }
      const k = keyFromEvent(ev);
      if (k) assign(recording, k);
      return;
    }
    if (ev.key === 'ArrowDown') { ev.preventDefault(); setSel(s => Math.min(results.length - 1, s + 1)); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); setSel(s => Math.max(0, s - 1)); }
    else if (ev.key === 'Enter') { ev.preventDefault(); if (results[sel]) run(results[sel]); }
    else if (ev.key === 'Escape') { ev.preventDefault(); close(); }
    ev.stopPropagation();
  };
  return (
    <div class="menu-list help-menu" onMouseDown={e => e.preventDefault()}>
      <div class="menu-search" onMouseDown={e => e.stopPropagation()}>
        <input ref={input} value={q} placeholder={`Search menus and shortcuts (${formatShortcut(effectiveShortcut(PALETTE_ID, PALETTE_DEFAULT) ?? 'F1')})`} data-help-search
          onInput={e => setQ((e.target as HTMLInputElement).value)} onKeyDown={onKey} autocomplete="off" spellcheck={false} />
      </div>
      {q.trim() ? (
        results.length ? results.map((r, i) => {
          const sc = effectiveShortcut(r.id, r.shortcut);
          const custom = isCustom(r.id);
          return (
            <div key={r.id} class={'menu-result' + (i === sel ? ' sel' : '') + (r.checked ? ' checked' : '') + (recording === r.id ? ' recording' : '')} data-help-result onMouseEnter={() => setSel(i)} onClick={() => { if (recording !== r.id) run(r); }}>
              <span class="label"><span class="path">{r.path.join(' ▸ ')} ▸ </span>{r.label}</span>
              {recording === r.id
                ? <span class="rec" data-recording>Press the new keys… (Backspace: none, Esc: cancel)</span>
                : <>
                  {sc && <span class={'shortcut' + (custom ? ' custom' : '')} title={custom ? 'Your shortcut' : undefined}>{formatShortcut(sc)}</span>}
                  {custom && <button type="button" class="kb" data-reset-shortcut title="Back to the default shortcut" onClick={e => { e.stopPropagation(); setBinding(r.id, undefined); }}>↺</button>}
                  {!r.fixed && <button type="button" class="kb" data-set-shortcut title={sc ? 'Change the shortcut' : 'Set a shortcut'} onClick={e => { e.stopPropagation(); setRecording(r.id); input.current?.focus(); }}>{sc ? '✎' : '+ key'}</button>}
                </>}
            </div>
          );
        }) : <div class="menu-empty">No menu item or shortcut matches “{q.trim()}”.</div>
      ) : (
        menu.items.map((it, i) => {
          if (it.sep) return <div key={i} class="menu-sep" />;
          const sc = it.label ? effectiveShortcut(entryId([menu.title], it.label), it.shortcut) : it.shortcut;
          return (
            <div key={i} class={'menu-item' + (it.checked ? ' checked' : '') + (it.disabled ? ' disabled' : '')} onClick={() => { if (!it.disabled) { close(); it.action?.(); } }}>
              <span>{it.label}</span>{sc && <span class="shortcut">{formatShortcut(sc)}</span>}
            </div>
          );
        })
      )}
      <div class="menu-hint">↑↓ Enter runs a command · ✎ sets its shortcut</div>
    </div>
  );
}

export function MenuBar({ menus, user, right, onLogout, onHome, searchEntries: extra = [] }: { menus: MenuDef[]; user: User; right?: ComponentChildren; onLogout: () => void; onHome: () => void; /** reference entries (shortcuts without a menu item) for the palette */ searchEntries?: SearchEntry[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const [recording, setRecording] = useState<string | null>(null);
  const bindings = useBindings();
  /** whatever had the keyboard before the palette took it (the editor, usually) gets it back */
  const prevFocus = useRef<HTMLElement | null>(null);
  const searchIndex = menus.findIndex(m => m.search);
  const entries = useMemo(() => [...collectEntries(menus), ...extra], [menus, extra]);
  // the user's shortcuts in force (key → command) and the default keys that no longer apply
  const keyIndex = useMemo(() => {
    const custom = new Map<string, SearchEntry>();
    const shadowed = new Set<string>();
    for (const e of entries) {
      if (e.fixed || !e.action) continue;
      if (!isCustom(e.id)) continue;
      const k = canonical(effectiveShortcut(e.id, e.shortcut));
      if (k) custom.set(k, e);
      const d = canonical(e.shortcut);
      if (d && d !== k) shadowed.add(d);
    }
    return { custom, shadowed };
  }, [entries, bindings]);
  const live = useRef({ keyIndex, recording, open, searchIndex });
  live.current = { keyIndex, recording, open, searchIndex };

  const close = () => { setOpen(null); setRecording(null); const p = prevFocus.current; prevFocus.current = null; if (p && document.contains(p)) p.focus(); };
  const openSearch = () => { if (live.current.searchIndex < 0) return; if (live.current.open === null) prevFocus.current = document.activeElement as HTMLElement | null; setOpen(live.current.searchIndex); };
  useEffect(() => {
    if (open === null) return;
    const h = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('.menubar')) close(); };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !live.current.recording) close(); };
    document.addEventListener('mousedown', h); document.addEventListener('keydown', k);
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k); };
  }, [open]);
  // global keys: the palette (Ctrl+Shift+P / F1), the user's shortcuts, and the swallowed default keys of rebound commands
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (live.current.recording) return;   // the recorder reads this key
      const k = keyFromEvent(e);
      if (!k) return;
      const paletteKey = canonical(effectiveShortcut(PALETTE_ID, PALETTE_DEFAULT));
      if (k === paletteKey || k === 'F1') { e.preventDefault(); e.stopPropagation(); openSearch(); return; }
      const { custom, shadowed } = live.current.keyIndex;
      const hit = custom.get(k);
      if (hit?.action) { e.preventDefault(); e.stopPropagation(); if (live.current.open !== null) close(); hit.action(); return; }
      if (shadowed.has(k)) { e.preventDefault(); e.stopPropagation(); }
    };
    const onOpen = () => openSearch();
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('ol:palette', onOpen);
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('ol:palette', onOpen); };
  }, []);
  const toggle = (i: number) => {
    if (open === i) { close(); return; }
    if (menus[i].search && open === null) prevFocus.current = document.activeElement as HTMLElement | null;
    setOpen(i);
  };
  const paletteKey = formatShortcut(effectiveShortcut(PALETTE_ID, PALETTE_DEFAULT) ?? 'F1');
  return (
    <div class="menubar">
      <a class="brand" href="#/" title="Start screen" onClick={e => { e.preventDefault(); onHome(); }}><Wordmark /></a>
      {menus.map((m, i) => (
        <div key={m.title} class={'menu' + (open === i ? ' open' : '')} onMouseEnter={() => { if (open !== null && open !== i) toggle(i); }}>
          <button onMouseDown={e => { e.preventDefault(); toggle(i); }} title={m.search ? `Search menus and shortcuts (${paletteKey})` : undefined}>{m.title}</button>
          {open === i && (m.search ? <SearchMenu menu={m} entries={entries} close={close} recording={recording} setRecording={setRecording} /> : <MenuList items={m.items} path={[m.title]} close={close} />)}
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

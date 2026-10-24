/**
 * Menus that the editor in the main pane adds to the menu bar, between File and Help — the slide
 * deck's Edit, View, Insert, Slide and Arrange (deliverable/DeliverableEditor.tsx). The editor hands
 * them over on every render; the shell re-renders only when what they show changed (labels, ticks,
 * greyed-out entries), and an entry always runs the newest version of itself — the one at its place
 * now — so a menu that has been open a while acts on what is selected now.
 */
import { useEffect, useState } from 'preact/hooks';
import type { MenuDef, MenuEntry } from './MenuBar';

let latest: MenuDef[] = [];
let shown = '';
const listeners = new Set<() => void>();

const sig = (items: MenuEntry[]): string =>
  items.map(e => e.sep ? '-' : `${e.label}|${e.shortcut ?? ''}|${e.checked ? 1 : 0}|${e.disabled ? 1 : 0}${e.sub ? `[${sig(e.sub)}]` : ''}`).join(';');

/** the editor's menus now (none: [] — the editor closed) */
export function setEditorMenus(menus: MenuDef[]): void {
  latest = menus;
  const s = menus.map(m => `${m.title}{${sig(m.items)}}`).join('');
  if (s === shown) return;
  shown = s;
  for (const f of listeners) f();
}

function live(items: MenuEntry[], at: (path: number[]) => MenuEntry | undefined, path: number[]): MenuEntry[] {
  return items.map((e, i) => e.sep ? e : {
    ...e,
    action: e.action && (() => at([...path, i])?.action?.()),
    sub: e.sub && live(e.sub, at, [...path, i]),
  });
}

/** the menus as the menu bar shows them */
export function useEditorMenus(): MenuDef[] {
  const [, bump] = useState(0);
  useEffect(() => {
    const f = () => bump(n => n + 1);
    listeners.add(f);
    return () => { listeners.delete(f); };
  }, []);
  return latest.map((m, mi) => ({
    ...m,
    items: live(m.items, path => {
      let items: MenuEntry[] | undefined = latest[mi]?.items, e: MenuEntry | undefined;
      for (const k of path) { e = items?.[k]; items = e?.sub; }
      return e;
    }, []),
  }));
}

/**
 * A page's localStorage and sessionStorage inside OverLyX's sandbox. The frame has an opaque origin,
 * where the browser's own throw a SecurityError, and a page that reads them unguarded stops at its
 * first line. Stand-ins are kept in memory instead. In the page pane beside an article (view mode,
 * app/ArticlePage.tsx), localStorage also goes to the editor around the frame, which hands it back
 * through the frame's name (read here before the page's scripts run) when it loads the page again
 * after a save, so a page's view options (a checkbox, a tab) outlast the reload.
 */

/** the frame's name that carries a page's stored items (JSON after it) */
export const PAGE_STORAGE_NAME = 'ol-storage:';
/** at most this much JSON goes to the editor and back (more stays in memory) */
export const PAGE_STORAGE_MAX = 100_000;

class PageStorage {
  private items: Map<string, string>;
  constructor(items: Record<string, string>, private changed?: (items: Record<string, string>) => void) {
    this.items = new Map(Object.entries(items));
  }
  get length(): number { return this.items.size; }
  key(i: number): string | null { return [...this.items.keys()][i] ?? null; }
  getItem(k: string): string | null { return this.items.get(String(k)) ?? null; }
  setItem(k: string, v: string): void { this.items.set(String(k), String(v)); this.tell(); }
  removeItem(k: string): void { if (this.items.delete(String(k))) this.tell(); }
  clear(): void { if (this.items.size) { this.items.clear(); this.tell(); } }
  private tell(): void { this.changed?.(Object.fromEntries(this.items)); }
}

/** the stand-ins, where the browser refuses its own; `persist`: localStorage handed to the editor around the frame */
export function installStorage(persist: boolean): void {
  try { void window.localStorage; return; } catch { /* sandboxed */ }
  let items: Record<string, string> = {};
  if (persist && window.name.startsWith(PAGE_STORAGE_NAME)) {
    try {
      const o = JSON.parse(window.name.slice(PAGE_STORAGE_NAME.length)) as unknown;
      if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) if (typeof v === 'string') items[k] = v;
    } catch { items = {}; }
    // (the name is the page's own again)
    window.name = '';
  }
  let pending = 0;
  const send = persist && window.parent !== window ? (all: Record<string, string>) => {
    clearTimeout(pending);
    pending = window.setTimeout(() => { if (JSON.stringify(all).length <= PAGE_STORAGE_MAX) window.parent.postMessage({ ol: 'pageStorage', items: all }, '*'); }, 50);
  } : undefined;
  for (const [name, store] of [['localStorage', new PageStorage(items, send)], ['sessionStorage', new PageStorage({})]] as const) {
    try { Object.defineProperty(window, name, { value: store, configurable: true }); } catch { /* ignore */ }
  }
}

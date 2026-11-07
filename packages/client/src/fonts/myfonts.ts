/**
 * My fonts: Google fonts installed into the account (server myfonts.ts) — first in the font lists
 * (app/FontPicker.tsx), the same in the web app and in VS Code, whose bridge keeps their files on the
 * computer (vscode host/fonts.ts). `null`: no list here (a guest; VS Code signed in to no server).
 */
import { useEffect, useMemo, useState } from 'preact/hooks';
import { fontApi, fontCatalog, loadGoogleFont, type CatalogFamily } from './googlefont';

/** undefined: not asked yet */
let mine: string[] | null | undefined;
let asking: Promise<string[] | null> | null = null;
const listeners = new Set<() => void>();
const changed = (v: string[] | null) => { mine = v; for (const l of [...listeners]) l(); };

/** the account's fonts (asked once per page) */
export function loadMyFonts(): Promise<string[] | null> {
  asking ??= fetch(fontApi('mine'), { credentials: 'same-origin' })
    .then(r => (r.ok ? r.json() : null)).then((j: { fonts?: unknown } | null) => (Array.isArray(j?.fonts) ? j!.fonts as string[] : null))
    .catch(() => null).then(v => { changed(v); return v; });
  return asking;
}

/** My fonts, kept up to date (null until known, or when there is no list here) */
export function useMyFonts(): string[] | null {
  const [v, setV] = useState(mine ?? null);
  useEffect(() => {
    const l = () => setV(mine ?? null);
    listeners.add(l);
    if (mine === undefined) void loadMyFonts(); else l();
    return () => { listeners.delete(l); };
  }, []);
  return v;
}

/**
 * My fonts with what Google's catalogue says of each (axes, weights, italics, category: a deck's css2
 * query, deckfonts.ts googleFontSpec); null until both are known. Each is loaded into the page (from
 * this server), so the lists can show it in its own face.
 */
export function useMyFontEntries(): CatalogFamily[] | null {
  const mine = useMyFonts();
  const [families, setFamilies] = useState<CatalogFamily[] | null>(null);
  useEffect(() => { let live = true; void fontCatalog().then(c => { if (live) setFamilies(c.families); }); return () => { live = false; }; }, []);
  const entries = useMemo(() => (mine && families ? mine.flatMap(name => families.filter(f => f.f === name).slice(0, 1)) : null), [mine, families]);
  useEffect(() => { for (const e of entries ?? []) loadGoogleFont(e.f); }, [entries]);
  return entries;
}

/** Put `family` into My fonts or take it out; false (the list as it was): the server refused or did not answer. */
export async function toggleMyFont(family: string): Promise<boolean> {
  const before = mine ?? [];
  const next = before.includes(family) ? before.filter(f => f !== family) : [...before, family];
  changed(next);
  try {
    const r = await fetch(fontApi('mine'), { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fonts: next }) });
    const j = await r.json().catch(() => ({})) as { fonts?: unknown };
    if (r.ok && Array.isArray(j.fonts)) { changed(j.fonts as string[]); return true; }
  } catch { /* offline */ }
  changed(before);
  return false;
}

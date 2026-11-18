/**
 * LyX's library (layouts, modules, symbols, languages) in the browser's virtual file system
 * (vfs.ts, what `node:fs` is for the core here): the core's LaTeX parser and writer read it. One
 * bundle from the server (`/api/e2e/lyxlib/<version>`, immutable), or from the VS Code extension's
 * bridge, loaded once per page — for end-to-end encrypted projects (texlocal.ts) and for copying
 * a selection as LaTeX (editor/clipsource.ts).
 */
import { mount, mounted } from './vfs';
import { API_BASE } from '../api';

export const LYX_LIB = '/lyx/lib';
export const LAYOUT_DIR = '/lyx/lib/layouts';

let loading: Promise<void> | null = null;
/** LyX's library in the virtual file system (once per page). */
export function ensureLyxLib(): Promise<void> {
  if (mounted(LAYOUT_DIR)) return Promise.resolve();
  return loading ??= (async () => {
    const st = await (await fetch(`${API_BASE}/api/e2e/status`, { credentials: 'same-origin' })).json() as { lyxlib: string };
    const res = await fetch(`${API_BASE}/api/e2e/lyxlib/${encodeURIComponent(st.lyxlib)}`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error('LyX\'s layout files could not be loaded');
    const { files } = await res.json() as { files: Record<string, string> };
    mount(LYX_LIB, files);
  })().catch(e => { loading = null; throw e; });
}

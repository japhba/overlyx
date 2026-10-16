/**
 * Google's file picker, for linking or importing a Google Doc that exists (GoogleDocs.tsx, the file
 * browser's *Import from Google Docs…*). The server hands over its Google project's picker API key,
 * the app id and an access token of the account's own Drive authorisation (GET /api/gdocs/picker);
 * a Google Doc picked here is one OverLyX may open from then on (Drive's `drive.file` — OverLyX sees
 * no other file). Google's script is loaded on first use (the server's CSP allows it where the picker
 * is set up). On a server with the e2e Google stub, a prompt offers the simulated account's Google Docs.
 */
import { api } from '../api';
import { uiPrompt, uiConfirm, uiConfirmCheck } from './Dialogs';

let loading: Promise<void> | null = null;
function loadPicker(): Promise<void> {
  loading ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://apis.google.com/js/api.js';
    s.async = true;
    s.onload = () => (window as any).gapi.load('picker', { callback: () => resolve(), onerror: () => reject(new Error('Google’s file picker did not load')) });
    s.onerror = () => reject(new Error('Google’s file picker did not load — blocked by the browser, or offline?'));
    document.head.appendChild(s);
  }).catch(e => { loading = null; throw e; });
  return loading;
}

/** A Google Doc the user picks: its id, null when the picker was closed. */
export async function pickGoogleDoc(title = 'Choose a Google Doc'): Promise<string | null> {
  const cfg = await api.gdocsPicker();
  if (cfg.stub) {
    const list = cfg.files.map(f => `${f.name} — ${f.id}`).join('\n');
    const id = await uiPrompt(title, `Google Docs of the (simulated) account:\n${list}\n\nThe id of the one to use:`, cfg.files.at(-1)?.id ?? '');
    return id?.trim() || null;
  }
  await loadPicker();
  const g = (window as any).google.picker;
  return new Promise(resolve => {
    const view = new g.DocsView(g.ViewId.DOCUMENTS).setMode(g.DocsViewMode.LIST);
    new g.PickerBuilder()
      .setTitle(title)
      .addView(view)
      .setOAuthToken(cfg.token)
      .setDeveloperKey(cfg.apiKey)
      .setAppId(cfg.appId)
      .setCallback((d: { action: string; docs?: { id: string }[] }) => {
        if (d.action === g.Action.PICKED) resolve(d.docs?.[0]?.id ?? null);
        else if (d.action === g.Action.CANCEL) resolve(null);
      })
      .build()
      .setVisible(true);
  });
}

const SYNC_KEY = 'ol.gdocsImportSync';

/**
 * *Import from Google Docs…* (the start page, the file browser): Google Drive connected (or off to
 * connect it, back to `next`), kept in sync or a copy (the choice is remembered in this browser), a
 * Google Doc picked. Null when anything was cancelled.
 */
export async function chooseGoogleImport(next = location.hash.replace(/\?.*$/, '')): Promise<{ fileId: string; sync: boolean } | null> {
  const st = await api.gdocsAccount();
  if (!st.account) {
    if (await uiConfirm('Import from Google Docs', 'Connect Google Drive first — OverLyX then opens only the Google Docs you pick.', { okLabel: 'Connect Google Drive…' })) location.href = '/api/gdocs/connect?next=' + encodeURIComponent(next);
    return null;
  }
  let remembered = true;
  try { remembered = localStorage.getItem(SYNC_KEY) !== '0'; } catch { /* the default */ }
  const sync = await uiConfirmCheck('Import from Google Docs',
    'Choose a Google Doc in Google’s picker. It comes in as a document; a Google Doc with several tabs as a group with a document per tab.',
    { label: 'Keep in sync with the Google Doc — edits and comments go both ways', checked: remembered },
    { okLabel: 'Choose a Google Doc…' });
  if (sync === null) return null;
  try { localStorage.setItem(SYNC_KEY, sync ? '1' : '0'); } catch { /* not remembered */ }
  const fileId = await pickGoogleDoc('Import a Google Doc');
  return fileId ? { fileId, sync } : null;
}

/**
 * Google's file picker, for linking or importing a Google Doc that exists (GoogleDocs.tsx, the file
 * browser's *Import from Google Docs…*). The server hands over its Google project's picker API key,
 * the app id and an access token of the account's own Drive authorisation (GET /api/gdocs/picker);
 * a Google Doc picked here is one OverLyX may open from then on (Drive's `drive.file` — OverLyX sees
 * no other file). Google's script is loaded on first use (the server's CSP allows it where the picker
 * is set up). On a server with the e2e Google stub, a prompt offers the simulated account's Google Docs.
 */
import { api } from '../api';
import { uiPrompt } from './Dialogs';

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

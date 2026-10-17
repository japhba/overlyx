/**
 * HTTP routes of the Google Docs sync (mounted on /api after the document access rules: changing a
 * link needs edit access to the document's project, reading its state view access).
 *
 *   GET  /gdocs/status?doc=<id>     whether Google is configured, the account's Drive connection, the document's link
 *   GET  /gdocs/connect?next=#/…    to Google's consent screen (Drive files OverLyX creates), back to `next`
 *   POST /gdocs/disconnect          forget (and revoke) the account's Drive authorisation
 *   GET  /gdocs/picker              what Google's file picker needs: the API key, the app id, an access token
 *   GET  /gdocs/file?id=<fileId>    a Google Doc the account may open: its title and tabs (to pick one)
 *   POST /projects/<p>/gdocs/import { fileId, dir, sync? }  a picked Google Doc into the project: a document, or a group of
 *                                   its tabs — linked to it, or (sync: false) a copy
 *   POST /docs/<id>/gdocs/link      create a Google Doc in the account's Drive and link the document to it;
 *                                   with { fileId, tabId? }: link it to a Google Doc that exists (picked)
 *   POST /docs/<id>/gdocs/sync      sync now
 *   POST /docs/<id>/gdocs/unlink    stop syncing (the Google Doc stays)
 *   POST /docs/<id>/gdocs/auto      { auto: boolean } — sync on its own, or only on request
 */
import express from 'express';
import { projectOfDoc, docPathOf, isProjectKey } from '@overlyx/core';
import { roleFor, atLeast } from '../access.ts';
import { canonicalDocId, canonicalProject } from '../namespaces.ts';
import { config } from '../config.ts';
import { assertWritableRelPath } from '../projects.ts';
import { driveAccount, driveConfigured, disconnectDrive, startConnect, accessToken, pickerConfigured, pickerAppId, GoogleApiError, GOOGLE_STUB } from './google.ts';
import { linkOf, linkNewGoogleDoc, linkExistingGoogleDoc, folderGoogleDoc, publicLink, setAuto, syncDoc, unlink, setGoogleApiFactory, googleApiFor } from './sync.ts';
import { importGoogleDoc } from './importing.ts';
import { flatTabs } from './model.ts';
import { FakeGoogle } from './fake.ts';

const docIdOf = (req: express.Request) => canonicalDocId(decodeURIComponent(String((req.params as Record<string, string>)[0] ?? '')));

function failure(res: express.Response, e: unknown): void {
  const err = e as Error;
  const status = err instanceof GoogleApiError && (err.status === 403 || err.status === 404) ? err.status : 400;
  // the Docs / Drive API not enabled for the server's Google project: say what to do
  const msg = /has not been used in project|is disabled|accessNotConfigured|SERVICE_DISABLED/i.test(err.message)
    ? 'The Google Docs / Drive API is not enabled for this server’s Google project — an administrator has to enable both in the Google Cloud console.'
    : err.message;
  res.status(status).json({ error: msg });
}

export function gdocsRoutes(): express.Router {
  const r = express.Router();

  r.get('/gdocs/status', async (req, res) => {
    const doc = typeof req.query.doc === 'string' ? canonicalDocId(req.query.doc) : '';
    const role = doc ? roleFor(req.user!, projectOfDoc(doc)) : null;
    const link = doc && atLeast(role, 'view') ? linkOf(doc) : null;
    const account = driveAccount(req.user!.id);
    const canEdit = !!doc && atLeast(role, 'edit');
    // an unlinked document of a folder whose other documents are a Google Doc's tabs: those tabs nothing syncs with
    let folder = null;
    if (!link && canEdit && account) { try { folder = await folderGoogleDoc(doc, req.user!.id); } catch { /* Google did not answer: only the picker then */ } }
    res.json({ configured: driveConfigured(), picker: pickerConfigured(), account, link: publicLink(link), canEdit, guest: !!req.user!.guest, folder });
  });

  // Google's picker in the browser, with the account's own Drive authorisation (a short-lived access token):
  // a file picked there is one OverLyX may open from then on (drive.file)
  r.get('/gdocs/picker', async (req, res) => {
    try {
      if (!pickerConfigured()) { res.status(404).json({ error: 'Google’s file picker is not set up on this server (GOOGLE_PICKER_API_KEY)' }); return; }
      if (!driveAccount(req.user!.id)) { res.status(409).json({ error: 'Connect Google Drive first' }); return; }
      res.setHeader('Cache-Control', 'no-store');
      if (GOOGLE_STUB) { res.json({ stub: true, files: stubFiles() }); return; }
      res.json({ apiKey: config.google.pickerKey, appId: pickerAppId(), token: await accessToken(req.user!.id) });
    } catch (e) { failure(res, e); }
  });

  r.get('/gdocs/file', async (req, res) => {
    try {
      if (!driveAccount(req.user!.id)) { res.status(409).json({ error: 'Connect Google Drive first' }); return; }
      const api = googleApiFor(req.user!.id);
      const id = String(req.query.id ?? '');
      const [file, whole] = await Promise.all([api.getFile(id), api.getDocumentTabs(id)]);
      res.json({ id, name: file.name ?? whole.title ?? '', tabs: flatTabs(whole) });
    } catch (e) { failure(res, e); }
  });

  // (the project key is one path segment, its slash encoded — as for the other project routes; an old name stands for the project)
  r.post('/projects/:project/gdocs/import', async (req, res) => {
    try {
      const key = canonicalProject(String(req.params.project ?? ''));
      if (!isProjectKey(key) || !atLeast(roleFor(req.user!, key), 'edit')) { res.status(403).json({ error: 'You cannot add documents to this project' }); return; }
      if (!driveAccount(req.user!.id)) { res.status(409).json({ error: 'Connect Google Drive first' }); return; }
      const dir = String(req.body?.dir ?? '').replace(/^\/+|\/+$/g, '');
      if (dir) assertWritableRelPath(dir + '/x.md');
      const r = await importGoogleDoc(key, dir, String(req.body?.fileId ?? ''), req.user!.id, { sync: req.body?.sync !== false });
      res.json({ id: r.docs[0], docs: r.docs, group: r.group });
    } catch (e) { failure(res, e); }
  });

  r.get('/gdocs/connect', (req, res) => {
    if (req.user!.guest) { res.status(403).send('Sign in to connect Google Drive'); return; }
    startConnect(req as express.Request & { user: { id: number; email?: string | null } }, res);
  });

  r.post('/gdocs/disconnect', async (req, res) => {
    await disconnectDrive(req.user!.id);
    res.json({ ok: true });
  });

  r.post('/docs/*/gdocs/link', async (req, res) => {
    try {
      const id = docIdOf(req);
      if (!driveAccount(req.user!.id)) { res.status(409).json({ error: 'Connect Google Drive first' }); return; }
      const existing = linkOf(id);
      if (existing) { res.json({ link: publicLink(existing) }); return; }
      if (req.body?.fileId) {
        const link = await linkExistingGoogleDoc(id, req.user!.id, String(req.body.fileId), req.body.tabId ? String(req.body.tabId) : null, req.body.keep === 'ours' ? 'ours' : 'merge');
        res.json({ link: publicLink(link) });
        return;
      }
      const title = String(req.body?.title ?? '').trim() || docPathOf(id).split('/').pop()!.replace(/\.[^.]+$/, '');
      const link = await linkNewGoogleDoc(id, req.user!.id, title.slice(0, 200));
      res.json({ link: publicLink(link) });
    } catch (e) { failure(res, e); }
  });

  r.post('/docs/*/gdocs/sync', async (req, res) => {
    try {
      const id = docIdOf(req);
      if (!linkOf(id)) { res.status(404).json({ error: 'This document is not linked to a Google Doc' }); return; }
      const report = await syncDoc(id);
      res.json({ report, link: publicLink(linkOf(id)) });
    } catch (e) { failure(res, e); }
  });

  r.post('/docs/*/gdocs/unlink', (req, res) => {
    unlink(docIdOf(req));
    res.json({ ok: true });
  });

  r.post('/docs/*/gdocs/auto', (req, res) => {
    const id = docIdOf(req);
    setAuto(id, !!req.body?.auto);
    res.json({ link: publicLink(linkOf(id)) });
  });

  if (GOOGLE_STUB) stubRoutes(r);
  return r;
}

/**
 * OVERLYX_E2E_GOOGLE_STUB=1: the Google APIs are a simulation (fake.ts) and a test plays the
 * collaborator in Google Docs — reads the Google Doc, edits a word in it, comments on a phrase.
 */
let stubFiles: () => { id: string; name: string }[] = () => [];

function stubRoutes(r: express.Router): void {
  const g = new FakeGoogle();
  setGoogleApiFactory(() => g);
  stubFiles = () => g.list();
  // a Google Doc made in Google Docs (with tabs), for the picker to offer
  r.post('/gdocs/e2e/create', async (req, res) => {
    try {
      const f = await g.createDocument(String(req.body?.title ?? 'From Google Docs'));
      const tabs: { title: string; text: string; parent?: number }[] = Array.isArray(req.body?.tabs) ? req.body.tabs : [{ title: 'Tab 1', text: String(req.body?.text ?? '') }];
      const ids: string[] = [];
      tabs.forEach((t, k) => {
        const tabId = k === 0 ? 't.0' : g.addTab(f.id, String(t.title), t.parent !== undefined ? ids[t.parent] : null);
        if (k === 0) g.tabs.get(f.id)![0].title = String(t.title);
        ids.push(tabId);
        if (t.text) g.tabDoc(f.id, tabId).insertText(1, String(t.text));
      });
      res.json({ id: f.id, tabs: ids });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });
  const fileOf = (req: express.Request) => linkOf(canonicalDocId(String(req.query.doc ?? req.body?.doc ?? '')))?.file_id ?? '';
  r.get('/gdocs/e2e/doc', (req, res) => {
    const id = fileOf(req);
    if (!id) { res.status(404).json({ error: 'not linked' }); return; }
    void g.listComments(id).then(comments => res.json({ text: g.doc(id).text(), comments }));
  });
  r.post('/gdocs/e2e/edit', async (req, res) => {
    try {
      const id = fileOf(req);
      const [from, to] = [String(req.body.from), String(req.body.to)];
      const at = g.indexOf(id, from);
      await g.batchUpdate(id, [{ deleteContentRange: { range: { startIndex: at, endIndex: at + from.length } } }, { insertText: { location: { index: at }, text: to } }], undefined, String(req.body.by ?? 'Kirsten'));
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });
  r.post('/gdocs/e2e/comment', (req, res) => {
    try {
      const id = fileOf(req);
      const quote = String(req.body.quote);
      const at = g.indexOf(id, quote);
      res.json(g.comment(id, at, at + quote.length, String(req.body.content), String(req.body.by ?? 'Kirsten')));
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });
}

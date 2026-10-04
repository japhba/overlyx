/**
 * HTTP routes of the Google Docs sync (mounted on /api after the document access rules: changing a
 * link needs edit access to the document's project, reading its state view access).
 *
 *   GET  /gdocs/status?doc=<id>     whether Google is configured, the account's Drive connection, the document's link
 *   GET  /gdocs/connect?next=#/…    to Google's consent screen (Drive files OverLyX creates), back to `next`
 *   POST /gdocs/disconnect          forget (and revoke) the account's Drive authorisation
 *   POST /docs/<id>/gdocs/link      create a Google Doc in the account's Drive and link the document to it
 *   POST /docs/<id>/gdocs/sync      sync now
 *   POST /docs/<id>/gdocs/unlink    stop syncing (the Google Doc stays)
 *   POST /docs/<id>/gdocs/auto      { auto: boolean } — sync on its own, or only on request
 */
import express from 'express';
import { projectOfDoc, docPathOf } from '@overlyx/core';
import { roleFor, atLeast } from '../access.ts';
import { canonicalDocId } from '../namespaces.ts';
import { driveAccount, driveConfigured, disconnectDrive, startConnect, GoogleApiError, GOOGLE_STUB } from './google.ts';
import { linkOf, linkNewGoogleDoc, publicLink, setAuto, syncDoc, unlink, setGoogleApiFactory } from './sync.ts';
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

  r.get('/gdocs/status', (req, res) => {
    const doc = typeof req.query.doc === 'string' ? canonicalDocId(req.query.doc) : '';
    const role = doc ? roleFor(req.user!, projectOfDoc(doc)) : null;
    const link = doc && atLeast(role, 'view') ? linkOf(doc) : null;
    res.json({ configured: driveConfigured(), account: driveAccount(req.user!.id), link: publicLink(link), canEdit: !!doc && atLeast(role, 'edit'), guest: !!req.user!.guest });
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
function stubRoutes(r: express.Router): void {
  const g = new FakeGoogle();
  setGoogleApiFactory(() => g);
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

/**
 * HTTP routes of the LessWrong sync (mounted on /api after the document access rules: changing a
 * link needs edit access to the document's project, reading its state view access).
 *
 *   GET  /lesswrong/status?doc=<id>    the account's LessWrong connection, the document's link
 *   GET  /lesswrong/connect?next=#/…   to LessWrong's consent page, back to `next`
 *   GET  /lesswrong/callback           LessWrong's answer (api.ts finishConnect)
 *   POST /lesswrong/disconnect         forget (and revoke) the account's LessWrong authorisation
 *   POST /docs/<id>/lesswrong/link     { url, keep? } link the document to the draft the URL names
 *                                      (an edit URL with its link-sharing key, a post URL, an id)
 *   POST /docs/<id>/lesswrong/key      { url } the draft's link-sharing key (comment threads both ways); '' forgets it
 *   POST /docs/<id>/lesswrong/sync     sync now
 *   POST /docs/<id>/lesswrong/unlink   stop syncing (the draft stays)
 *   POST /docs/<id>/lesswrong/auto     { auto: boolean } — sync on its own, or only on request
 */
import express from 'express';
import { projectOfDoc } from '@overlyx/core';
import { roleFor, atLeast } from '../access.ts';
import { canonicalDocId } from '../namespaces.ts';
import { lessWrongAccount, startConnect, finishConnect, disconnectLessWrong, parsePostRef, LESSWRONG_STUB } from './api.ts';
import { lwLinkOf, publicLwLink, linkPost, setLinkKey, syncDoc, unlinkPost, setLwAuto, setLessWrongApiFactory } from './sync.ts';
import { FakeLessWrong } from './fake.ts';

const docIdOf = (req: express.Request) => canonicalDocId(decodeURIComponent(String((req.params as Record<string, string>)[0] ?? '')));
const failure = (res: express.Response, e: unknown) => { res.status(400).json({ error: (e as Error).message }); };
const BAD_URL = 'Paste the draft’s address from LessWrong: its edit page (lesswrong.com/editPost?postId=…) or the post’s page (lesswrong.com/posts/…)';

export function lessWrongRoutes(): express.Router {
  const r = express.Router();

  r.get('/lesswrong/status', (req, res) => {
    const doc = typeof req.query.doc === 'string' ? canonicalDocId(req.query.doc) : '';
    const role = doc ? roleFor(req.user!, projectOfDoc(doc)) : null;
    const link = doc && atLeast(role, 'view') ? lwLinkOf(doc) : null;
    res.json({ account: lessWrongAccount(req.user!.id), link: publicLwLink(link), canEdit: !!doc && atLeast(role, 'edit'), guest: !!req.user!.guest });
  });

  r.get('/lesswrong/connect', (req, res) => {
    if (req.user!.guest) { res.status(403).send('Sign in to connect LessWrong'); return; }
    void startConnect(req, res);
  });
  r.get('/lesswrong/callback', (req, res) => { void finishConnect(req, res); });

  r.post('/lesswrong/disconnect', async (req, res) => {
    await disconnectLessWrong(req.user!.id);
    res.json({ ok: true });
  });

  r.post('/docs/*/lesswrong/link', async (req, res) => {
    try {
      const id = docIdOf(req);
      if (!lessWrongAccount(req.user!.id)) { res.status(409).json({ error: 'Connect LessWrong first' }); return; }
      const ref = parsePostRef(String(req.body?.url ?? ''));
      if (!ref) { res.status(400).json({ error: BAD_URL }); return; }
      const link = await linkPost(id, req.user!.id, ref, req.body?.keep === 'merge' ? 'merge' : 'ours');
      res.json({ link: publicLwLink(link) });
    } catch (e) { failure(res, e); }
  });

  r.post('/docs/*/lesswrong/key', async (req, res) => {
    try {
      const id = docIdOf(req);
      const url = String(req.body?.url ?? '').trim();
      const ref = url ? parsePostRef(url) : null;
      if (url && !ref?.key) { res.status(400).json({ error: 'Paste the draft’s edit address with its key (lesswrong.com/editPost?postId=…&key=…), copied after setting “Anyone with the link can” to Edit' }); return; }
      const link = lwLinkOf(id);
      if (link && ref && ref.postId !== link.post_id) { res.status(400).json({ error: 'That address is another post’s' }); return; }
      await setLinkKey(id, ref?.key ?? null);
      res.json({ link: publicLwLink(lwLinkOf(id)) });
    } catch (e) { failure(res, e); }
  });

  r.post('/docs/*/lesswrong/sync', async (req, res) => {
    try {
      const id = docIdOf(req);
      if (!lwLinkOf(id)) { res.status(404).json({ error: 'This document is not linked to a LessWrong draft' }); return; }
      const report = await syncDoc(id);
      res.json({ report, link: publicLwLink(lwLinkOf(id)) });
    } catch (e) { failure(res, e); }
  });

  r.post('/docs/*/lesswrong/unlink', (req, res) => {
    unlinkPost(docIdOf(req));
    res.json({ ok: true });
  });

  r.post('/docs/*/lesswrong/auto', (req, res) => {
    const id = docIdOf(req);
    setLwAuto(id, !!req.body?.auto);
    res.json({ link: publicLwLink(lwLinkOf(id)) });
  });

  if (LESSWRONG_STUB) stubRoutes(r);
  return r;
}

/**
 * OVERLYX_E2E_LESSWRONG_STUB=1: LessWrong is a simulation (fake.ts) and a test plays the
 * collaborator there — makes a draft, reads it, edits a word in it, comments on a phrase.
 */
function stubRoutes(r: express.Router): void {
  const g = new FakeLessWrong();
  setLessWrongApiFactory(() => g);
  r.post('/lesswrong/e2e/create', (req, res) => {
    const key = req.body?.key ? String(req.body.key) : null;
    const id = g.create(String(req.body?.title ?? 'Draft'), String(req.body?.markdown ?? ''), key);
    res.json({ id, url: `https://www.lesswrong.com/editPost?postId=${id}${key ? '&key=' + key : ''}` });
  });
  const postOf = (req: express.Request) => lwLinkOf(canonicalDocId(String(req.query.doc ?? req.body?.doc ?? '')))?.post_id ?? '';
  r.get('/lesswrong/e2e/post', (req, res) => {
    const id = postOf(req);
    if (!id) { res.status(404).json({ error: 'not linked' }); return; }
    res.json({ markdown: g.markdown(id), threads: g.threads(id) });
  });
  r.post('/lesswrong/e2e/edit', (req, res) => {
    try { g.edit(postOf(req), String(req.body.from), String(req.body.to)); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });
  r.post('/lesswrong/e2e/comment', (req, res) => {
    try { res.json({ id: g.comment(postOf(req), String(req.body.quote), String(req.body.content), String(req.body.by ?? 'Kirsten')) }); } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });
}

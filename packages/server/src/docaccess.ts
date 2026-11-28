/**
 * Who may use a document route (`/docs/<id>/<action>`). Each route says what it needs where it is
 * registered — `needDoc('view')` to read the document, `needDoc('edit')` to change it (building a PDF
 * only reads it, so viewers may) — and the document is the route's own `*`: Express has matched the
 * action already, so the id checked and the id used cannot differ. Handlers get it from `docId(req)`,
 * which only the check sets: a route registered without the check has no document to work on.
 * (tests/docs-routes.test.ts holds every route's role.)
 */
import type express from 'express';
import { projectOfDoc, docPathOf } from '@overlyx/core';
import { roleFor, roleAt, atLeast, type Role } from './access.ts';
import { canonicalDocId } from './namespaces.ts';
import { findMaster } from './projectfiles.ts';
import { isE2eProject, E2eRefusal } from './e2e/store.ts';

export function deny(res: express.Response, role: Role | null): void {
  res.status(403).json({ error: role ? 'You can only view this project' : 'You do not have access to this project (ask its owner to share it with you)' });
}

export function refuseE2e(res: express.Response): void {
  res.status(403).json({ error: new E2eRefusal().message, code: 'e2e' });
}

const checked = new WeakMap<express.Request, string>();

/** The document of a /docs route (under its current key, also when the id is from before its project moved — namespaces.ts), as its access check found it. */
export function docId(req: express.Request): string {
  const id = checked.get(req);
  if (id === undefined) throw new Error('a document route without its access check (docaccess.ts needDoc)');
  return id;
}

/**
 * A document route: the user needs at least `min` in the document's project — or in the document
 * through a folder of the project shared with them on their own (access.ts roleAt). `built`: the
 * route is about the document's build (its PDF, its job, its SyncTeX, its layout check); someone
 * with only a folder does not see the build of a master document outside it.
 */
export const needDoc = (min: 'view' | 'edit', opts: { built?: true } = {}) => (req: express.Request, res: express.Response, next: express.NextFunction): void => {
  let id: string;
  // (Express has decoded the path once — the id's slashes come encoded — so it is not decoded again: a file named with a % is that file)
  try { id = canonicalDocId(String((req.params as Record<string, string>)[0] ?? '')); } catch { res.status(400).json({ error: 'bad document id' }); return; }
  const project = projectOfDoc(id);
  let role = roleFor(req.user!, project);
  if (!atLeast(role, min)) {
    // a document in a folder shared with the user on their own
    const at = roleAt(req.user!, project, docPathOf(id));
    if (!atLeast(at, min)) { deny(res, at ?? role); return; }
    const master = opts.built ? findMaster(project, docPathOf(id)) : null;
    if (master && !roleAt(req.user!, project, master)) { res.status(403).json({ error: `This document is built through ${master}, which is not shared with you` }); return; }
    req.partial = !role;
    role = at;
  }
  // an end-to-end encrypted project's documents are ciphertext the server cannot open
  if (isE2eProject(project)) { refuseE2e(res); return; }
  req.role = role!;
  checked.set(req, id);
  next();
};

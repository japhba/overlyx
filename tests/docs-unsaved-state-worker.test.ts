/**
 * Edits stored but not yet written to the file survive a restart (in a document worker): the cases are in
 * docs-unsaved-state.cases.ts.
 */
import { vi } from 'vitest';
import { rmSync } from 'node:fs';

const ROOT = vi.hoisted(() => {
  const root = (process.env.TMPDIR ?? '/tmp') + '/overlyx-unsaved-state-worker-test';
  process.env.OVERLYX_DATA_DIR = root + '/data';
  process.env.OVERLYX_PROJECTS_DIR = root + '/projects';
  process.env.OVERLYX_DOC_WORKERS = '1';
  return root;
});
rmSync(ROOT, { recursive: true, force: true });

const { manager } = await import('../packages/server/src/docs.ts');
const { unsavedStateTests } = await import('./docs-unsaved-state.cases.ts');
unsavedStateTests(manager, ROOT);

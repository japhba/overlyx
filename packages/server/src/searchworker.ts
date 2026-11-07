/** The worker thread of the project search (projectsearch.ts): one search at a time, searchtext.ts's. */
import { parentPort } from 'node:worker_threads';
import { searchFiles, SearchError, type SearchLimits, type SearchQuery, type SearchTarget } from './searchtext.ts';

parentPort!.on('message', (m: { id: number; targets: SearchTarget[]; query: SearchQuery; limits: SearchLimits }) => {
  try {
    parentPort!.postMessage({ id: m.id, ok: true, result: searchFiles(m.targets, m.query, m.limits) });
  } catch (e) {
    parentPort!.postMessage({ id: m.id, ok: false, error: String((e as Error).message), status: e instanceof SearchError ? e.status : 500 });
  }
});

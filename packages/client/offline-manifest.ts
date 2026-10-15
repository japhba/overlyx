import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** Finalize the runtime after its bundle and MathJax files have been copied.
 * Their URLs are stable, so content must participate in the offline version. */
export function finalizeOfflineRuntime(distRoot: string): void {
  const runtimeRoot = path.join(distRoot, '_ol');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() && entry.name.endsWith('.js')) files.push('/' + path.relative(distRoot, absolute).split(path.sep).join('/'));
    }
  };
  walk(runtimeRoot);
  files.sort();
  const bootstrap = '/_ol/offline-frame.html';
  const cachedFiles = [...files, ...(fs.existsSync(path.join(distRoot, bootstrap.slice(1))) ? [bootstrap] : [])].sort();
  const content = createHash('sha256');
  for (const file of cachedFiles) {
    const bytes = fs.readFileSync(path.join(distRoot, file.slice(1)));
    // Length-delimit the bytes so paths and contents cannot share a boundary.
    content.update(JSON.stringify([file, bytes.length])).update('\0').update(bytes).update('\0');
  }
  const version = content.digest('hex');
  const workerPath = path.join(distRoot, 'sw.js');
  let worker: string | undefined;
  if (fs.existsSync(workerPath)) {
    worker = fs.readFileSync(workerPath, 'utf8');
    const precacheLines = worker.match(/^const PRECACHE\b[^\n]*$/gm) ?? [];
    const versionLines = worker.match(/^const VERSION\b[^\n]*$/gm) ?? [];
    const precacheMatch = precacheLines.length === 1 && /^const PRECACHE = (\[[^\r\n]*\]);(\r?)$/.exec(precacheLines[0]);
    const versionMatch = versionLines.length === 1 && /^const VERSION = '[a-f0-9]+';(\r?)$/.exec(versionLines[0]);
    if (!precacheMatch || !versionMatch) throw new Error(`Invalid generated offline constants in ${workerPath}`);
    let existing: unknown;
    try { existing = JSON.parse(precacheMatch[1]); }
    catch { throw new Error(`Invalid generated PRECACHE in ${workerPath}`); }
    if (!Array.isArray(existing) || existing.some(file => typeof file !== 'string' || !file.startsWith('/'))) throw new Error(`Invalid generated PRECACHE paths in ${workerPath}`);
    // Replace earlier runtime entries on a repeated runtime build; deleted
    // modules must not leave URLs that make service-worker installation fail.
    const precache = [...new Set([...existing.filter(file => !file.startsWith('/_ol/')), ...cachedFiles, '/_ol/offline.json'])].sort();
    const workerVersion = createHash('sha256').update(JSON.stringify(precache)).update('\0').update(version).digest('hex').slice(0, 12);
    worker = worker.replace(precacheLines[0], () => `const PRECACHE = ${JSON.stringify(precache)};${precacheMatch[2]}`)
      .replace(versionLines[0], () => `const VERSION = '${workerVersion}';${versionMatch[1]}`);
  }
  // Validate a known worker before creating either output, so a malformed
  // generated build cannot appear to have been successfully finalized.
  fs.writeFileSync(path.join(runtimeRoot, 'offline.json'), JSON.stringify({ version, files }) + '\n');
  if (worker !== undefined) fs.writeFileSync(workerPath, worker);
}

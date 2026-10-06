/**
 * Which files are open in OverLyX editors right now, across VS Code windows: each extension host
 * writes its list to `<agents dir>/open/<pid>.json` (host/agents.ts), with the address of its local
 * bridge (host/bridge.ts, token included — the file is the user's alone); the local tool server
 * reads them (lists of windows that are gone are ignored). A file open in an editor is an OverLyX
 * document for the tools even without OverLyX's marks in it (a markdown file), and its edits go
 * through that window, so they apply to what the user sees, unsaved typing included.
 */
import fs from 'node:fs';
import path from 'node:path';

const openDir = (agentsDir: string) => path.join(agentsDir, 'open');

/** This window's open documents (absolute paths) and where it takes agents' edits of them; an empty list removes its file. */
export function publishOpenDocuments(agentsDir: string, files: string[], endpoint?: string, pid = process.pid): void {
  const file = path.join(openDir(agentsDir), `${pid}.json`);
  if (!files.length) { fs.rmSync(file, { force: true }); return; }
  fs.mkdirSync(openDir(agentsDir), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ pid, endpoint, files }), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };

/** Every file open in an OverLyX editor of a running VS Code window → that window's endpoint for agents' edits (if it gave one). */
export function openDocuments(agentsDir: string | undefined): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  if (!agentsDir) return out;
  let names: string[];
  try { names = fs.readdirSync(openDir(agentsDir)).filter(n => n.endsWith('.json')); } catch { return out; }
  for (const n of names) {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(openDir(agentsDir), n), 'utf8')) as { pid: number; endpoint?: string; files: string[] };
      if (alive(v.pid)) for (const f of v.files) out.set(path.resolve(f), typeof v.endpoint === 'string' ? v.endpoint : undefined);
    } catch { /* being rewritten, or not ours */ }
  }
  return out;
}

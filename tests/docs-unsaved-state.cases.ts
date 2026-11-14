/**
 * The cases of docs-unsaved-state(.worker).test.ts — edits the server stored (the Yjs state, within a
 * second) but had not written to the file (1.5–10 s later) when it stopped: after a hard kill, or a
 * save that kept failing. The next open used to load the file over them ("parser normalisation"), so
 * they were reverted, and the revert reached every editor that reconnected. Now the stored state says
 * whether the file has it (table `ydocs_saved`): an unsaved state is kept and written, and a file that
 * changed meanwhile is merged into it three-way against the file text the state was based on.
 * Run on the main thread and in a document worker.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as Y from 'yjs';

type Manager = typeof import('../packages/server/src/docs.ts')['manager'];

export function unsavedStateTests(manager: Manager, root: string): void {
  const dir = join(root, 'projects', 'u', 'p');
  mkdirSync(dir, { recursive: true });
  const restart = (doc: unknown) => (manager as any).forgetDoc(doc);
  const sync = (a: Y.Doc, b: Y.Doc) => {
    const ua = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)), ub = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a));
    Y.applyUpdate(b, ua); Y.applyUpdate(a, ub);
  };
  async function waitFor(f: () => boolean, ms = 10000): Promise<boolean> {
    for (const t0 = Date.now(); Date.now() - t0 < ms; await new Promise(r => setTimeout(r, 50))) if (f()) return true;
    return f();
  }
  afterEach(() => { try { chmodSync(dir, 0o755); } catch { /* gone */ } });

  for (const kind of ['tex', 'md'] as const) {
    const text = (...pars: string[]) => kind === 'tex'
      ? '\\documentclass{article}\n\\begin{document}\n' + pars.map(t => `${t}\n\n`).join('') + '\\end{document}\n'
      : '# Title\n\n' + pars.join('\n\n') + '\n';
    let n = 0;
    /** a fresh document of three paragraphs, opened */
    async function fresh() {
      const name = `d${++n}.${kind}`;
      writeFileSync(join(dir, name), text('Alpha one.', 'Beta two.', 'Gamma three.'));
      const id = `u/p/${name}`;
      return { id, file: join(dir, name), doc: await manager.open(id) };
    }
    const edit = (doc: Awaited<ReturnType<Manager['open']>>, ...pars: string[]) => doc.loadFromLyx(doc.parse(text(...pars)), 'test');

    describe(`${kind}: edits stored but not written when the server stopped`, () => {
      it('a restart after a kill: kept, written to the file, and an editor that reconnects keeps them', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const { id, file, doc } = await fresh();
        const editor = new Y.Doc();
        sync(editor, doc.ydoc);
        edit(doc, 'Alpha one.', 'Beta two EDITED HERE.', 'Gamma three.');
        sync(editor, doc.ydoc);
        doc.persistState();                      // the persist timer ran; the save did not
        restart(doc);
        expect(readFileSync(file, 'utf8')).not.toContain('EDITED HERE');
        const again = await manager.open(id);
        expect(again.toText()).toContain('EDITED HERE');
        sync(editor, again.ydoc);
        expect(again.toText()).toContain('EDITED HERE');
        expect(await waitFor(() => readFileSync(file, 'utf8').includes('EDITED HERE'))).toBe(true);
        expect(readFileSync(file, 'utf8')).toBe(text('Alpha one.', 'Beta two EDITED HERE.', 'Gamma three.'));
        // written: stored as saved again, so the next open is the usual one (nothing to write)
        await again.saveToFile();
        restart(again);
        const third = await manager.open(id);
        expect(third.dirty).toBe(false);
        expect(third.toText()).toContain('EDITED HERE');
        restart(third);
      });

      it('a save that failed, then a restart: kept and written once the file can be written', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const { id, file, doc } = await fresh();
        chmodSync(dir, 0o555);
        edit(doc, 'Alpha one.', 'Beta two AN HOUR OF WORK.', 'Gamma three.');
        expect(await doc.saveToFile()).toBe(false);
        doc.persistState();
        restart(doc);                            // a restart (or a deploy) while the disk is full
        chmodSync(dir, 0o755);
        const again = await manager.open(id);
        expect(again.toText()).toContain('AN HOUR OF WORK');
        expect(await waitFor(() => readFileSync(file, 'utf8').includes('AN HOUR OF WORK'))).toBe(true);
        restart(again);
      });

      it('the normal path: a saved state of an unchanged file opens as it was, nothing to write', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const { id, file, doc } = await fresh();
        edit(doc, 'Alpha one.', 'Beta two saved.', 'Gamma three.');
        expect(await doc.saveToFile()).toBe(true);
        restart(doc);
        const bytes = readFileSync(file, 'utf8'), mtime = statSync(file).mtimeMs;
        const again = await manager.open(id);
        expect(again.toText()).toContain('Beta two saved.');
        expect(again.dirty).toBe(false);
        await new Promise(r => setTimeout(r, 300));
        expect(readFileSync(file, 'utf8')).toBe(bytes);
        expect(statSync(file).mtimeMs).toBe(mtime);
        restart(again);
      });

      it('the file changed while closed, the stored state saved: the file is what opens', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const { id, file, doc } = await fresh();
        edit(doc, 'Alpha one.', 'Beta two saved.', 'Gamma three.');
        expect(await doc.saveToFile()).toBe(true);
        restart(doc);
        writeFileSync(file, text('Alpha one.', 'Beta two saved.', 'Gamma three CHANGED ON DISK.'));
        const again = await manager.open(id);
        expect(again.toText()).toContain('CHANGED ON DISK');
        expect(again.toText()).toContain('Beta two saved.');
        expect(again.dirty).toBe(false);
        restart(again);
      });

      it('the file changed while closed, the stored state not saved: both changes, merged three-way', async () => {
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const { id, file, doc } = await fresh();
        edit(doc, 'Alpha one EDITED HERE.', 'Beta two.', 'Gamma three.');
        doc.persistState();
        restart(doc);
        writeFileSync(file, text('Alpha one.', 'Beta two.', 'Gamma three CHANGED ON DISK.'));
        const again = await manager.open(id);
        expect(again.toText()).toContain('EDITED HERE');
        expect(again.toText()).toContain('CHANGED ON DISK');
        expect(await waitFor(() => readFileSync(file, 'utf8').includes('EDITED HERE'))).toBe(true);
        expect(readFileSync(file, 'utf8')).toBe(text('Alpha one EDITED HERE.', 'Beta two.', 'Gamma three CHANGED ON DISK.'));
        restart(again);
      });
    });
  }
}

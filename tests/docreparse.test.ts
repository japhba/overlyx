/**
 * A document whose stored Yjs state was parsed by an older parser heals on the next cold open:
 * when the file bytes are unchanged but the current parser structures them differently (here:
 * \begin{definition} became a theorem layout once \newtheorem support shipped, where the stored
 * state still holds it as ERT), the fresh structure is folded in as a diff and the history's
 * epoch survives. Regression test for the paragraph-count-only comparison that missed this.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as Y from 'yjs';

const scratch = mkdtempSync(join(tmpdir(), 'ol-reparse-'));
process.env.OVERLYX_DATA_DIR = join(scratch, 'data');
process.env.OVERLYX_PROJECTS_DIR = join(scratch, 'projects');
mkdirSync(process.env.OVERLYX_DATA_DIR, { recursive: true });
mkdirSync(join(scratch, 'projects', 'p'), { recursive: true });

const sha1 = (t: string) => createHash('sha1').update(t).digest('hex');

afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });

describe('cold open re-parses when the parser learnt new structure', () => {
  it('ERT \\begin{definition} becomes a Definition layout, same bytes, same epoch', async () => {
    const { parseTex, writeTex } = await import('../packages/core/src/tex/index.ts');
    const raw = `\\documentclass{article}
\\usepackage{amsthm}
\\newtheorem{definition}{Definition}

\\begin{document}

\\begin{definition}[Montague]
A definition with $x$.
\\end{definition}

Plain text after.

\\end{document}
`;
    // normal form, so that the healed state writes the file byte-identically
    const text = writeTex(parseTex(raw).doc).text;
    const abs = join(scratch, 'projects', 'p', 'paper.tex');
    writeFileSync(abs, text);

    // the "old parser's" state: without the \newtheorem declarations the environment is ERT
    const stale = parseTex(text.replace(/\\newtheorem\{definition\}\{Definition\}\n/, '')).doc;
    expect(JSON.stringify(stale.body)).toContain('ERT');

    // server modules only after the env points at the scratch dirs
    const { DocManager } = await import('../packages/server/src/docs.ts');
    const { applyLyxDocument } = await import('../packages/server/src/ydiff.ts');
    const { db } = await import('../packages/server/src/db.ts');
    const ydoc = new Y.Doc();
    applyLyxDocument(ydoc, stale, 'test');
    const epoch = 'cafe0123deadbeef';
    db.prepare('INSERT INTO ydocs (id, state, file_hash, updated_at, epoch) VALUES (?,?,?,?,?)')
      .run('p/paper.tex', Buffer.from(Y.encodeStateAsUpdate(ydoc)), sha1(text), Date.now(), epoch);

    const dm = new DocManager();
    try {
      const doc = await dm.open('p/paper.tex');
      const layouts = doc.toLyxDocument().body.map(par => par.layout);
      expect(layouts).toContain('Definition');                    // healed
      expect(doc.epoch).toBe(epoch);                              // by merging, not by starting over
      expect(sha1(doc.toText())).toBe(sha1(text));                // and the file stays as it is
    } finally {
      (dm as unknown as { watcher: { close(): Promise<void> } | null }).watcher?.close();
    }
  });
});

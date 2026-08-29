/**
 * "Escalate to AI" document repair (packages/server/src/airepair.ts) against a stub of the
 * OpenRouter chat completions API: the request carries the broken file + detected issues, the
 * response (after stripping any markdown fence) becomes the proposed fix; nothing is applied to
 * the document until OpenDoc.applyAiRepair is called explicitly (the merge editor's "Apply").
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import express from 'express';

const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), 'overlyx-airepair-test');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'projects', 'p'), { recursive: true });
process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');
process.env.OVERLYX_PROJECTS_DIR = join(ROOT, 'projects');

// --- an OpenRouter chat-completions stub
let lastRequest: any = null;
let nextReply = 'FALLBACK — no reply queued';
let failNext = false;
const stub = express();
stub.use(express.json());
stub.post('/chat/completions', (req, res) => {
  if (req.headers.authorization !== 'Bearer test-key') { res.status(401).json({ error: 'bad key' }); return; }
  if (failNext) { failNext = false; res.status(500).json({ error: 'upstream is down' }); return; }
  lastRequest = req.body;
  res.json({ choices: [{ message: { content: nextReply } }] });
});
const stubServer = http.createServer(stub);
await new Promise<void>(r => stubServer.listen(0, '127.0.0.1', r));
const port = (stubServer.address() as { port: number }).port;
process.env.OPENROUTER_API_URL = `http://127.0.0.1:${port}`;
process.env.OPENROUTER_API_KEY = 'test-key';
process.env.OPENROUTER_REPAIR_MODEL = 'anthropic/claude-opus-5';

const { requestAiRepair, AiRepairError } = await import('../packages/server/src/airepair.ts');
const { manager } = await import('../packages/server/src/docs.ts');
const { checkTexHealth } = await import('../packages/core/src/tex/index.ts');

afterAll(() => { stubServer.close(); rmSync(ROOT, { recursive: true, force: true }); });

const file = (name: string) => join(ROOT, 'projects', 'p', name);

describe('requestAiRepair', () => {
  it('sends the file and the detected issues, and returns the model reply verbatim', async () => {
    nextReply = '\\documentclass{article}\n\\begin{document}\nfixed\n\\end{document}\n';
    const broken = '\\documentclass{article}\n\\begin{document}\nbroken\n';
    const issues = checkTexHealth(broken);
    const proposed = await requestAiRepair(broken, issues);
    expect(proposed).toBe(nextReply.trim());
    expect(lastRequest.model).toBe('anthropic/claude-opus-5');
    expect(lastRequest.messages[1].content).toContain('broken');
    expect(lastRequest.messages[1].content).toContain('document-boundary');
    expect(lastRequest.messages[0].content).toContain('OverLyX'); // the target spec, in the system message
  });

  it('strips a markdown code fence around the reply', async () => {
    nextReply = '```latex\n\\documentclass{article}\n\\begin{document}\nfixed\n\\end{document}\n```';
    const proposed = await requestAiRepair('broken', []);
    expect(proposed).not.toContain('```');
    expect(proposed).toContain('fixed');
  });

  it('throws AiRepairError on an empty reply', async () => {
    nextReply = '   ';
    await expect(requestAiRepair('broken', [])).rejects.toBeInstanceOf(AiRepairError);
  });

  it('throws AiRepairError on a non-2xx response from OpenRouter', async () => {
    failNext = true;
    await expect(requestAiRepair('broken', [])).rejects.toBeInstanceOf(AiRepairError);
  });
});

describe('OpenDoc.applyAiRepair (the merge editor\'s Apply)', () => {
  it('applies the reviewed proposal and snapshots the pre-repair text as a version', async () => {
    writeFileSync(file('a.tex'), '\\documentclass{article}\n\\begin{document}\noriginal broken\n');
    const doc = await manager.open('p/a.tex');
    const original = doc.fileText!;
    const proposed = '\\documentclass{article}\n\\begin{document}\nrepaired\n\\end{document}\n';
    const r = doc.applyAiRepair(proposed, original);
    expect(r.ok).toBe(true);
    expect(doc.toText()).toContain('repaired');
    await doc.saveToFile();
    expect(readFileSync(file('a.tex'), 'utf8')).toContain('repaired');
    const { db } = await import('../packages/server/src/db.ts');
    const v = db.prepare("SELECT lyx FROM versions WHERE doc_id = ? AND name = 'before AI repair'").get('p/a.tex') as { lyx: string } | undefined;
    expect(v?.lyx).toBe(original);
  });

  it('refuses to apply when the file changed since the proposal was generated (race guard)', async () => {
    writeFileSync(file('b.tex'), '\\documentclass{article}\n\\begin{document}\nv1\n\\end{document}\n');
    const doc = await manager.open('p/b.tex');
    const staleOriginal = doc.fileText!;
    // the file changes on disk (or the CRDT is edited) after the proposal was fetched, before Apply
    writeFileSync(file('b.tex'), '\\documentclass{article}\n\\begin{document}\nv2 (someone else edited)\n\\end{document}\n');
    doc.absorbExternalChange();
    const r = doc.applyAiRepair('\\documentclass{article}\n\\begin{document}\nproposed from stale v1\n\\end{document}\n', staleOriginal);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/changed/);
    expect(doc.toText()).toContain('v2');
  });
});

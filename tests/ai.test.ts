/**
 * AI assistance (packages/server/src/ai.ts) against a stub of the OpenRouter chat API: the
 * selection ↔ LaTeX conversions, the prompts (document context with the passage marked, macros),
 * the reply handling (fences, leading space of a completion, parsed nodes), the rate limiter.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import express from 'express';

const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), 'overlyx-ai-test');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'projects', 'p'), { recursive: true });
process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');
process.env.OVERLYX_PROJECTS_DIR = join(ROOT, 'projects');

let lastRequest: any = null;
let nextReply = '';
let failNext = false;
const stub = express();
stub.use(express.json({ limit: '10mb' }));
stub.post('/chat/completions', (req, res) => {
  if (req.headers.authorization !== 'Bearer test-key') { res.status(401).json({ error: 'bad key' }); return; }
  if (failNext) { failNext = false; res.status(500).json({ error: 'down' }); return; }
  lastRequest = req.body;
  res.json({ choices: [{ message: { content: nextReply } }] });
});
const stubServer = http.createServer(stub);
await new Promise<void>(r => stubServer.listen(0, '127.0.0.1', r));
const port = (stubServer.address() as { port: number }).port;
process.env.OPENROUTER_API_URL = `http://127.0.0.1:${port}`;
process.env.OPENROUTER_API_KEY = 'test-key';
process.env.OVERLYX_AI_MODEL = 'google/gemini-test';

const ai = await import('../packages/server/src/ai.ts');
const { manager } = await import('../packages/server/src/docs.ts');

afterAll(() => { stubServer.close(); rmSync(ROOT, { recursive: true, force: true }); });

const file = (name: string) => join(ROOT, 'projects', 'p', name);
const PAPER = `\\documentclass{article}
\\newcommand{\\bW}{\\mathbf{W}}
\\begin{document}
\\section{Introduction}

Recurrent networks with weights $\\bW$ show rich dynamics. We study the Lyapunov exponent $\\lambda$ of such networks.

The variance of the weights is $\\sigma^2$, and the gain $g$ controls the transition to chaos.
\\end{document}
`;
writeFileSync(file('paper.tex'), PAPER);
const doc = await manager.open('p/paper.tex');

const par = (text: string) => ({ type: 'paragraph', attrs: { layout: 'Standard', depth: 0 }, content: [{ type: 'text', text }] });

describe('selection ↔ LaTeX', () => {
  it('writes inline content (text + formula) as LaTeX', () => {
    const tex = ai.selectionToTex(doc, [{ type: 'text', text: 'the gain ' }, { type: 'math_inline', attrs: { latex: 'g', delim: '$' } }, { type: 'text', text: ' controls it' }]);
    expect(tex).toBe('the gain $g$ controls it');
  });
  it('writes whole paragraphs, without the settings line', () => {
    const tex = ai.selectionToTex(doc, [par('First paragraph.'), par('Second one.')]);
    expect(tex).toBe('First paragraph.\n\nSecond one.');
    expect(tex).not.toContain('overlyx-settings');
  });
  it('parses LaTeX into editor nodes (formulas become math_inline nodes)', () => {
    const nodes = ai.texToPm(doc, 'The exponent $\\lambda > 0$ grows.');
    expect(nodes).toHaveLength(1);
    const types = nodes[0].content!.map(n => n.type);
    expect(types).toEqual(['text', 'math_inline', 'text']);
    expect(nodes[0].content![1].attrs!.latex).toBe('\\lambda > 0');
  });
});

describe('locate (whitespace-insensitive search)', () => {
  it('finds a passage that the writer re-wrapped', () => {
    const hay = 'alpha beta\ngamma delta epsilon\nzeta';
    const r = ai.locate(hay, 'beta gamma   delta');
    expect(r).not.toBeNull();
    expect(hay.slice(r!.start, r!.end)).toBe('beta\ngamma delta');
  });
  it('returns null when absent', () => { expect(ai.locate('abc', 'xyz')).toBeNull(); });
});

describe('rewrite', () => {
  it('sends the document with the passage marked and the macros, and returns parsed nodes', async () => {
    nextReply = 'The gain $g$ governs the onset of chaos.';
    const r = await ai.rewrite(doc, { instruction: 'make it crisper', content: [{ type: 'text', text: 'the gain ' }, { type: 'math_inline', attrs: { latex: 'g', delim: '$' } }, { type: 'text', text: ' controls the transition to chaos' }] });
    expect(r.original).toBe('the gain $g$ controls the transition to chaos');
    expect(r.tex).toBe(nextReply);
    expect(r.nodes[0].content!.map(n => n.type)).toEqual(['text', 'math_inline', 'text']);
    expect(lastRequest.model).toBe('google/gemini-test');
    const user = lastRequest.messages[1].content as string;
    // the writer wraps lines at ~80 columns: the markers sit around the re-wrapped passage
    expect(user.replace(/\s+/g, ' ')).toContain('⟦SELECTION⟧the gain $g$ controls the transition to chaos⟦/SELECTION⟧');
    expect(user).toContain('\\bW = \\mathbf{W}');
    expect(user).toContain('make it crisper');
    expect(lastRequest.messages[0].content).toContain('OverLyX');
  });
  it('strips a code fence and handles an empty selection (insert at cursor)', async () => {
    nextReply = '```latex\nWe conclude with an outlook.\n```';
    const r = await ai.rewrite(doc, { instruction: 'write a closing sentence', content: [] });
    expect(r.tex).toBe('We conclude with an outlook.');
    expect(r.original).toBe('');
    expect(lastRequest.messages[1].content).toContain('(empty — insert new text at the cursor)');
  });
  it('rewrites a formula: math LaTeX without delimiters', async () => {
    nextReply = '$\\frac{1}{2}\\sigma^{2}$';
    const r = await ai.rewrite(doc, { instruction: 'as a fraction', content: [], math: { latex: '\\sigma^2/2', display: false } });
    expect(r.tex).toBe('\\frac{1}{2}\\sigma^{2}');
    expect(r.nodes).toEqual([]);
    expect(lastRequest.messages[1].content).toContain('\\sigma^2/2');
  });
  it('rejects an empty instruction and reports upstream failures as AiError', async () => {
    await expect(ai.rewrite(doc, { instruction: '  ', content: [] })).rejects.toBeInstanceOf(ai.AiError);
    failNext = true;
    await expect(ai.rewrite(doc, { instruction: 'x', content: [] })).rejects.toBeInstanceOf(ai.AiError);
  });
});

describe('complete', () => {
  it('text: keeps a leading space, returns inline nodes with rendered math', async () => {
    nextReply = ' of the network is $\\lambda = \\log g$.';
    const r = await ai.complete(doc, { kind: 'text', before: 'The Lyapunov exponent', after: '' });
    expect(r.text).toBe(' of the network is $\\lambda = \\log g$.');
    expect(r.nodes[0]).toEqual({ type: 'text', text: ' ' });
    expect(r.nodes.map(n => n.type)).toEqual(['text', 'text', 'math_inline', 'text']);
    const user = lastRequest.messages[1].content as string;
    expect(user).toContain('The Lyapunov exponent⟦CURSOR⟧');
    expect(user).toContain('\\bW = \\mathbf{W}');
    expect(lastRequest.max_tokens).toBeLessThanOrEqual(200);
  });
  it('text: an empty / whitespace reply means no suggestion', async () => {
    nextReply = '   \n';
    const r = await ai.complete(doc, { kind: 'text', before: 'Introduction', after: '' });
    expect(r).toEqual({ text: '', nodes: [] });
  });
  it('math: strips delimiters, no nodes', async () => {
    nextReply = '$+ \\sigma^{2} g^{2}$';
    const r = await ai.complete(doc, { kind: 'math', before: '', after: '', formula: '\\lambda = \\log g ⟦CURSOR⟧', paragraph: 'We study the Lyapunov exponent' });
    expect(r).toEqual({ text: '+ \\sigma^{2} g^{2}', nodes: [] });
    expect(lastRequest.messages[0].content).toContain('formula');
    expect(lastRequest.messages[1].content).toContain('\\lambda = \\log g ⟦CURSOR⟧');
  });
});

describe('stripOverlap (the reply repeats the last word before the cursor)', () => {
  it('removes the repeated word(s) and keeps the spacing the reply had', () => {
    expect(ai.stripOverlap('In this document we', 'we explore the features.')).toBe(' explore the features.');
    expect(ai.stripOverlap('an unfinished explor', 'explore how it works')).toBe('e how it works');
    expect(ai.stripOverlap('We study the', 'study the exponent')).toBe(' exponent');
    expect(ai.stripOverlap('ends with a space ', 'space and more')).toBe('and more');
  });
  it('adds a space when nothing was repeated and both sides are word characters', () => {
    expect(ai.stripOverlap('In this document we', 'explore')).toBe(' explore');
    expect(ai.stripOverlap('In this document we', ' explore')).toBe(' explore');
    expect(ai.stripOverlap('a formula', '$x$ follows')).toBe(' $x$ follows');
    expect(ai.stripOverlap('ends with a space ', 'and more')).toBe('and more');
    expect(ai.stripOverlap('punctuation.', ' Next sentence')).toBe(' Next sentence');
  });
});

describe('rate limiter', () => {
  it('allows `limit` requests per minute per key', () => {
    expect(ai.allow('k', 2)).toBe(true);
    expect(ai.allow('k', 2)).toBe(true);
    expect(ai.allow('k', 2)).toBe(false);
    expect(ai.allow('other', 2)).toBe(true);
  });
});

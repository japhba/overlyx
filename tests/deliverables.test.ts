/**
 * HTML deliverables on the server: the live document (docs.ts HtmlDoc — the file's text as a
 * Y.Text, merged with changes on disk), the sandboxed folder route and its capability tokens
 * (deliverables.ts), and the agents' tools (mcp.ts create_deliverable, read_file / edit_file on an
 * open page, list_documents) over real HTTP. render_page runs when Chromium and the built runtime
 * are there.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import express from 'express';

const ROOT = join(process.env.OVERLYX_SCRATCH ?? tmpdir(), 'overlyx-deliverables-test');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'projects', 'owner', 'p'), { recursive: true });
process.env.OVERLYX_DATA_DIR = join(ROOT, 'data');
process.env.OVERLYX_PROJECTS_DIR = join(ROOT, 'projects');
process.env.OVERLYX_DOC_WORKERS = '0';

const { mcpRouter } = await import('../packages/server/src/mcp.ts');
const { createMcpToken } = await import('../packages/server/src/mcpTokens.ts');
const { manager, HtmlDoc } = await import('../packages/server/src/docs.ts');
const { createUser } = await import('../packages/server/src/auth.ts');
const { registerProject } = await import('../packages/server/src/access.ts');
const { mountDeliverables, deliverableToken, verifyDeliverableToken, resolveDeliverable, resolveInProject, injectRuntime } = await import('../packages/server/src/deliverables.ts');
const { config } = await import('../packages/server/src/config.ts');
const { chromium } = await import('playwright-core');

const owner = createUser('owner', 'Owner', 'pw');
registerProject('owner/p', owner.id);
const outsider = createUser('mallory', 'Mallory', 'pw');
const file = (name: string) => join(ROOT, 'projects', 'owner', 'p', name);

const app = express();
app.use('/mcp', mcpRouter());
mountDeliverables(app);
const server = http.createServer(app);
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

afterAll(async () => {
  server.close();
  const { shutdownRenderer } = await import('../packages/server/src/render.ts');
  await shutdownRenderer();
  rmSync(ROOT, { recursive: true, force: true });
});

let rpcId = 0;
async function callTool(token: string, name: string, args: unknown): Promise<any> {
  const res = await fetch(`${base}/mcp/owner/p`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await res.text();
  const line = raw.split('\n').find(l => l.startsWith('data:'));
  const body = JSON.parse(line ? line.slice(5) : raw);
  if (body.result.isError) throw new Error(body.result.content[0].text);
  return body.result;
}
const json = (r: any) => { try { return JSON.parse(r.content[0].text); } catch { return r.content[0].text; } };
const token = createMcpToken(owner.id, 'test-agent').token;

describe('agents make and edit deliverables', () => {
  it('create_deliverable starts a folder of the kind asked for, list_documents shows it', async () => {
    const r = json(await callTool(token, 'create_deliverable', { folder: 'talk', kind: 'deck', title: 'Waves' }));
    expect(r.path).toBe('talk/index.html');
    const html = readFileSync(file('talk/index.html'), 'utf8');
    expect(html).toContain('<meta name="overlyx" content="deck">');
    expect(html).toContain('<title>Waves</title>');
    await expect(callTool(token, 'create_deliverable', { folder: 'talk', kind: 'deck' })).rejects.toThrow(/exists/);
    const docs = json(await callTool(token, 'list_documents', {}));
    expect(docs.find((d: any) => d.path === 'talk/index.html')?.kind).toMatch(/^html deck/);
  });

  it('read_file and edit_file reach the live text of a page open in an editor, and it is saved', async () => {
    const doc = await manager.open('owner/p/talk/index.html');
    expect(doc).toBeInstanceOf(HtmlDoc);
    const h = doc as InstanceType<typeof HtmlDoc>;
    // somebody typing in the editor (not saved yet)
    const at = h.html.toString().indexOf('Your name');
    h.ydoc.transact(() => h.html.insert(at, 'Dr. '), 'local');
    const read = json(await callTool(token, 'read_file', { path: 'talk/index.html' }));
    expect(read.text).toContain('Dr. Your name');
    await callTool(token, 'edit_file', { path: 'talk/index.html', old_text: '<h2 style="position: absolute; left: 96px; top: 72px; width: 1088px">The idea</h2>', new_text: '<h2 style="position: absolute; left: 96px; top: 72px; width: 1088px">The wave</h2>' });
    expect(h.html.toString()).toContain('>The wave</h2>');
    expect(h.html.toString()).toContain('Dr. Your name');
    await h.saveToFile();
    const disk = readFileSync(file('talk/index.html'), 'utf8');
    expect(disk).toContain('>The wave</h2>');
    expect(disk).toContain('Dr. Your name');
  });

  it('a change on disk merges with unsaved edits elsewhere in the page', async () => {
    const h = (await manager.open('owner/p/talk/index.html')) as InstanceType<typeof HtmlDoc>;
    await h.saveToFile();
    const at = h.html.toString().indexOf('One message per slide');
    h.ydoc.transact(() => h.html.insert(at, 'Only '), 'local');
    const disk = readFileSync(file('talk/index.html'), 'utf8').replace('<title>Waves</title>', '<title>Waves and particles</title>');
    expect(h.absorbExternalChange(disk)).toBe(true);
    const t = h.html.toString();
    expect(t).toContain('<title>Waves and particles</title>');
    expect(t).toContain('Only One message per slide');
  });

  it('read_document on a page answers like read_file', async () => {
    const r = json(await callTool(token, 'read_document', { path: 'talk/index.html' }));
    expect(r.text).toContain('<!doctype html>');
  });
});

describe('the sandboxed folder', () => {
  it('tokens are signed, expire, and name one folder', () => {
    const t = deliverableToken('owner/p', 'talk', owner.id);
    expect(verifyDeliverableToken(t)).toMatchObject({ project: 'owner/p', dir: 'talk', userId: owner.id });
    expect(verifyDeliverableToken(t.slice(0, -2) + 'xx')).toBeNull();
    expect(verifyDeliverableToken(deliverableToken('owner/p', 'talk', owner.id, -1000))).toBeNull();
    const [payload, sig] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), p: 'other/x' })).toString('base64url');
    expect(verifyDeliverableToken(`${forged}.${sig}`)).toBeNull();
  });

  it('paths stay inside the project and away from .git', () => {
    expect(resolveInProject('talk', 'figures/a.png')).toBe('talk/figures/a.png');
    expect(resolveInProject('talk', '../figures/a.pdf')).toBe('figures/a.pdf');
    expect(resolveInProject('talk', '../../other/x')).toBeNull();
    expect(resolveInProject('', '.git/config')).toBeNull();
    expect(resolveInProject('talk', '../.git/HEAD')).toBeNull();
  });

  it('serves the page live with the runtime injected, sandboxed, and its files', async () => {
    writeFileSync(file('talk/style.css'), 'h1 { color: red }');
    const t = deliverableToken('owner/p', 'talk', owner.id);
    const r = await fetch(`${base}/ol-d/${t}/index.html?ol=edit`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-security-policy')).toMatch(/^sandbox allow-scripts/);
    expect(r.headers.get('content-security-policy')).not.toMatch(/allow-same-origin/);
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    const html = await r.text();
    expect(html).toMatch(/<head><meta name="referrer" content="no-referrer" data-ol-runtime><script data-ol-runtime>window.__OL=\{"mode":"edit"\}<\/script><script data-ol-runtime src="\/_ol\/runtime.js"><\/script>/);
    expect(html).toContain('Only One message per slide');   // the live text, not the file
    const css = await fetch(`${base}/ol-d/${t}/style.css`);
    expect(await css.text()).toBe('h1 { color: red }');
    expect(css.headers.get('access-control-allow-origin')).toBe('*');
    expect((await fetch(`${base}/ol-d/${t}/../../../etc/passwd`)).status).toBe(404);
    expect((await fetch(`${base}/ol-d/${t}/%2e%2e%2f%2e%2e%2fsecret`)).status).toBe(404);
    // an account without access gets nothing, whatever the token
    const m = deliverableToken('owner/p', 'talk', outsider.id);
    expect((await resolveDeliverable(m, 'index.html', {})).status).toBe(403);
  });

  it('injects the runtime whatever the page looks like', () => {
    expect(injectRuntime('<!doctype html><html><head><title>x</title></head></html>', 'T')).toBe('<!doctype html><html><head>T<title>x</title></head></html>');
    expect(injectRuntime('<html lang="en"><body>x</body></html>', 'T')).toBe('<html lang="en"><head>T</head><body>x</body></html>');
    expect(injectRuntime('<!DOCTYPE html><p>x</p>', 'T')).toBe('<!DOCTYPE html><head>T</head><p>x</p>');
  });
});

const canRender = existsSync(join(config.clientDist, '_ol', 'runtime.js')) && existsSync(chromium.executablePath());

describe.skipIf(!canRender)('render_page', () => {
  it('shows a slide as an image and reports what is wrong', async () => {
    writeFileSync(file('talk/index.html'), readFileSync(file('talk/index.html'), 'utf8').replace('</section>', '  <p style="position: absolute; left: 1200px; top: 600px; width: 300px; margin: 0">Off the edge</p>\n</section>'));
    const h = (await manager.open('owner/p/talk/index.html')) as InstanceType<typeof HtmlDoc>;
    h.absorbExternalChange();
    const r = await callTool(token, 'render_page', { path: 'talk/index.html', pages: [0, 1] });
    const text = r.content[0].text as string;
    expect(text).toMatch(/^Deck of 2 slides, 1280×720 px\./);
    expect(text).toMatch(/offpage: text of "Off the edge" runs past the slide's right/);
    const images = r.content.filter((c: any) => c.type === 'image');
    expect(images).toHaveLength(2);
    expect(Buffer.from(images[0].data, 'base64').subarray(1, 4).toString()).toBe('PNG');
  }, 60000);
});

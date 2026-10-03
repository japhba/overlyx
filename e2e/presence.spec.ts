/**
 * Presence (awareness) states from other clients are not trusted. A client — any client with access,
 * a viewer too — that sent a cursor which was not two Yjs relative positions made the cursor plugin
 * of every open editor throw inside the Yjs update handler; the binding fell out of step and the
 * next keystroke saved a nearly empty document (a 300 kB paper became 3 kB, "All changes saved").
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import { login, openDoc, collectErrors, adminCredentials, PROJECTS_DIR, BASE_URL, texDoc } from './helpers';

const PROJECT = 'admin/e2e-presence';
const DIR = `${PROJECTS_DIR}/${PROJECT}`;
const paragraphs = Array.from({ length: 120 }, (_, i) => `Paragraph ${i + 1} of a long paper, with enough words to make it a real document.`);

test.beforeAll(() => { rmSync(DIR, { recursive: true, force: true }); mkdirSync(DIR, { recursive: true }); writeFileSync(`${DIR}/main.tex`, texDoc(paragraphs.join('\n\n'))); });
test.afterAll(() => rmSync(DIR, { recursive: true, force: true }));

test('a malformed cursor from another client neither breaks the editor nor empties the document', async ({ page, playwright }) => {
  test.setTimeout(90000);
  const errors = collectErrors(page);
  await login(page);
  await openDoc(page, `${PROJECT}/main.tex`);
  await expect(page.locator('.save-state')).toContainText('All changes saved');

  // a raw client of the same document announcing a cursor in a shape nothing can read
  const api = await playwright.request.newContext({ baseURL: BASE_URL });
  expect((await api.post('/api/auth/login', { data: adminCredentials() })).ok()).toBe(true);
  const cookie = (await api.storageState()).cookies.map(c => `${c.name}=${c.value}`).join('; ');
  const ydoc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(ydoc);
  const ws = new WebSocket(`${BASE_URL.replace(/^http/, 'ws')}/ws?doc=${encodeURIComponent(`${PROJECT}/main.tex`)}`, { headers: { cookie, origin: BASE_URL } });
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
  const send = (type: number, write: (enc: encoding.Encoder) => void) => { const enc = encoding.createEncoder(); encoding.writeVarUint(enc, type); write(enc); ws.send(encoding.toUint8Array(enc)); };
  send(0, enc => syncProtocol.writeSyncStep1(enc, ydoc));
  const announce = () => {
    awareness.setLocalState({ user: { name: 'Mallory', color: '#f0f' }, cursor: { para: 3, t: Date.now() } });
    send(1, enc => encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, [ydoc.clientID])));
  };
  announce();
  const timer = setInterval(announce, 400);
  try {
    await page.waitForTimeout(1500);
    const first = page.locator('.lyx-editor > .lyx-par').first();
    await first.click();
    await page.keyboard.press('End');
    await page.keyboard.type(' TYPED-AFTER-THE-BAD-CURSOR');
    await expect(page.locator('.save-state')).toContainText('All changes saved', { timeout: 20000 });
  } finally { clearInterval(timer); ws.close(); await api.dispose(); }

  const text = readFileSync(`${DIR}/main.tex`, 'utf8');
  expect(text).toContain('TYPED-AFTER-THE-BAD-CURSOR');
  for (const p of [paragraphs[0], paragraphs[60], paragraphs[119]]) expect(text).toContain(p);
  expect(errors.filter(e => /reading 'type'|Caught error while handling a Yjs update/.test(e))).toEqual([]);
});

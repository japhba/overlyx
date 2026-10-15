/** Toolbar styling must retain the selected object's identity across a coauthor's sibling deletion. */
import { test, expect, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { userCredentials, collectErrors } from './helpers';
import { nativePointReference } from './native-style-geometry';

const owner = process.env.OVERLYX_STYLE_OWNER ?? 'betaposter';
const coauthor = process.env.OVERLYX_STYLE_COAUTHOR ?? 'betadeck';
const first = 'FIRST BOX — deleted by coauthor';
const second = 'SECOND BOX — selected for styling';
const third = 'THIRD BOX — must retain its style';
const slide = (page: Page) => page.frameLocator('.dl-frame').locator('section.slide').first();
const box = (page: Page, value: string) => slide(page).locator(':scope > p').filter({ hasText: value });
type SourceMessage = { ol: 'source'; version: number; html: string };
type SourceGate = { hold: boolean; messages: SourceMessage[] };
type SelectionProof = { version: number; items: { path: number[]; label: string }[] };

async function signIn(page: Page, username: string) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const fallback = page.locator('[data-password-login]');
  if (await fallback.count()) await fallback.click();
  const credentials = userCredentials(username);
  await page.getByPlaceholder('Username').fill(credentials.username);
  await page.getByPlaceholder('Password').fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('[data-new-project]')).toBeVisible();
  const tour = page.locator('.tour-card button').filter({ hasText: 'Not now' });
  if (await tour.count()) await tour.click();
}

async function drawText(page: Page, y: number, value: string) {
  await page.locator('[data-tb="dk-text"]').click();
  const b = await slide(page).boundingBox();
  if (!b) throw new Error('Deck canvas has no visible geometry');
  await page.mouse.move(b.x + b.width * .1, b.y + b.height * y);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * .85, b.y + b.height * (y + .1), { steps: 8 });
  await page.mouse.up();
  await page.keyboard.type(value, { delay: 0 });
  await page.keyboard.press('Escape');
  await expect(box(page, value)).toHaveText(value);
}

const style = (page: Page, value: string) => box(page, value).evaluate(el => {
  const css = getComputedStyle(el);
  return { color: css.color, fontSize: css.fontSize, inline: el.getAttribute('style') };
});

test('toolbar colour and point size target the selected box after a coauthor deletes an earlier sibling', async ({ browser }, info) => {
  test.setTimeout(120000);
  // This regression creates and shares a real project through the GUI. Refuse production defaults.
  for (const key of ['OVERLYX_E2E_BASE', 'OVERLYX_PROJECTS_DIR', 'OVERLYX_E2E_CREDENTIALS']) {
    if (!process.env[key]) throw new Error(`${key} must identify an isolated test instance`);
  }
  const contexts = await Promise.all([
    browser.newContext({ baseURL: process.env.OVERLYX_E2E_BASE }),
    browser.newContext({ baseURL: process.env.OVERLYX_E2E_BASE }),
  ]);
  const [a, b] = await Promise.all(contexts.map(context => context.newPage()));
  const errorsA = collectErrors(a), errorsB = collectErrors(b);
  try {
    // Install before the runtime listener; a late listener on Window can observe a message
    // only after its source was already reconciled. The gate stays off throughout authoring.
    await a.addInitScript(() => {
      if (window === window.top) return;
      const gate: SourceGate = { hold: false, messages: [] };
      (window as unknown as { __deckStyleSourceGate: SourceGate }).__deckStyleSourceGate = gate;
      addEventListener('message', event => {
        if (event.source !== window.parent || event.data?.ol !== 'source' || !gate.hold) return;
        gate.messages.push(event.data);
        event.stopImmediatePropagation();
      }, true);
    });
    await signIn(a, owner);
    const name = `e2e-style-concurrency-${Date.now().toString(36)}-${info.project.name}`;
    await a.locator('[data-new-project]').click();
    await a.locator('[data-new-kind="deck"]').click();
    await a.locator('[data-new-name]').fill(name);
    await a.locator('[data-new-create]').click();
    await expect(slide(a)).toBeVisible();
    await expect(a.locator('.dl-status')).toHaveText('Saved');
    await a.locator('[data-tb="dk-select"]').click();
    await a.keyboard.press('Control+a');
    await a.keyboard.press('Delete');
    await expect(slide(a).locator(':scope > *')).toHaveCount(0);
    await drawText(a, .2, first);
    await drawText(a, .43, second);
    await drawText(a, .66, third);
    await expect(slide(a).locator(':scope > p')).toHaveCount(3);
    await expect(a.locator('.dl-status')).toHaveText('Saved');
    const projectUrl = a.url();
    const file = `${process.env.OVERLYX_PROJECTS_DIR}/${owner}/${name}/slides/index.html`;
    const savedSource = () => readFileSync(file, 'utf8');

    // Share through the visible dialog; neither a fixture project nor an editor/API edit is seeded.
    await a.getByRole('button', { name: 'Share', exact: true }).click();
    const share = a.getByRole('dialog', { name: /^Share / });
    await share.getByPlaceholder('Username or e-mail address').fill(coauthor);
    await share.locator('.share-add select').selectOption('edit');
    await share.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(share.locator(`[data-member="${coauthor}"]`)).toBeVisible();
    await share.getByRole('button', { name: 'Close', exact: true }).click();
    await signIn(b, coauthor);
    await b.goto(projectUrl);
    await expect(box(b, third)).toBeVisible();
    await expect(b.locator('.dl-status')).toHaveText('Saved');
    const thirdBefore = await style(b, third);

    // Read-only protocol proof: the canvas reports the source version used by its numeric path.
    await a.evaluate(() => {
      addEventListener('message', event => {
        const frame = document.querySelector<HTMLIFrameElement>('.dl-frame');
        if (event.source !== frame?.contentWindow || event.data?.ol !== 'selection') return;
        (window as unknown as { __styleSelectionProof: SelectionProof }).__styleSelectionProof = {
          version: event.data.version,
          items: event.data.items.map((item: { path: number[]; label: string }) => ({ path: item.path, label: item.label })),
        };
      });
    });
    await box(a, second).click();
    const selection = () => a.evaluate(() => (window as unknown as { __styleSelectionProof?: SelectionProof }).__styleSelectionProof);
    await expect.poll(async () => (await selection())?.items[0]?.label).toContain('SECOND BOX');
    const selectedBeforeDeletion = await selection();

    // Fault injection only: delay incoming host→A-canvas source messages. All other messages,
    // including tools, presence and outgoing selection reports, continue normally.
    await slide(a).evaluate(() => {
      const gate = (window as unknown as { __deckStyleSourceGate: SourceGate }).__deckStyleSourceGate;
      if (!gate) throw new Error('Source-message fault gate was not installed before runtime');
      gate.messages = []; gate.hold = true;
    });
    const heldSources = () => slide(a).evaluate(() => (window as unknown as { __deckStyleSourceGate: SourceGate }).__deckStyleSourceGate.messages);
    await box(b, first).click();
    await b.keyboard.press('Delete');
    await expect(box(b, first)).toHaveCount(0);
    await expect.poll(savedSource).not.toContain(first);
    await expect(b.locator('.dl-status')).toHaveText('Saved');
    await expect.poll(async () => (await heldSources()).some(message => !message.html.includes(first))).toBe(true);
    expect(Math.max(...(await heldSources()).map(message => message.version))).toBeGreaterThan(selectedBeforeDeletion!.version);
    await expect(box(a, first)).toBeVisible(); // A still has the old sibling paths.

    const size = a.locator('[data-dk-size] input').first();
    await size.fill('26');
    await size.press('Enter');
    await a.locator('[data-tb="dk-color"]').click();
    await a.locator('[data-palette="dk-color"] [data-color-custom]').fill('#cc0000');
    await expect.poll(savedSource).toContain('#cc0000');
    await expect(b.locator('.dl-status')).toHaveText('Saved');
    const secondFont = await box(b, second).evaluate(nativePointReference, 26);
    const secondAfter = { color: secondFont.color, fontSize: secondFont.actual, inline: secondFont.inline };
    const thirdAfter = await style(b, third);
    const savedSelectedSize = await box(b, second).evaluate((_, value) => {
      const parsed = new DOMParser().parseFromString(value.source, 'text/html');
      const selected = [...parsed.querySelectorAll<HTMLParagraphElement>('section.slide > p')]
        .filter(p => p.textContent === value.text && (!value.id || p.id === value.id));
      return selected.length === 1 && selected[0].style.fontSize === '26pt' &&
        /(?:^|;)\s*font-size\s*:\s*26pt\s*(?:;|$)/.test(selected[0].getAttribute('style') ?? '');
    }, { source: savedSource(), text: second, id: secondFont.elementId });
    expect(savedSelectedSize).toBe(true);
    const proof = {
      selectedBeforeDeletion, heldSourceVersions: (await heldSources()).map(message => message.version),
      thirdBefore, secondAfter, thirdAfter, savedSource: savedSource(),
    };
    writeFileSync(info.outputPath('stale-selection-style.json'), JSON.stringify(proof, null, 2));
    await info.attach('stale-selection-style', { body: JSON.stringify(proof, null, 2), contentType: 'application/json' });

    // Release the latest delayed snapshot through the ordinary runtime message listener.
    const latest = await slide(a).evaluate(() => {
      const gate = (window as unknown as { __deckStyleSourceGate: SourceGate }).__deckStyleSourceGate;
      gate.hold = false;
      return gate.messages.at(-1) ?? null;
    });
    if (latest) await a.evaluate(message => {
      document.querySelector<HTMLIFrameElement>('.dl-frame')!.contentWindow!.postMessage(message, '*');
    }, latest);
    await expect(box(a, first)).toHaveCount(0);
    expect.soft(secondAfter.color).toBe('rgb(204, 0, 0)');
    expect(secondFont.lower).not.toBe(secondFont.expected);
    expect(secondFont.upper).not.toBe(secondFont.expected);
    expect.soft(secondAfter.fontSize).toBe(secondFont.expected);
    expect.soft(thirdAfter).toEqual(thirdBefore);
    await a.reload();
    await expect(box(a, second)).toHaveCSS('color', 'rgb(204, 0, 0)');
    await expect.poll(async () => {
      const font = await box(a, second).evaluate(nativePointReference, 26);
      return font.actual === font.expected && font.lower !== font.expected && font.upper !== font.expected;
    }).toBe(true);
    expect(await style(a, third)).toEqual(thirdBefore);
    expect([...errorsA, ...errorsB]).toEqual([]);
  } finally { await Promise.all(contexts.map(context => context.close())); }
});

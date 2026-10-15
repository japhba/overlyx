/**
 * A new-user A0 poster authored exclusively with canvas controls. It covers the failures found
 * during the independent NASA/USGS-inspired GUI poster exercise: floating palettes obstructed
 * by QuickBar, creation tools obstructed by a previous selection, and empty formula placeholders.
 * No deliverable source, editor API, local-storage editor state or fixture project is seeded.
 */
import { test, expect, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { userCredentials, collectErrors, grantClipboard, pickTheme } from './helpers';

const canvas = (page: Page) => page.frameLocator('.dl-frame').locator('section.slide').first();
const user = process.env.OVERLYX_BETA_POSTER_USER ?? 'admin';

type ImeHandoffProof = {
  heldCount: number; releasedCount: number; composingAtRelease: boolean;
  trustedComposition: boolean; sourcePreserved: boolean; originPreserved: boolean;
  trustedDelivery: boolean; payloadPreserved: boolean;
};
type ImeHandoffGate = {
  hold: boolean; held: MessageEvent[]; composing: boolean; trustedComposition: boolean;
  proof?: ImeHandoffProof;
  release(): unknown[]; dispose(): void;
};

async function point(page: Page, x: number, y: number) {
  const b = await canvas(page).boundingBox();
  if (!b) throw new Error('A0 canvas is not visible');
  return { x: b.x + x / 841 * b.width, y: b.y + y / 1189 * b.height };
}
async function draw(page: Page, x: number, y: number, w: number, h: number) {
  const a = await point(page, x, y), b = await point(page, x + w, y + h);
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 8 }); await page.mouse.up();
}
async function paint(page: Page, tool: string, value: string, swatch = false) {
  await page.locator(`[data-tb="${tool}"]`).click();
  const palette = page.locator(`[data-palette="${tool}"]`);
  if (swatch) await palette.locator(`[data-color="${value}"]`).first().click();
  else await palette.locator('[data-color-custom]').fill(value);
}
async function shape(page: Page, x: number, y: number, w: number, h: number, fill: string) {
  await page.locator('[data-tb="dk-shapes"]').click();
  await page.locator('[data-palette="dk-shapes"] [title="Rectangle"]').click();
  await expect(page.locator('[data-dl-quick]')).toHaveCount(0);
  await draw(page, x, y, w, h);
  await expect(page.locator('[data-tb="dk-fill"]')).toBeVisible();
  await paint(page, 'dk-fill', fill);
}
async function text(page: Page, x: number, y: number, w: number, value: string, pt = 36, color = '#0c343d', bold = false) {
  // Keep the previous selection: choosing Text must itself remove its obstructing QuickBar.
  await page.locator('[data-tb="dk-text"]').click();
  await expect(page.locator('[data-dl-quick]')).toHaveCount(0);
  await draw(page, x, y, w, 40);
  await page.keyboard.type(value);
  await page.keyboard.press('Escape');
  const box = canvas(page).locator(':scope > p').last();
  await expect(box).toHaveText(value);
  await box.click();
  const input = page.locator('[data-dk-size] input').first();
  await input.fill(String(pt)); await input.press('Enter');
  await paint(page, 'dk-color', color);
  if (bold) await page.locator('[data-tb="dk-b"]').click();
  return box;
}
async function line(page: Page, x: number, y: number, w: number, h: number) {
  await page.locator('[data-tb="dk-lines"]').click();
  await page.locator('[data-palette="dk-lines"] [title="Line"]').click();
  await draw(page, x, y, w, h);
}

test('GUI authors a complete A0 research poster, reviews it and exports one page', async ({ page, context }, info) => {
  test.setTimeout(240000);
  await page.setViewportSize({ width: 1600, height: 1100 });
  const errors = collectErrors(page);
  await grantClipboard(context);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const fallback = page.locator('[data-password-login]');
  if (await fallback.count()) await fallback.click();
  const credentials = userCredentials(user);
  await page.getByPlaceholder('Username').fill(credentials.username);
  await page.getByPlaceholder('Password').fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('[data-new-project]')).toBeVisible();
  const dismiss = page.locator('.tour-card button').filter({ hasText: 'Not now' });
  if (await dismiss.count()) await dismiss.click();
  await page.locator('[data-new-project]').click();
  await page.locator('[data-new-kind="poster"]').click();
  await page.locator('[data-new-name]').fill(`beta-poster-gui-${Date.now().toString(36)}`);
  await page.locator('[data-new-create]').click();
  await expect(canvas(page)).toBeVisible();
  await canvas(page).click({ position: { x: 8, y: 500 } });
  await page.keyboard.press('Control+a');
  await expect(page.locator('[data-tb="dk-delete"]')).toBeVisible();
  await page.keyboard.press('Delete');
  await expect(canvas(page).locator(':scope > *')).toHaveCount(0);
  await shape(page, 35, 35, 771, 145, '#0c343d');
  await text(page, 60, 58, 720, 'COOLING THE CATCHMENT', 92, '#ffffff', true);
  await text(page, 60, 125, 720, 'A fictional stormwater pilot | Community Hydrology Lab', 40, '#d0e0e3');
  for (const [x, title] of [[40, 'QUESTION & METHODS'], [300, 'RESULTS'], [560, 'CONCLUSION']] as const) {
    await shape(page, x, 260, 240, 40, '#134f5c');
    await text(page, x + 8, 269, 223, title, 40, '#ffffff', true);
  }
  await text(page, 40, 320, 240,
    'Can planted curb basins cool runoff? Three fictional blocks compare asphalt, gravel and planted storage. Six simulated storms provide invented demonstration data.');
  const question = canvas(page).locator(':scope > p').filter({ hasText: 'planted curb basins cool runoff?' });
  // The colour palette overlaps QuickBar at this exact A0 placement. The swatch must receive a real click.
  await paint(page, 'dk-color', '#0c343d', true);
  await text(page, 300, 320, 240, 'Cooling rises with planting depth. Invented medians are shown below; these values are illustrative.');
  await text(page, 560, 320, 240, 'Combine shade with storage. Validate hydraulic capacity and monitor real sites across seasons before drawing practical conclusions.');
  await text(page, 40, 570, 240, 'METHODS', 44, '#134f5c', true);
  await text(page, 40, 625, 240, 'Measure outflow temperature, peak-flow delay and drawdown. Normalize the cooling index to the asphalt control.');
  await line(page, 330, 760, 205, 0); await line(page, 330, 520, 0, 240);
  for (const [x, height, label] of [[350, 60, '0.8'], [415, 128, '1.7'], [480, 203, '2.7']] as const) {
    await shape(page, x, 760 - height, 38, height, '#45818e');
    await text(page, x, 727 - height, 48, label, 30, '#134f5c', true);
  }
  await text(page, 300, 810, 240, 'Figure 1. Invented cooling medians: control, gravel and planted storage.', 28, '#666666');
  // Use the checked-in drawing so clean release checkouts exercise the same import.
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('[data-tb="dk-image"]').click()]);
  await chooser.setFiles('e2e/fixtures/beta-orbit-map.svg');
  const image = canvas(page).locator(':scope > img, :scope > svg[role="img"]').last();
  await expect(image).toBeVisible();
  // Resize before moving the image; all four corners stay inside the poster, avoiding native hidden-overflow auto-scroll.
  let b = await image.boundingBox(); const cb = await canvas(page).boundingBox();
  if (!b || !cb) throw new Error('Uploaded image has no GUI geometry');
  const width = cb.width * 240 / 841;
  await page.mouse.move(b.x + b.width, b.y + b.height); await page.mouse.down();
  await page.mouse.move(b.x + width, b.y + b.height * width / b.width, { steps: 8 }); await page.mouse.up();
  b = await image.boundingBox(); if (!b) throw new Error('Resized image has no GUI geometry');
  const p = await point(page, 560, 600);
  await page.mouse.move(b.x + 30, b.y + 30); await page.mouse.down();
  await page.mouse.move(p.x + 30, p.y + 30, { steps: 8 }); await page.mouse.up();
  await page.keyboard.press('Escape');
  await text(page, 560, 800, 240, 'Context illustration, independent of the fictional study results.', 28, '#666666');
  await page.keyboard.press('Escape'); await page.locator('[data-tb="dk-formula"]').click();
  await draw(page, 305, 930, 230, 25);
  await expect(page.locator('[data-dl-mathedit] .lm-field')).toBeVisible();
  await page.keyboard.type('C=(T'); await page.keyboard.type('_c'); await page.keyboard.press('ArrowRight');
  await page.keyboard.type('-T'); await page.keyboard.type('_b'); await page.keyboard.press('ArrowRight');
  await page.keyboard.type(')/T'); await page.keyboard.type('_c'); await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await expect(canvas(page).locator('mjx-container')).toHaveCount(1);
  await expect(canvas(page).locator('mjx-container [data-mml-node="math"]')).toHaveAttribute('data-latex', 'C=(T_{c}-T_{b})/T_{c}');
  await text(page, 40, 1090, 760, 'DEMONSTRATION DATA ONLY · Original fictional values, not engineering evidence.', 26, '#666666');
  await question.dblclick(); await page.keyboard.press('Control+Home');
  await page.keyboard.press('Control+Shift+ArrowRight'); await page.keyboard.type('Could');
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await expect(question).toContainText('Could');
  await question.click(); await page.locator('[data-tb="dk-comment"]').click();
  await page.locator('[data-rv-comment]').fill('Keep the demonstration-data label visible.');
  await page.locator('[data-rv-submit]').click();
  await expect(page.locator('[data-rv-thread]')).toContainText('demonstration-data label');
  await page.locator('[data-rv-resolve]').click();
  await page.locator('[data-dl-review] button[title="Close"]').click();
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  // Entering the drawer layout deliberately folds Files. Reopen it to exercise
  // Files and Review together, including the existing explicit Hide action.
  await page.locator('[data-rail="outline"]').click();
  await expect(page.locator('button[title="Hide the files panel (Ctrl+Alt+O)"]')).toBeVisible();
  const phoneBefore = await canvas(page).boundingBox();
  await page.locator('[data-dl-review-toggle]').click();
  await expect(page.locator('[data-dl-review]')).toBeVisible();
  const phoneAfter = await canvas(page).boundingBox();
  expect(phoneBefore).not.toBeNull(); expect(phoneAfter).not.toBeNull();
  expect(Math.abs(phoneAfter!.width - phoneBefore!.width)).toBeLessThan(1);
  expect(phoneAfter!.x).toBeGreaterThan(-1);
  expect(phoneAfter!.x + phoneAfter!.width).toBeLessThan(391);
  await page.locator('button[title="Hide the files panel (Ctrl+Alt+O)"]').click();
  await page.locator('[data-dl-review] button[title="Close"]').click();
  await page.locator('[data-dl-zoom]').selectOption('fit');
  await page.setViewportSize({ width: 1600, height: 1100 });
  await pickTheme(page, 'Dark');
  await expect(canvas(page).locator('mjx-container [data-mml-node="math"]')).toHaveAttribute('data-latex', 'C=(T_{c}-T_{b})/T_{c}');
  await info.attach('A0-poster-dark', { body: await page.screenshot(), contentType: 'image/png' });
  await pickTheme(page, 'Light');
  await expect(page.locator('.dl-toolbar')).toContainText('Saved', { timeout: 15000 });
  await page.reload();
  await expect(canvas(page).locator('mjx-container')).toHaveCount(1);
  await expect(canvas(page)).toContainText('Could');
  await page.locator('[data-dl-download]').click();
  const downloading = page.waitForEvent('download', { timeout: 120000 });
  await page.getByText('PDF', { exact: true }).click();
  const pdf = await downloading;
  expect(await pdf.failure(), 'A0 PDF export succeeds').toBeNull();
  const destination = info.outputPath('poster.pdf');
  await pdf.saveAs(destination);
  expect(readFileSync(destination).subarray(0, 4).toString()).toBe('%PDF');
  await info.attach('A0-poster-final', { body: await page.screenshot(), contentType: 'image/png' });
  expect(errors).toEqual([]);
});

test('three ready A0 posters honor fast host Ctrl+A then Delete', async ({ page }, info) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const fallback = page.locator('[data-password-login]');
  if (await fallback.count()) await fallback.click();
  const credentials = userCredentials(user);
  await page.getByPlaceholder('Username').fill(credentials.username);
  await page.getByPlaceholder('Password').fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('[data-new-project]')).toBeVisible();
  const tour = page.locator('.tour-card button').filter({ hasText: 'Not now' });
  if (await tour.count()) await tour.click();
  for (let n = 0; n < 3; n++) {
    if (n) { await page.goto('/#/'); await expect(page.locator('[data-new-project]')).toBeVisible(); }
    await page.locator('[data-new-project]').click();
    await page.locator('[data-new-kind="poster"]').click();
    await page.locator('[data-new-name]').fill(`fast-poster-delete-${Date.now().toString(36)}-${n}`);
    await page.locator('[data-new-create]').click();
    await expect(canvas(page)).toBeVisible();
    const runtime = () => canvas(page).evaluate(() => {
      const w = window as unknown as { __olReady?: boolean; __ol?: { version(): number | null }; __OL?: { mode?: string } };
      return { ready: w.__olReady === true, version: w.__ol?.version() ?? null, mode: w.__OL?.mode ?? null };
    });
    await expect(page.locator('.dl-toolbar')).toContainText('Saved');
    await expect.poll(async () => { const r = await runtime(); return r.ready && r.version !== null; }).toBe(true);
    const before = { runtime: await runtime(), objects: await canvas(page).locator(':scope > *').count(), status: await page.locator('.dl-toolbar').innerText() };
    // A toolbar click keeps the keyboard in the host: these two keys must be queued in order,
    // independent of the asynchronous selection reply from the iframe.
    await page.locator('[data-tb="dk-select"]').click();
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Delete');
    await expect.soft(canvas(page).locator(':scope > *')).toHaveCount(0);
    const after = { runtime: await runtime(), objects: await canvas(page).locator(':scope > *').count(), status: await page.locator('.dl-toolbar').innerText() };
    const proof = JSON.stringify({ before, after }, null, 2);
    writeFileSync(info.outputPath(`fast-delete-${n + 1}.json`), proof);
    await info.attach(`fast-delete-${n + 1}`, { body: proof, contentType: 'application/json' });
  }
});

test('immediate new A0 text preserves Unicode, pending deletion, clipboard and composition', async ({ page, context, browserName }, info) => {
  // Fault injection only: install before the runtime listener, initially inactive.
  // Delay only the parent-to-frame editing handoff; source/layout/drawing and all
  // trusted pointer, keyboard, clipboard and composition input remain ordinary.
  await page.addInitScript(() => {
    if (window === window.top) return;
    let expectedOrigins: string[] = [], expectedPayloads: string[] = [];
    const gate: ImeHandoffGate = {
      hold: false, held: [], composing: false, trustedComposition: false,
      release() {
        const held = gate.held.splice(0);
        gate.hold = false;
        window.removeEventListener('message', handoff, true);
        expectedOrigins = held.map(event => event.origin);
        expectedPayloads = held.map(event => JSON.stringify(event.data));
        gate.proof = {
          heldCount: held.length, releasedCount: 0, composingAtRelease: gate.composing,
          trustedComposition: gate.trustedComposition, sourcePreserved: true, originPreserved: true,
          trustedDelivery: true, payloadPreserved: true,
        };
        // The real parent relays unchanged payloads as fresh native messages.
        // Redispatching an intercepted MessageEvent does not prove delivery.
        return held.map(event => event.data);
      },
      dispose() {
        gate.hold = false;
        window.removeEventListener('message', handoff, true);
        window.removeEventListener('message', delivery, true);
        window.removeEventListener('compositionstart', compositionStart, true);
        window.removeEventListener('compositionend', compositionEnd, true);
        gate.held = [];
        delete (window as unknown as { __betaPosterImeHandoff?: ImeHandoffGate }).__betaPosterImeHandoff;
      },
    };
    const handoff = (event: MessageEvent) => {
      if (!gate.hold || event.source !== window.parent || event.data?.ol !== 'editText' || event.data.math) return;
      gate.held.push(event);
      event.stopImmediatePropagation();
    };
    const delivery = (event: MessageEvent) => {
      if (!gate.proof || event.data?.ol !== 'editText' || event.data.math) return;
      const n = gate.proof.releasedCount++;
      gate.proof.trustedDelivery &&= event.isTrusted;
      gate.proof.sourcePreserved &&= event.source === window.parent;
      gate.proof.originPreserved &&= event.origin === expectedOrigins[n];
      gate.proof.payloadPreserved &&= JSON.stringify(event.data) === expectedPayloads[n];
    };
    const compositionStart = (event: CompositionEvent) => {
      gate.composing = true; gate.trustedComposition = event.isTrusted;
    };
    const compositionEnd = () => { gate.composing = false; };
    (window as unknown as { __betaPosterImeHandoff: ImeHandoffGate }).__betaPosterImeHandoff = gate;
    window.addEventListener('message', handoff, true);
    window.addEventListener('message', delivery, true);
    window.addEventListener('compositionstart', compositionStart, true);
    window.addEventListener('compositionend', compositionEnd, true);
  });
  await grantClipboard(context);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const fallback = page.locator('[data-password-login]');
  if (await fallback.count()) await fallback.click();
  const credentials = userCredentials(user);
  await page.getByPlaceholder('Username').fill(credentials.username);
  await page.getByPlaceholder('Password').fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('[data-new-project]')).toBeVisible();
  const tour = page.locator('.tour-card button').filter({ hasText: 'Not now' });
  if (await tour.count()) await tour.click();
  await page.locator('[data-new-project]').click();
  await page.locator('[data-new-kind="poster"]').click();
  await page.locator('[data-new-name]').fill(`unicode-poster-input-${Date.now().toString(36)}`);
  await page.locator('[data-new-create]').click();
  await expect(canvas(page)).toBeVisible();
  await expect(page.locator('.dl-toolbar')).toContainText('Saved');
  const title = canvas(page).locator('h1').first();
  const originalTitle = await title.innerText();
  const clipboardText = '🙂 Clipboard start · pasted exactly once';
  const values = ['🙂 First input stays complete', 'λ-flow model uses Unicode', '· Demonstration data · original values'];
  for (let n = 0; n < values.length; n++) {
    await title.click();
    await page.locator('[data-tb="dk-text"]').click();
    await draw(page, 40, 500 + n * 130, 700, 45);
    // No sleep or editing-state wait: pending keys must affect this new box, never the selected title.
    if (n === 0) await page.keyboard.press('Delete');
    if (n === 1) await page.keyboard.press('Control+x');
    await page.keyboard.type(values[n], { delay: 0 });
    await page.keyboard.press('Escape');
    const typed = canvas(page).locator(':scope > p').filter({ hasText: values[n] });
    await expect(typed).toHaveCount(1);
    await expect(typed).toHaveText(values[n]);
    await expect(title).toHaveText(originalTitle);
  }
  // The earlier Cut can legitimately copy the selected new-box placeholder after its draw ACK.
  // Prepare a trusted, verified clipboard immediately before this independent fast-paste check.
  await title.click();
  await page.locator('[data-tb="dk-comment"]').click();
  await page.locator('[data-rv-comment]').fill(clipboardText);
  await expect(page.locator('[data-rv-comment]')).toHaveValue(clipboardText);
  await page.locator('[data-rv-comment]').press('Control+a');
  await page.locator('[data-rv-comment]').press('Control+c');
  await page.locator('[data-rv-draft] button').filter({ hasText: 'Cancel' }).click();
  await page.locator('[data-dl-review] button[title="Close"]').click();
  await title.click();
  await page.locator('[data-tb="dk-text"]').click();
  await draw(page, 40, 900, 700, 45);
  await page.keyboard.press('Control+v');
  await page.keyboard.press('Escape');
  await expect(canvas(page).locator(':scope > p').filter({ hasText: clipboardText })).toHaveText(clipboardText);
  await expect(canvas(page).locator(':scope > p').filter({ hasText: clipboardText })).toHaveCount(1);
  await expect(title).toHaveText(originalTitle);
  if (browserName === 'chromium') {
    const canvasHandle = await canvas(page).elementHandle();
    const imeFrame = await canvasHandle?.ownerFrame();
    await canvasHandle?.dispose();
    if (!imeFrame) throw new Error('The pending-IME canvas frame is unavailable');
    const iframeElement = await imeFrame.frameElement();
    const relayHeld = async () => {
      const messages = await imeFrame.evaluate(() =>
        (window as unknown as { __betaPosterImeHandoff?: ImeHandoffGate }).__betaPosterImeHandoff?.release() ?? []);
      if (messages.length) await iframeElement.evaluate((element, payloads) => {
        const frame = element as HTMLIFrameElement;
        if (!frame.contentWindow) throw new Error('The pending-IME parent relay frame is unavailable');
        for (const data of payloads) frame.contentWindow.postMessage(data, '*');
      }, messages);
      return messages.length;
    };
    const cdp = await context.newCDPSession(page);
    let committedComposition = false;
    const cleanup = async (operation: () => Promise<unknown>) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([operation().catch(() => {}), new Promise<void>(resolve => { timer = setTimeout(resolve, 2000); })]);
      } finally { if (timer) clearTimeout(timer); }
    };
    try {
      await title.click();
      await imeFrame.evaluate(() => {
        const gate = (window as unknown as { __betaPosterImeHandoff?: ImeHandoffGate }).__betaPosterImeHandoff;
        if (!gate) throw new Error('Pending-IME handoff gate was not installed before runtime');
        gate.held = []; gate.hold = true; gate.composing = false; gate.trustedComposition = false;
      });
      await page.locator('[data-tb="dk-text"]').click();
      await draw(page, 40, 1030, 700, 45);
      await cdp.send('Input.imeSetComposition', { text: 'にほ', selectionStart: 2, selectionEnd: 2 });
      await page.keyboard.press('Backspace');
      // The new source object arrives normally, while the real pending input
      // receiver retains composition. No editing handoff has yet been applied.
      await expect(canvas(page).locator(':scope > p').filter({ hasText: /^Text$/ })).toHaveCount(1);
      await expect(title).toHaveText(originalTitle);
      await expect.poll(() => imeFrame.evaluate(() =>
        (window as unknown as { __betaPosterImeHandoff: ImeHandoffGate }).__betaPosterImeHandoff.held.length)).toBe(1);
      expect(await relayHeld()).toBe(1);
      await expect.poll(() => imeFrame.evaluate(() =>
        (window as unknown as { __betaPosterImeHandoff: ImeHandoffGate }).__betaPosterImeHandoff.proof?.releasedCount)).toBe(1);
      const handoff = await imeFrame.evaluate(() =>
        (window as unknown as { __betaPosterImeHandoff: ImeHandoffGate }).__betaPosterImeHandoff.proof);
      expect(handoff).toEqual({ heldCount: 1, releasedCount: 1, composingAtRelease: true,
        trustedComposition: true, sourcePreserved: true, originPreserved: true,
        trustedDelivery: true, payloadPreserved: true });
      // editTextAt must defer the delivered handoff until composition ends.
      await expect(canvas(page).locator(':scope > p').filter({ hasText: /^Text$/ })).toHaveCount(1);
      await expect(canvas(page).locator('[data-ol-editing]')).toHaveCount(0);
      await expect(title).toHaveText(originalTitle);
      await cdp.send('Input.insertText', { text: '日本語' });
      committedComposition = true;
      await page.keyboard.press('Escape');
      await expect(canvas(page).locator(':scope > p').filter({ hasText: '日本語' })).toHaveText('日本語');
      await expect(canvas(page).locator(':scope > p').filter({ hasText: '日本語' })).toHaveCount(1);
      await expect(title).toHaveText(originalTitle);
      await info.attach('pending-IME-handoff', { body: JSON.stringify(handoff), contentType: 'application/json' });
    } finally {
      // Relay any still-held payload from the real parent before removing the
      // fault listeners, including when an assertion failed.
      await cleanup(relayHeld);
      await cleanup(() => imeFrame.evaluate(() =>
        (window as unknown as { __betaPosterImeHandoff?: ImeHandoffGate }).__betaPosterImeHandoff?.dispose()));
      if (!committedComposition) await cleanup(() => cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 }));
      await cleanup(() => cdp.detach());
      await cleanup(() => iframeElement.dispose());
    }
  }
  await expect(page.locator('.dl-toolbar')).toContainText('Saved', { timeout: 15000 });
  await page.reload();
  for (const value of values) await expect(canvas(page)).toContainText(value);
  await expect(canvas(page).locator(':scope > p').filter({ hasText: clipboardText })).toHaveCount(1);
  await expect(title).toHaveText(originalTitle);
  if (browserName === 'chromium') {
    await expect(canvas(page)).toContainText('日本語');
    await expect(canvas(page).locator(':scope > p').filter({ hasText: '日本語' })).toHaveText('日本語');
    await expect(canvas(page).locator(':scope > p').filter({ hasText: '日本語' })).toHaveCount(1);
  }
  await info.attach('Unicode-A0-input', { body: await page.screenshot(), contentType: 'image/png' });
});

test('interrupted A0 text creation recovers the exact Unicode draft', async ({ page }, info) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const fallback = page.locator('[data-password-login]');
  if (await fallback.count()) await fallback.click();
  const credentials = userCredentials(user);
  await page.getByPlaceholder('Username').fill(credentials.username);
  await page.getByPlaceholder('Password').fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('[data-new-project]')).toBeVisible();
  const tour = page.locator('.tour-card button').filter({ hasText: 'Not now' });
  if (await tour.count()) await tour.click();
  await page.locator('[data-new-project]').click();
  await page.locator('[data-new-kind="poster"]').click();
  await page.locator('[data-new-name]').fill(`interrupted-poster-input-${Date.now().toString(36)}`);
  await page.locator('[data-new-create]').click();
  await expect(canvas(page)).toBeVisible();
  await expect(page.locator('.dl-toolbar')).toContainText('Saved');
  const title = canvas(page).locator('h1').first();
  const originalTitle = await title.innerText();
  // Fault injection only: drop the runtime's text-creation request before the host handles it.
  // Every pointer/typing action below still travels through the ordinary GUI. Other runtime
  // messages, including durable draft snapshots and recovery notifications, remain untouched.
  await page.evaluate(() => {
    window.addEventListener('message', event => {
      const frame = document.querySelector<HTMLIFrameElement>('.dl-frame');
      const message = event.data;
      if (event.source === frame?.contentWindow && message?.ol === 'draw' && message.tool === 'text') {
        event.stopImmediatePropagation();
      }
    }, true);
  });
  const value = '🙂 Interrupted draft · retains λ and text.';
  await title.click();
  await page.locator('[data-tb="dk-text"]').click();
  await draw(page, 40, 500, 700, 45);
  await page.keyboard.type(value, { delay: 0 });
  const recoveryStorage = () => page.evaluate(() => Object.keys(localStorage)
    .filter(key => key.startsWith('ol.textRecovery:'))
    .map(key => ({ key, value: JSON.parse(localStorage.getItem(key) ?? '[]') })));
  await expect.poll(async () => (await recoveryStorage()).some(entry => entry.key.includes(':pending:')
    && entry.value.some((draft: { html?: string }) => draft.html === value))).toBe(true);
  const pending = await recoveryStorage();
  await expect(page.locator('[data-dl-recovery-notice]')).toBeVisible({ timeout: 10000 });
  await expect(title).toHaveText(originalTitle);
  await expect(canvas(page).locator(':scope > p').filter({ hasText: value })).toHaveCount(0);
  // Interrupted input opens this dialog automatically; the notice button sits behind it.
  const recovery = page.locator('.dialog').filter({ hasText: 'Recover text' });
  await expect(recovery.locator('textarea[readonly]')).toHaveValue(value);
  const beforeReload = await recoveryStorage();
  await info.attach('interrupted-A0-Unicode-recovery', { body: await page.screenshot(), contentType: 'image/png' });
  await recovery.getByRole('button', { name: 'Keep for later', exact: true }).click();
  await page.reload();
  await expect(page.locator('[data-dl-recovery-notice]')).toBeVisible();
  await expect(title).toHaveText(originalTitle);
  await page.getByRole('button', { name: 'Recover text', exact: true }).click();
  await expect(recovery.locator('textarea[readonly]')).toHaveValue(value);
  const proof = JSON.stringify({ pending, beforeReload, afterReload: await recoveryStorage() }, null, 2);
  writeFileSync(info.outputPath('interrupted-draft-recovery.json'), proof);
  await info.attach('interrupted-draft-recovery', { body: proof, contentType: 'application/json' });
});

/**
 * GUI-only beta gate for a real slide deck: create from + New, author and recover through visible
 * canvas/toolbar/rail controls, verify saved HTML, then export and open the website ZIP offline.
 * Deliberately does not seed or rewrite deck content through the API, code view, or disk.
 */
import { test, expect, type Page, type Locator } from '@playwright/test';
import { readFileSync, rmSync, mkdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';
import { login, userCredentials, BASE_URL, PROJECTS_DIR, grantClipboard } from './helpers';

const RUN = process.env.OVERLYX_BETA_RUN ?? Date.now().toString(36);
const NAME = `beta-authoring-recovery-${RUN}`;
const PROJECT = `luna4/${NAME}`;
const FILE = path.join(PROJECTS_DIR, PROJECT, 'slides', 'index.html');
const IMAGE = path.resolve('e2e/fixtures/beta-orbit-map.svg');
const TITLE = 'Orbital Field Briefing';
const LONG_BULLET = 'A repairable observation chain joins orbit time, sensor quality, local checks, and crew decisions across cloudy coastal passes without treating missing scenes as zero risk.';
const browserErrors: string[] = [];
const failedSameOriginRequests: string[] = [];

test.describe.configure({ mode: 'serial', timeout: 240_000 });
// Keep the GUI-authored project/evidence on failures so a recovery run can resume it; clean only
// when explicitly requested after a successful local audit.
test.afterAll(() => { if (process.env.OVERLYX_BETA_CLEAN === '1') rmSync(path.join(PROJECTS_DIR, PROJECT), { recursive: true, force: true }); });

const frame = (page: Page) => page.frameLocator('.dl-frame');
const slides = (page: Page) => frame(page).locator('section.slide');
const rail = (page: Page) => page.frameLocator('.dl-railframe').locator('section.slide');
const fileText = () => readFileSync(FILE, 'utf8');
const ownErrors = () => browserErrors;

function watch(page: Page): void {
  page.on('pageerror', e => browserErrors.push(`pageerror ${page.url()}: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') browserErrors.push(`console ${page.url()}: ${m.text()}`); });
  page.on('requestfailed', r => {
    const url = r.url();
    // Signed deliverable URLs must not leak their token/query into a shareable failure report.
    if (!url.startsWith(BASE_URL)) return;
    const path = new URL(url).pathname, error = r.failure()?.errorText;
    // Navigation closes landing videos, project event streams and usage requests.
    // Keep failures of authoring requests and any non-cancellation error visible.
    const navigationResource = /^\/landing\/[^/]+\.webm$/.test(path)
      || /^\/api\/projects\/[^/]+\/events$/.test(path) || path === '/api/usage';
    const projectEvents = /^\/api\/projects\/[^/]+\/events$/.test(path);
    const webkitProjectEventsCancelled = projectEvents && r.method() === 'GET'
      && new URL(url).origin === new URL(BASE_URL).origin && error === 'Load request cancelled';
    if ((navigationResource && /^(?:net::ERR_ABORTED|NS_BINDING_ABORTED|cancelled)$/.test(error ?? ''))
      || (projectEvents && error === 'NS_ERROR_ABORT') || webkitProjectEventsCancelled) return;
    failedSameOriginRequests.push(`${path}: ${error}`);
  });
}

async function gotoSlide(page: Page, n: number): Promise<void> {
  await rail(page).nth(n).click();
  await expect(slides(page).nth(n)).toBeVisible();
  await page.waitForTimeout(120);
}

async function saved(needle: string): Promise<void> {
  await expect.poll(() => fileText(), { timeout: 15000 }).toContain(needle);
}

async function typeOver(page: Page, locator: Locator, text: string): Promise<void> {
  await locator.dblclick();
  await page.keyboard.press('Control+a');
  await page.keyboard.type(text, { delay: 1 });
  await page.keyboard.press('Escape');
}

async function point(page: Page, n: number, x: number, y: number): Promise<{ x: number; y: number }> {
  const b = (await slides(page).nth(n).boundingBox())!;
  const scale = b.width / 1280;
  return { x: b.x + x * scale, y: b.y + y * scale };
}

async function dragShape(page: Page, n: number, label: 'Rectangle' | 'Ellipse', x: number, y: number, w: number, h: number): Promise<void> {
  await page.locator('[data-tb="dk-shapes"]').click();
  const palette = page.locator('[data-palette="dk-shapes"]');
  await palette.locator(`.tb-pal-item[title="${label}"]`).click();
  const a = await point(page, n, x, y), b = await point(page, n, x + w, y + h);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 7 });
  await page.mouse.up();
  await page.waitForTimeout(180);
}

async function textToolBox(page: Page, n: number, x: number, y: number, text: string): Promise<void> {
  await page.locator('[data-tb="dk-text"]').click();
  const p = await point(page, n, x, y);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(120);
  await page.keyboard.type(text, { delay: 1 });
  await page.keyboard.press('Escape');
}

test('GUI authoring, recovery, saved state, PDF and offline website export', async ({ page, browser }, testInfo) => {
  page.setDefaultTimeout(8000);
  page.setDefaultNavigationTimeout(12000);
  watch(page);
  await grantClipboard(page.context());
  await login(page, userCredentials('luna4'));

  // The deck is created by the user-facing + New workflow, not by an endpoint or a source fixture.
  await page.locator('[data-new-project]').click();
  await page.locator('[data-new-kind="deck"]').click();
  await page.locator('[data-new-name]').fill(NAME);
  await page.locator('[data-new-create]').click();
  await slides(page).first().waitFor({ timeout: 30000 });
  await expect(rail(page)).toHaveCount(2);
  await expect.poll(() => fileText()).toContain('<meta name="overlyx" content="deck">');

  // Cancel a secondary deliverable dialog and a download menu; both should leave this deck usable.
  await page.locator('.menubar').getByText('File', { exact: true }).click();
  await page.getByText('New slides / poster / page…').click();
  const addDialog = page.locator('.dialog').filter({ hasText: 'New slides, poster or web page' });
  await expect(addDialog).toBeVisible();
  await addDialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(addDialog).toHaveCount(0);
  await page.locator('[data-dl-download]').click();
  await expect(page.locator('.ctx-menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.ctx-menu')).toHaveCount(0);
  await expect(slides(page).first()).toBeVisible();

  // Cover title, then a partial word selection/replacement in the canvas editor.
  const coverTitle = slides(page).nth(0).locator('h1');
  await typeOver(page, coverTitle, TITLE);
  await saved(TITLE);
  await coverTitle.dblclick();
  await page.keyboard.press('End');
  await page.keyboard.press('Control+Shift+ArrowLeft');
  await page.keyboard.type('Mission');
  await page.keyboard.press('Escape');
  await saved('Orbital Field Mission');
  await expect(coverTitle).toContainText('Orbital Field Mission');
  await typeOver(page, slides(page).nth(0).locator('p.muted'), 'Research design review · October 2026 · Coastal observatory');
  await saved('Coastal observatory');

  // Update a starter bullet by one word, then add substantial copy to the same bullet in canvas text.
  await gotoSlide(page, 1);
  const firstBullet = slides(page).nth(1).locator('li').first();
  await firstBullet.dblclick();
  await page.keyboard.press('End');
  await page.keyboard.press('Control+Shift+ArrowLeft');
  await page.keyboard.type('briefing');
  await page.keyboard.press('Escape');
  await saved('One message per briefing');
  const longBullet = slides(page).nth(1).locator('li').nth(1);
  // The centre of this starter item is its inline equation: a real double-click there correctly
  // opens math, not prose. Target the ordinary prefix and select its first word explicitly.
  await longBullet.dblclick({ position: { x: 15, y: 15 } });
  await expect(page.locator('[data-dl-mathedit]')).toHaveCount(0);
  const longBefore = await longBullet.evaluate(el => el.textContent ?? '');
  await page.keyboard.press('Home');
  await page.keyboard.press('Control+Shift+ArrowRight');
  const selectionBeforeType = await longBullet.evaluate(el => {
    const s = getSelection();
    if (!s?.anchorNode || !s.focusNode) return null;
    const offset = (node: Node, at: number) => { const r = document.createRange(); r.selectNodeContents(el); r.setEnd(node, at); return r.toString().length; };
    const a = offset(s.anchorNode, s.anchorOffset), f = offset(s.focusNode, s.focusOffset);
    return { text: s.toString(), anchorOffset: a, focusOffset: f, rangeStart: Math.min(a, f), rangeEnd: Math.max(a, f), liIndex: [...el.parentElement!.querySelectorAll('li')].indexOf(el as HTMLLIElement) };
  });
  await testInfo.attach('long-bullet-selection-before-type', { body: Buffer.from(JSON.stringify({ before: longBefore, selection: selectionBeforeType }, null, 2)), contentType: 'application/json' });
  expect(selectionBeforeType, 'the expected word selection must be visible before typing').not.toBeNull();
  expect(selectionBeforeType!.text.trim(), 'replace the prose word, not the equation').toBe('Math');
  const expectedLongAfter = longBefore.slice(0, selectionBeforeType!.rangeStart) + LONG_BULLET + longBefore.slice(selectionBeforeType!.rangeEnd);
  await page.keyboard.type(LONG_BULLET, { delay: 0 });
  await page.keyboard.press('Escape');
  await saved('A repairable observation chain joins orbit time');
  const longAfterLive = await longBullet.evaluate(el => el.textContent ?? '');
  await testInfo.attach('long-bullet-live-vs-source-after-type', { body: Buffer.from(JSON.stringify({ expected: expectedLongAfter, live: longAfterLive, sourceContainsTypedText: fileText().includes(LONG_BULLET) }, null, 2)), contentType: 'application/json' });
  expect(longAfterLive).toBe(expectedLongAfter);
  expect(fileText()).toContain(LONG_BULLET);
  const bulletsBeforeTyping = await slides(page).nth(1).locator('li').count();
  expect(bulletsBeforeTyping).toBe(3);

  // Six rail/toolbar insertions yield eight slides; every page gets its own visible title.
  const newTitles = [
    'Sensor trade-offs', 'Evidence chain', 'Uncertainty travels with the map',
    'Crew response, not only pixels', 'Held-out event validation', 'Next mission: flood corridor',
  ];
  for (let i = 0; i < newTitles.length; i++) {
    await page.locator('[data-dl-newslide]').click();
    await expect(rail(page)).toHaveCount(3 + i);
  }
  await expect(rail(page)).toHaveCount(8);
  for (let i = 0; i < newTitles.length; i++) {
    const slideN = i + 2;
    await gotoSlide(page, slideN);
    const heading = slides(page).nth(slideN).locator('h1,h2').first();
    await expect(heading).toBeVisible();
    await typeOver(page, heading, newTitles[i]);
    await saved(newTitles[i]);
  }

  // Letter sequences with tool letters while typing stay as text and do not create drawing objects.
  await gotoSlide(page, 3);
  const objectRows = page.locator('[data-dl-objects] [data-obj-row]');
  const objectsButton = page.locator('[data-tb="dk-objects"]');
  if (!/(^|\s)on(\s|$)/.test((await objectsButton.getAttribute('class')) ?? '')) await objectsButton.click();
  const objectsBeforeText = await objectRows.count();
  await textToolBox(page, 3, 140, 330, 'track radar analysis to alert');
  await saved('track radar analysis to alert');
  expect(await objectRows.count()).toBe(objectsBeforeText + 1);
  await expect(slides(page).nth(3)).toContainText('track radar analysis to alert');

  // Upload the fixture through the visible Picture tool's file chooser.
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('[data-tb="dk-image"]').click(),
  ]);
  await chooser.setFiles(IMAGE);
  await saved('FIELD SATELLITE · COASTAL PASS 17');
  await expect(slides(page).nth(3).locator('svg[aria-label="Orbit track over a blue planet"]')).toHaveCount(1, { timeout: 15000 });
  expect(fileText()).toContain('aria-label="Orbit track over a blue planet"');
  expect(fileText()).not.toContain('<script>');
  // The SVG lands as an editable group with child paths/letters, so the Object pane grows by more
  // than one row for the imported illustration.
  await expect.poll(() => objectRows.count()).toBeGreaterThan(objectsBeforeText + 1);

  // New shapes on an evidence slide: align by their middles, group/ungroup, copy/paste, duplicate,
  // then delete and undo. Each result is checked both on the canvas/Object pane and in saved HTML.
  await gotoSlide(page, 4);
  if (!/(^|\s)on(\s|$)/.test((await objectsButton.getAttribute('class')) ?? '')) await objectsButton.click();
  // Small groups start expanded. Count the direct slide objects, not their visible child rows:
  // source paths are html/body/slide/object, whereas group members add another path component.
  const topRows = () => objectRows.evaluateAll(rows => rows.filter(row =>
    (row.getAttribute('data-obj-row') ?? '').split('.').length === 3).length);
  const baseRows = await topRows();
  await dragShape(page, 4, 'Rectangle', 180, 280, 150, 90);
  await dragShape(page, 4, 'Ellipse', 430, 420, 150, 90);
  await expect.poll(topRows).toBe(baseRows + 2);
  const svgBeforeAlign = fileText();
  const a = await point(page, 4, 250, 325), b = await point(page, 4, 505, 465);
  await page.mouse.click(a.x, a.y);
  await page.keyboard.down('Shift'); await page.mouse.click(b.x, b.y); await page.keyboard.up('Shift');
  await expect(page.locator('[data-tb="dk-arrange"]')).toBeVisible();
  await page.locator('[data-tb="dk-arrange"]').click();
  await page.locator('[data-palette="dk-arrange"] .tb-pal-item', { hasText: 'Align middles' }).click();
  await expect.poll(() => fileText()).not.toBe(svgBeforeAlign);
  await page.keyboard.press('Control+g');
  await saved('ol-group');
  await expect(slides(page).nth(4).locator(':scope > .ol-group')).toHaveCount(1);
  await expect(slides(page).nth(4).locator(':scope > .ol-group > *')).toHaveCount(2);
  await expect.poll(topRows).toBe(baseRows + 1);
  await page.keyboard.press('Control+Shift+g');
  await expect.poll(() => fileText()).not.toContain('ol-group');
  await expect.poll(topRows).toBe(baseRows + 2);

  // Alignment changed the original hit coordinates. Select the current rectangle, not its old
  // pre-alignment centre (which could be blank canvas and leave an unrelated clipboard payload).
  const rectangle = slides(page).nth(4).locator(':scope > div').first();
  await rectangle.click();
  const rectanglesBeforeClipboard = await slides(page).nth(4).locator(':scope > div').count();
  const rowsBeforeClipboard = await topRows();
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  await expect.poll(topRows, { timeout: 10000 }).toBe(rowsBeforeClipboard + 1);
  await expect(slides(page).nth(4).locator(':scope > div')).toHaveCount(rectanglesBeforeClipboard + 1);
  await expect.poll(() => fileText()).not.toBe(svgBeforeAlign);
  const rowsBeforeDuplicate = await topRows();
  await page.keyboard.press('Control+d');
  await expect.poll(topRows).toBe(rowsBeforeDuplicate + 1);
  await page.keyboard.press('Control+z');
  await expect.poll(topRows).toBe(rowsBeforeDuplicate);
  await page.keyboard.press('Control+y');
  await expect.poll(topRows).toBe(rowsBeforeDuplicate + 1);
  await page.keyboard.press('Delete');
  await expect.poll(topRows).toBe(rowsBeforeDuplicate);
  await page.keyboard.press('Control+z');
  await expect.poll(topRows).toBe(rowsBeforeDuplicate + 1);

  // Reorder, duplicate, delete and undo whole slides through the rail context menu.
  await gotoSlide(page, 7);
  const eighthHeading = await slides(page).nth(7).locator('h1,h2').first().innerText();
  await rail(page).nth(7).click({ button: 'right' });
  await page.locator('.ctx-menu .ctx-item', { hasText: 'Move up' }).click();
  await expect(rail(page)).toHaveCount(8);
  await expect.poll(() => fileText()).toContain(eighthHeading);
  await expect.poll(async () => (await rail(page).allTextContents()).at(-2)).toContain(eighthHeading);
  await rail(page).nth(6).click({ button: 'right' });
  await page.locator('.ctx-menu .ctx-item', { hasText: 'Duplicate slide' }).click();
  await expect(rail(page)).toHaveCount(9);
  await page.keyboard.press('Control+z');
  await expect(rail(page)).toHaveCount(8);
  await rail(page).nth(7).click({ button: 'right' });
  await page.locator('.ctx-menu .ctx-item', { hasText: 'Delete slide' }).click();
  await expect(rail(page)).toHaveCount(7);
  await page.keyboard.press('Control+z');
  await expect(rail(page)).toHaveCount(8);

  // Speaker notes belong to their individual slides, survive reload, and remain distinct.
  await gotoSlide(page, 1);
  if (await page.locator('[data-dl-notes-show]').count()) await page.locator('[data-dl-notes-show]').click();
  const notes = page.locator('[data-dl-notes]');
  await notes.fill('Open with the coverage gap; distinguish absent measurements from safe conditions.');
  await notes.blur();
  await saved('distinguish absent measurements');
  await gotoSlide(page, 7);
  await notes.fill('Close by asking the team to nominate one flood corridor for the pilot.');
  await notes.blur();
  await saved('nominate one flood corridor');
  await page.reload();
  await slides(page).first().waitFor({ timeout: 30000 });
  await gotoSlide(page, 1);
  if (await page.locator('[data-dl-notes-show]').count()) await page.locator('[data-dl-notes-show]').click();
  await expect(notes).toHaveValue(/distinguish absent measurements/);
  await gotoSlide(page, 7);
  await expect(notes).toHaveValue(/nominate one flood corridor/);

  // Present the authored deck and validate real slide transitions, then exit back to editing.
  await gotoSlide(page, 0);
  await page.locator('[data-dl-present]').click();
  const presenter = page.frameLocator('.dl-presenting iframe');
  await expect(presenter.locator('section.slide[data-ol-current]')).toHaveCount(1, { timeout: 15000 });
  await expect(presenter.locator('section.slide[data-ol-current] h1')).toContainText('Orbital Field Mission');
  await page.keyboard.press('ArrowRight');
  await expect(presenter.locator('section.slide[data-ol-current]')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('.dl-presenting')).toHaveCount(0, { timeout: 10000 });

  // PDF and website downloads must produce substantial artifacts through the product's Download menu.
  await page.locator('[data-dl-download]').click();
  const pdfOption = page.locator('.ctx-menu').getByText('PDF', { exact: true });
  const [pdfDownload] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), pdfOption.click()]);
  const pdfPath = testInfo.outputPath('beta-deck.pdf');
  expect(await pdfDownload.failure(), 'the authored deck PDF downloads successfully').toBeNull();
  await pdfDownload.saveAs(pdfPath);
  const pdfInfo = execFileSync('pdfinfo', [pdfPath], { encoding: 'utf8' });
  expect(pdfInfo).toMatch(/Pages:\s+8/);
  const pdfText = execFileSync('pdftotext', [pdfPath, '-'], { encoding: 'utf8' });
  expect(pdfText).toContain('Orbital Field Mission');
  expect(pdfText).toContain('Next mission: flood corridor');

  await page.locator('[data-dl-download]').click();
  const zipOption = page.locator('.ctx-menu').getByText('Web page (.zip, works offline)', { exact: true });
  const [zipDownload] = await Promise.all([page.waitForEvent('download'), zipOption.click()]);
  const zipPath = testInfo.outputPath('beta-deck-website.zip');
  await zipDownload.saveAs(zipPath);
  const archiveBytes = readFileSync(zipPath);
  expect(archiveBytes.subarray(0, 2).toString()).toBe('PK');
  const zip = await JSZip.loadAsync(archiveBytes);
  expect(zip.file('_overlyx/runtime.js')).not.toBeNull();
  const siteDir = testInfo.outputPath('offline-site');
  await mkdir(siteDir, { recursive: true });
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const target = path.join(siteDir, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await entry.async('nodebuffer'));
  }
  const offline = await browser.newContext({ offline: true, viewport: { width: 1280, height: 800 } });
  const offlinePage = await offline.newPage();
  const offlineErrors: string[] = [];
  offlinePage.on('pageerror', e => offlineErrors.push(e.message));
  offlinePage.on('console', m => {
    const text = m.text();
    const locationUrl = m.location().url;
    const preconnect = /^Failed to preconnect to (https:\/\/\S+) Error: WebKit encountered an internal error$/.exec(text);
    let isExpectedOfflineFontPreconnect = false;
    if (m.type() === 'error' && locationUrl === '' && preconnect) {
      try {
        const url = new URL(preconnect[1]);
        isExpectedOfflineFontPreconnect = url.protocol === 'https:'
          && url.hostname === 'fonts.googleapis.com' && url.username === '' && url.password === ''
          && url.port === '' && url.pathname === '/' && url.search === '' && url.hash === '';
      } catch { /* An unparsable URL is not an expected offline preconnect diagnostic. */ }
    }
    // Keep the existing location-based font exception; add only the observed, exact native WebKit preconnect diagnostic.
    if (m.type() === 'error' && !/^https:\/\/fonts\.googleapis\.com\//.test(locationUrl) && !isExpectedOfflineFontPreconnect) offlineErrors.push(text);
  });
  await offlinePage.goto(`file://${path.join(siteDir, 'index.html')}`);
  await expect(offlinePage.locator('section.slide')).toHaveCount(8, { timeout: 10000 });
  await expect(offlinePage).toHaveTitle(/beta-authoring-recovery/);
  await expect(offlinePage.locator('section.slide').first()).toContainText('Orbital Field Mission');
  await expect(offlinePage.locator('section.slide').nth(3).locator('svg[aria-label="Orbit track over a blue planet"]')).toHaveCount(1);
  expect(offlineErrors).toEqual([]);
  await testInfo.attach('offline-deck', { body: await offlinePage.screenshot(), contentType: 'image/png' });
  await offline.close();

  await expect.poll(() => fileText()).toContain('Orbit track over a blue planet');
  await expect(page.locator('.dl-frame')).toBeVisible();
  await testInfo.attach('saved-deck-preview', { body: await page.screenshot(), contentType: 'image/png' });
  expect(ownErrors()).toEqual([]);
  expect(failedSameOriginRequests).toEqual([]);
});

/**
 * Landing page (sign-in) and the sidebars' show / hide affordances.
 */
import { test, expect } from '@playwright/test';
import { login, openDoc, TOUR_SEEN_SCRIPT } from './helpers';

test.describe('landing page', () => {
  test('without Google: the password form, no animation on its own, links', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.login .ol-wordmark')).toBeVisible();
    // the wordmark only animates on hover
    await expect(page.locator('.login .ol-wordmark.play')).toHaveCount(0);
    // no tagline any more; links to the project
    await expect(page.locator('.login')).not.toContainText('without the compiling');
    await expect(page.locator('.login .links a', { hasText: 'GitHub' })).toHaveAttribute('href', 'https://github.com/japhba/overlyx');
    await expect(page.locator('.login .links a', { hasText: 'Report an issue' })).toHaveAttribute('href', /github\.com\/japhba\/overlyx\/issues\/new/);
    await expect(page.locator('.login .links a')).toHaveCount(2);
    // no Google configured here: the username form is shown directly, as the primary action
    await expect(page.locator('[data-google-login]')).toHaveCount(0);
    await expect(page.locator('[data-password-login]')).toHaveCount(0);
    await expect(page.getByPlaceholder('Username')).toBeVisible();
    await expect(page.locator('.login form button.btn.primary')).toHaveText('Sign in');
  });

  test('with Google: one big Google button, the password form folded away behind a quiet link', async ({ page }) => {
    await page.route('**/api/auth/me', route => route.fulfill({ json: { user: null, google: true, signup: 'open' } }));
    await page.goto('/');
    const g = page.locator('[data-google-login]');
    await expect(g).toBeVisible();
    await expect(g).toHaveAttribute('href', '/api/auth/google');
    await expect(g).toContainText('Continue with Google');
    await expect(page.getByPlaceholder('Username')).toHaveCount(0);
    const box = await g.boundingBox();
    expect(box!.height).toBeGreaterThan(36);
    // the fallback: small, and it opens the form with a note that discourages it
    const fallback = page.locator('[data-password-login]');
    await expect(fallback).toBeVisible();
    expect((await fallback.boundingBox())!.height).toBeLessThan(box!.height / 2);
    await fallback.click();
    await expect(page.getByPlaceholder('Username')).toBeVisible();
    await expect(page.locator('.login .fallback-note')).toContainText('administrator');
    await expect(page.locator('.login .password.fallback button.btn')).not.toHaveClass(/primary/);
    await expect(fallback).toHaveCount(0);
  });
});

test.describe('sidebars', () => {
  test('the documents panel (project, document tabs, outline) and the right panels hide into rails; the state survives a reload', async ({ page }) => {
    await login(page);
    await openDoc(page, 'recurrent_feature/main.tex');
    // the documents panel is shown at first: the project, its documents, the open one expanded with its live outline; no top tab bar; the right side is a rail
    await expect(page.locator('.sidebar.left .docpanel')).toBeVisible();
    await expect(page.locator('.docpanel .project-switch')).toHaveValue('recurrent_feature');
    await expect(page.locator('.docpanel .doc-tab.active .fname')).toHaveText('main.tex');
    await expect(page.locator('.docpanel .doc-tab.active .outline-item').first()).toBeVisible();
    await expect(page.locator('.tabbar')).toHaveCount(0);
    await expect(page.locator('.rail.left')).toHaveCount(0);
    await expect(page.locator('.rail.right')).toBeVisible();
    for (const t of ['comments', 'source', 'pdf', 'versions']) await expect(page.locator(`.rail.right [data-rail="${t}"]`)).toBeVisible();
    // hide the documents panel: a rail takes its place
    await page.locator('.docpanel .hide').click();
    await expect(page.locator('.sidebar.left')).toHaveCount(0);
    await expect(page.locator('.rail.left [data-rail="outline"]')).toBeVisible();
    // the right rail opens the panel that was clicked
    await page.locator('.rail.right [data-rail="versions"]').click();
    await expect(page.locator('.sidebar.right [data-tab="versions"]')).toHaveClass(/active/);
    await expect(page.locator('.rail.right')).toHaveCount(0);
    // reload: the same
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length > 0, null, { timeout: 30000 });
    await expect(page.locator('.rail.left')).toBeVisible();
    await expect(page.locator('.sidebar.right [data-tab="versions"]')).toHaveClass(/active/);
    await page.locator('.sidebar.right .panel-tabs .hide').click();
    await expect(page.locator('.sidebar.right')).toHaveCount(0);
    await expect(page.locator('.rail.right')).toBeVisible();
    // the rail brings the documents panel back; Ctrl+Alt+O toggles it
    await page.locator('.rail.left [data-rail="outline"]').click();
    await expect(page.locator('.sidebar.left .docpanel')).toBeVisible();
    await expect(page.locator('.rail.left')).toHaveCount(0);
    await page.locator('.lyx-editor > .lyx-par').first().click();
    await page.keyboard.press('Control+Alt+o');
    await expect(page.locator('.rail.left')).toBeVisible();
    await page.keyboard.press('Control+Alt+o');
    await expect(page.locator('.sidebar.left .docpanel')).toBeVisible();
  });

  test('document tabs open the documents of the project in place and reveal their outlines; a heading of a closed document opens it there', async ({ page }) => {
    await login(page);
    await openDoc(page, 'recurrent_feature/main.tex');
    const tabs = page.locator('.docpanel .doc-tab');
    const main = page.locator('.docpanel .doc-tab[data-doc="main.tex"]');   // (the project also has main.tex files in sub-directories)
    await expect(main).toHaveClass(/active/);
    // the appendix is not open: its tab expands to the headings of the file
    const app = page.locator('.docpanel .doc-tab[data-doc="appendix.tex"]');
    await app.locator('.twisty').click();
    await expect(app.locator('.outline-item.static').first()).toBeVisible({ timeout: 10000 });
    const second = (await app.locator('.outline-item.static').nth(1).textContent() ?? '').replace(/^[A-Z0-9.]+\s*/, '').trim();
    // a heading opens that document with the cursor on the heading; the tab becomes the active one with the live outline
    await app.locator('.outline-item.static').nth(1).click();
    await expect(page).toHaveURL(/appendix\.tex\?heading=1$/);
    await page.waitForFunction(() => document.querySelectorAll('.lyx-editor .lyx-par').length > 0, null, { timeout: 30000 });
    await expect(app).toHaveClass(/active/);
    await expect.poll(() => page.evaluate(() => { const v = (window as any).overlyx.activeView; return v.state.selection.$from.parent.textContent as string; }), { timeout: 10000 }).toContain(second.slice(0, 12));
    await expect(app.locator('.outline-item:not(.static)').first()).toBeVisible();
    await expect(app.locator('.outline-item.active')).toHaveCount(1);
    // the Navigate menu lists the sections too
    await page.locator('.menubar .menu button', { hasText: 'Navigate' }).click();
    await expect(page.locator('.menu-item', { hasText: second.slice(0, 12) })).not.toHaveCount(0);
    await page.keyboard.press('Escape');
    // back to the main document by its tab; the project switcher shows the project
    await main.locator('.doc-name').click();
    await expect(page).toHaveURL(/recurrent_feature\/main\.tex$/);
    await expect(main).toHaveClass(/active/);
    await expect(page.locator('.docpanel .project-switch')).toHaveValue('recurrent_feature');
  });
});

test.describe('command palette', () => {
  test('Ctrl+Shift+P opens a search over all menus; results show the path and the shortcut; Enter runs the item', async ({ page }) => {
    await login(page);
    await openDoc(page, 'recurrent_feature/main.tex');
    await page.locator('.lyx-editor > .lyx-par').first().click();
    await page.keyboard.press('Control+Shift+p');
    const input = page.locator('[data-help-search]');
    await expect(input).toBeFocused();
    await input.fill('outline');
    const first = page.locator('[data-help-result]').first();
    await expect(first).toContainText('View');
    await expect(first).toContainText('Outline');
    await expect(first.locator('.shortcut')).toHaveText('Ctrl+Alt+O');   // Linux: no ⌘
    await expect(first).toHaveClass(/checked/);   // the outline is shown at the moment
    await page.keyboard.press('Enter');
    await expect(page.locator('.rail.left')).toBeVisible();   // Enter ran "View ▸ Outline": the documents panel is hidden now
    await expect(page.locator('[data-help-search]')).toHaveCount(0);
    // the keyboard goes back to the text
    await page.keyboard.type('HELPSEARCH');
    await expect(page.locator('.lyx-editor > .lyx-par').first()).toContainText('HELPSEARCH');
    // shortcuts of the reference table are found too, and a nested item shows its whole path
    await page.locator('.menubar .menu button', { hasText: 'Help' }).click();
    await page.locator('[data-help-search]').fill('leave formula');
    await expect(page.locator('[data-help-result]').first()).toContainText('Keyboard shortcuts');
    await expect(page.locator('[data-help-result]').first().locator('.shortcut')).toHaveText('Esc');
    await page.locator('[data-help-search]').fill('pdf');
    await expect(page.locator('[data-help-result]', { hasText: 'File ▸ Export' })).not.toHaveCount(0);
    await page.locator('[data-help-search]').fill('qwxyzzy');
    await expect(page.locator('.menu-empty')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-help-search]')).toHaveCount(0);
  });

  test('shortcuts can be changed: recorder, collision prompt, the new key works, the old one no longer, reset', async ({ page }) => {
    await login(page);
    await openDoc(page, 'recurrent_feature/main.tex');
    await page.locator('.lyx-editor > .lyx-par').first().click();
    // give "View ▸ Outline" the key Ctrl+Shift+9
    await page.keyboard.press('F1');
    await page.locator('[data-help-search]').fill('outline');
    const first = page.locator('[data-help-result]').first();
    await expect(first).toContainText('View ▸ Outline');
    await first.hover();
    await first.locator('[data-set-shortcut]').click();
    await expect(first.locator('[data-recording]')).toBeVisible();
    await page.keyboard.press('Control+Shift+9');
    await expect(first.locator('.shortcut')).toHaveText('Ctrl+Shift+9');
    await expect(first.locator('.shortcut')).toHaveClass(/custom/);
    expect(JSON.parse(await page.evaluate(() => localStorage.getItem('ol.keys')!))).toEqual({ 'View ▸ Outline': 'Ctrl+Shift+9' });
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-help-search]')).toHaveCount(0);
    // the new key toggles the outline; the default Ctrl+Alt+O does nothing any more
    await page.keyboard.press('Control+Shift+9');
    await expect(page.locator('.rail.left')).toBeVisible();
    await page.keyboard.press('Control+Alt+o');
    await expect(page.locator('.rail.left')).toBeVisible();
    await page.keyboard.press('Control+Shift+9');
    await expect(page.locator('.sidebar.left .docpanel')).toBeVisible();
    // the same key for another command: a prompt; accepting moves the key over
    let prompt = '';
    page.once('dialog', d => { prompt = d.message(); void d.accept(); });
    await page.keyboard.press('F1');
    await page.locator('[data-help-search]').fill('source pane');
    const src = page.locator('[data-help-result]', { hasText: 'View ▸ Source pane' }).first();
    await src.hover();
    await src.locator('[data-set-shortcut]').click();
    await page.keyboard.press('Control+Shift+9');
    await expect(src.locator('.shortcut')).toHaveText('Ctrl+Shift+9');
    expect(prompt).toContain('View ▸ Outline');
    expect(JSON.parse(await page.evaluate(() => localStorage.getItem('ol.keys')!))).toEqual({ 'View ▸ Outline': null, 'View ▸ Source pane (LaTeX, below the text)': 'Ctrl+Shift+9' });
    await page.locator('[data-help-search]').fill('outline');
    await expect(first.locator('.shortcut')).toHaveCount(0);   // no key at all now
    // declining keeps things as they are
    page.once('dialog', d => void d.dismiss());
    await first.hover();
    await first.locator('[data-set-shortcut]').click();
    await page.keyboard.press('Control+Shift+9');
    await expect(first.locator('[data-recording]')).toBeVisible();   // still recording
    await page.keyboard.press('Escape');
    // back to the default with ↺
    await first.hover();
    await first.locator('[data-reset-shortcut]').click();
    await expect(first.locator('.shortcut')).toHaveText('Ctrl+Alt+O');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+Shift+9');   // now the source pane
    await expect(page.locator('.source-pane')).toBeVisible();
    await page.keyboard.press('Control+Alt+o');    // the outline's default again
    await expect(page.locator('.rail.left')).toBeVisible();
  });
});

test.describe('source pane', () => {
  test('follows the cursor into a display formula (the row under the cursor is marked)', async ({ page }) => {
    await login(page);
    await openDoc(page, 'recurrent_feature/main.tex');
    const p = page.locator('.lyx-editor > .lyx-par.lyx-layout-standard').filter({ hasText: /neural network/i }).first();
    await p.click({ position: { x: 4, y: 8 } });
    await page.keyboard.press('Control+Alt+s');
    await expect(page.locator('.source-pane')).toBeVisible();
    await expect(page.locator('.source-pane .hl .hl-cmd')).not.toHaveCount(0, { timeout: 15000 });
    // a new two-row display formula at the end of that paragraph; the cursor ends in its second row
    await page.keyboard.press('End');
    await page.keyboard.press('Control+Shift+m');
    await expect(page.locator('.lm-field.display.focused')).toHaveCount(1, { timeout: 5000 });
    await page.keyboard.type('a=b');
    await page.keyboard.press('Enter');
    await page.keyboard.type('c=d');
    const markedLine = async () => page.evaluate(() => {
      const pre = document.querySelector('.source-pane pre.hl') as HTMLElement | null; const cur = pre?.querySelector('.cur') as HTMLElement | null;
      if (!pre || !cur) return null;
      const line = Array.from(pre.querySelectorAll('.l')).indexOf(cur);
      const ta = document.querySelector('.source-pane textarea') as HTMLTextAreaElement;
      return { line, text: ta.value.split('\n')[line] ?? '', scrolled: ta.scrollTop };
    });
    // the marked line is the formula's second row, and the pane scrolled there
    await expect.poll(async () => (await markedLine())?.text ?? '', { timeout: 10000 }).toMatch(/c.*=.*d/);
    const m1 = (await markedLine())!;
    expect(m1.scrolled).toBeGreaterThan(0);
    // up one row: the mark follows inside the formula
    await page.keyboard.press('ArrowUp');
    await expect.poll(async () => (await markedLine())?.text ?? '', { timeout: 5000 }).toMatch(/a.*=.*b/);
    expect((await markedLine())!.line).toBe(m1.line - 1);
    // leaving the formula into the text before it: the mark moves to the paragraph's text
    await page.keyboard.press('Escape');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.type('SRCMARK');
    await expect.poll(async () => (await markedLine())?.text ?? '', { timeout: 10000 }).toContain('SRCMARK');
  });
});

test.beforeEach(async ({ page }) => { await page.addInitScript(TOUR_SEEN_SCRIPT); });

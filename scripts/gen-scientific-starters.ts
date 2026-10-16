/** Regenerate the scientific examples; --previews also refreshes the chooser thumbnails.
 * npx tsx scripts/gen-scientific-starters.ts [--previews]
 * Preview generation uses the built runtime (npm run build) to typeset math and check layouts.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, extname, sep } from 'node:path';
import { createServer } from 'node:http';
import { SCIENTIFIC_TEMPLATES, scientificDeck, scientificPoster } from '../packages/core/src/html/scientific.ts';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, 'packages/server/templates/starters/web');
for (const t of SCIENTIFIC_TEMPLATES) {
  const folder = t.id === 'research' ? 'talk' : t.id === 'betterposter' ? 'poster' : `${t.kind === 'deck' ? 'talk' : 'poster'}-${t.id}`;
  const dest = resolve(out, folder, 'index.html');
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, t.kind === 'deck' ? scientificDeck('', t.id) : scientificPoster('', t.id));
  console.log(`${folder}/index.html`);
}

if (process.argv.includes('--previews')) {
  const { chromium } = await import('@playwright/test');
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    if (url.pathname === '/preview') {
      const t = SCIENTIFIC_TEMPLATES.find(t => t.id === url.searchParams.get('template'));
      if (!t) { res.writeHead(404).end(); return; }
      const html = t.kind === 'deck' ? scientificDeck('', t.id) : scientificPoster('', t.id);
      const runtime = '<script>window.__OL={mode:"check",runtimeBase:"/packages/client/dist/_ol/"}</script><script src="/packages/client/dist/_ol/runtime.js"></script>';
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(html.replace('<head>', '<head>' + runtime));
      return;
    }
    const path = resolve(root, '.' + decodeURIComponent(url.pathname));
    if (!path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    try {
      const mime: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
      res.writeHead(200, { 'Content-Type': mime[extname(path)] ?? 'application/octet-stream' }).end(readFileSync(path));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address() as { port: number };
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const previews = resolve(root, 'packages/client/public/templates');
  mkdirSync(previews, { recursive: true });
  try {
    for (const t of SCIENTIFIC_TEMPLATES) {
      const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
      await page.goto(`http://127.0.0.1:${address.port}/preview?template=${t.id}`);
      await page.waitForFunction(() => (window as any).__olReady === true, undefined, { timeout: 30000 });
      const report = await page.evaluate(() => (window as any).__ol.report());
      console.log(JSON.stringify({ template: t.id, report }));
      // Actual rendered page, reduced before capture; decks preview their main figure slide.
      await page.evaluate(({ width, poster }) => {
        const slides = [...document.querySelectorAll<HTMLElement>('.slide')];
        for (const [i, slide] of slides.entries()) {
          if (i !== (poster ? 0 : 2)) slide.remove();
          else { slide.style.zoom = String(400 / width); slide.style.margin = '0'; }
        }
      }, { width: t.kind === 'poster' ? t.width * 96 / 25.4 : t.width, poster: t.kind === 'poster' });
      await page.locator('.slide').screenshot({ path: resolve(previews, t.id + '.png') });
      await page.close();
    }
  } finally {
    await browser.close();
    await new Promise<void>((r, reject) => server.close(e => e ? reject(e) : r()));
  }
}

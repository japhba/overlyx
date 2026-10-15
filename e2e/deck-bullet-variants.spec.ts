/**
 * Selection ink must contain the actual painted list markers, not just an estimated gutter.
 * Fixtures exercise imported/native HTML list variants; all selection and manipulation are GUI
 * actions. A diagnostic observer records closed shadow roots without changing their mode or UI.
 * Python/Pillow only reads screenshot pixels; it does not edit images or author slide content.
 */
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { login, PROJECTS_DIR, collectErrors } from './helpers';

const cases = [
  { name: 'outside-bullets', tag: 'ul', attrs: '', css: '', rows: '<li>First marker row</li><li>Second marker row</li>' },
  { name: 'decimal-start', tag: 'ol', attrs: 'start="998"', css: '', rows: '<li>First marker row</li><li>Second marker row</li>' },
  { name: 'reversed', tag: 'ol', attrs: 'reversed start="103"', css: '', rows: '<li>First marker row</li><li>Second marker row</li>' },
  { name: 'explicit-value', tag: 'ol', attrs: 'start="0"', css: '', rows: '<li>First marker row</li><li value="10000">Second marker row</li>' },
  { name: 'rtl', tag: 'ul', attrs: 'dir="rtl"', css: '', rows: '<li>First marker row</li><li>Second marker row</li>' },
  { name: 'inside', tag: 'ol', attrs: '', css: 'list-style-position:inside;', rows: '<li>First marker row</li><li>Second marker row</li>' },
  { name: 'markerless', tag: 'ul', attrs: '', css: 'list-style-type:none;', rows: '<li>First marker row</li><li>Second marker row</li>' },
  { name: 'rotated-bullets', tag: 'ul', attrs: '', css: 'rotate:15deg;', rows: '<li>First marker row</li><li>Second marker row</li>' },
];

const ANALYZE = String.raw`
import json, sys, math
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGB')
m = json.loads(sys.argv[2])
clip, f = m['clip'], m['frame']
sx, sy = im.width/clip['width'], im.height/clip['height']
c, s = math.cos(f['angle']), math.sin(f['angle'])
points = []
for y in range(im.height):
    for x in range(im.width):
        r, g, b = im.getpixel((x,y))
        # Exclude blue selection ink, the white-on-blue object label, and anti-aliased light pixels.
        if max(r,g,b) < 100:
            dx = clip['x']+(x+.5)/sx-f['cx']
            dy = clip['y']+(y+.5)/sy-f['cy']
            points.append((c*dx+s*dy, -s*dx+c*dy))
if not points:
    raise RuntimeError('No painted list text/marker pixels were measured')
xs, ys = zip(*points)
print(json.dumps({'pixels':len(points), 'minX':min(xs), 'maxX':max(xs),
    'minY':min(ys), 'maxY':max(ys), 'halfWidth':f['width']/2,
    'halfHeight':f['height']/2}))
`;

test('selection contains outside, numbered, reversed, RTL and rotated list ink; handles retain the CSS box', async ({ page }, info) => {
  const errors = collectErrors(page);
  const key = `admin/e2e-bullet-variants-${Date.now().toString(36)}-${info.project.name}`;
  const directory = `${PROJECTS_DIR}/${key}`;
  const file = `${directory}/slides/index.html`;
  mkdirSync(`${directory}/slides`, { recursive: true });
  const body = cases.map(c => `<section class="slide"><${c.tag} id="${c.name}" ${c.attrs} style="${c.css}">${c.rows}</${c.tag}></section>`).join('\n');
  writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8"><meta name="overlyx" content="deck"><style>
    body{margin:0;background:#ddd}.slide{width:1280px;height:720px;position:relative;overflow:hidden;background:white}
    ul,ol{position:absolute;left:200px;top:230px;width:780px;height:120px;margin:0;padding:0;font:32px/1.4 Arial,sans-serif;color:#111}
    </style></head><body>${body}</body></html>`);
  await page.addInitScript(() => {
    const original = Element.prototype.attachShadow;
    const roots: ShadowRoot[] = [];
    (window as unknown as { __deckSelectionRoots: ShadowRoot[] }).__deckSelectionRoots = roots;
    Element.prototype.attachShadow = function(init) {
      const root = original.call(this, init);
      if (this.localName === 'ol-overlay') roots.push(root);
      return root;
    };
  });
  try {
    await login(page);
    await page.request.get('/api/projects');
    await page.goto(`/#/${key}/slides/index.html`);
    const frame = page.frameLocator('.dl-frame');
    await expect(frame.locator('section.slide')).toHaveCount(cases.length, { timeout: 30000 });
    await page.locator('[data-dl-zoom]').selectOption('75');
    const results: unknown[] = [];
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i];
      await page.frameLocator('.dl-railframe').locator('section.slide').nth(i).click();
      const list = frame.locator(`#${c.name}`);
      await expect(list).toBeVisible();
      await list.locator('li').first().click();
      const metrics = await frame.locator('html').evaluate(() => {
        const roots = (window as unknown as { __deckSelectionRoots: ShadowRoot[] }).__deckSelectionRoots;
        const overlay = roots.at(-1);
        const box = overlay?.querySelector<HTMLElement>('.frame:not(.peer):not(.ctx)');
        const handle = overlay?.querySelector<HTMLElement>('.handle[data-h="e"]');
        if (!box || !handle) return null;
        const r = box.getBoundingClientRect();
        const matrix = new DOMMatrix(getComputedStyle(box).transform);
        const h = handle.getBoundingClientRect();
        return { cx: r.x + r.width/2, cy: r.y + r.height/2,
          width: parseFloat(box.style.width), height: parseFloat(box.style.height), angle: Math.atan2(matrix.b, matrix.a),
          handle: { x: h.x+h.width/2, y: h.y+h.height/2 } };
      });
      expect(metrics, `${c.name}: selection frame and CSS-box handle`).not.toBeNull();
      if (!metrics) throw new Error(`${c.name}: no native selection overlay`);
      const iframe = page.locator('.dl-frame');
      const parentBox = (await iframe.boundingBox())!;
      const intrinsic = await iframe.evaluate(el => ({ width: el.clientWidth, height: el.clientHeight }));
      const scale = parentBox.width / intrinsic.width;
      const objectBox = (await list.boundingBox())!;
      const view = page.viewportSize()!;
      const x = Math.max(0, Math.floor(objectBox.x - 160*scale));
      const y = Math.max(0, Math.floor(objectBox.y - 40*scale));
      const right = Math.min(view.width, Math.ceil(objectBox.x + objectBox.width + 160*scale));
      const bottom = Math.min(view.height, Math.ceil(objectBox.y + objectBox.height + 40*scale));
      const clip = { x, y, width: right-x, height: bottom-y };
      const image = info.outputPath(`${c.name}.png`);
      await page.screenshot({ path: image, clip });
      const selected = { cx: parentBox.x+metrics.cx*scale, cy: parentBox.y+metrics.cy*scale,
        width: metrics.width*scale, height: metrics.height*scale, angle: metrics.angle };
      const ink = JSON.parse(execFileSync('python3', ['-c', ANALYZE, image, JSON.stringify({ clip, frame:selected })], { encoding:'utf8' }));
      results.push({ case:c.name, ink, selection:metrics });
      // Soft assertions retain all variant screenshots/measurements when one branch fails.
      expect.soft(ink.minX, `${c.name}: left painted ink inside outline`).toBeGreaterThanOrEqual(-ink.halfWidth-1);
      expect.soft(ink.maxX, `${c.name}: right painted ink inside outline`).toBeLessThanOrEqual(ink.halfWidth+1);
      expect.soft(ink.minY, `${c.name}: top painted ink inside outline`).toBeGreaterThanOrEqual(-ink.halfHeight-1);
      expect.soft(ink.maxY, `${c.name}: bottom painted ink inside outline`).toBeLessThanOrEqual(ink.halfHeight+1);
      const css = await list.evaluate(el => {
        const s = getComputedStyle(el), r = el.getBoundingClientRect(), a = parseFloat(s.rotate)||0;
        return { cx:r.x+r.width/2, cy:r.y+r.height/2, width:(el as HTMLElement).offsetWidth,
          height:(el as HTMLElement).offsetHeight, angle:a*Math.PI/180 };
      });
      const east = { x:css.cx+Math.cos(css.angle)*css.width/2, y:css.cy+Math.sin(css.angle)*css.width/2 };
      expect.soft(Math.abs(metrics.handle.x-east.x), `${c.name}: east resize handle uses CSS box`).toBeLessThan(0.6);
      expect.soft(Math.abs(metrics.handle.y-east.y), `${c.name}: east resize handle uses CSS box`).toBeLessThan(0.6);
      if (c.name === 'inside' || c.name === 'markerless') {
        expect.soft(metrics.width, `${c.name}: no phantom outside gutter`).toBeCloseTo(css.width, 2);
      }
    }
    writeFileSync(info.outputPath('list-selection-measurements.json'), JSON.stringify(results, null, 2));
    expect(errors).toEqual([]);
  } finally {
    rmSync(directory, { recursive:true, force:true });
  }
});

// pdf.js on its own in each engine: a page with a JPEG photograph beside a PNG plot — which image lands where?
// Usage: pdfjsimg.mts <pdf> [legacy|modern]
import { webkit, firefox, chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
const pdf = readFileSync(process.argv[2]).toString('base64');
const build = process.argv[3] ?? 'legacy';
const root = '/@fs/root/lyx/overlyx-fix-browsers/node_modules/pdfjs-dist/' + (build === 'legacy' ? 'legacy/build' : 'build');
for (const [name, bt] of [['webkit', webkit], ['firefox', firefox], ['chromium', chromium]] as const) {
  const b = await bt.launch(); const p = await b.newPage();
  await p.goto('http://localhost:5207/');
  for (const opts of [{}, { isOffscreenCanvasSupported: false }, { isImageDecoderSupported: false }]) {
    const r = await p.evaluate(`(async () => {
      const b64 = ${JSON.stringify(pdf)}, root = ${JSON.stringify(root)}, opts = ${JSON.stringify(opts)};
      const pdfjs = await import(root + '/pdf.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = root + '/pdf.worker.min.mjs';
      const data = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const doc = await pdfjs.getDocument({ data, ...opts }).promise;
      const page = await doc.getPage(1);
      const vp = page.getViewport({ scale: 1 });
      const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
      await page.render({ canvasContext: c.getContext('2d'), canvas: c, viewport: vp }).promise;
      const x = c.getContext('2d');
      const out = {};
      for (const [k, fx0, fx1] of [['left', 0.25, 0.45], ['right', 0.55, 0.75]]) {
        const d = x.getImageData(Math.floor(vp.width * fx0), Math.floor(vp.height * 0.2), Math.floor(vp.width * (fx1 - fx0)), Math.floor(vp.height * 0.08)).data;
        let r = 0, g = 0, bb = 0, n = 0; for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; bb += d[i + 2]; n++; }
        out[k] = [Math.round(r / n), Math.round(g / n), Math.round(bb / n)];
      }
      await (doc.destroy ? doc.destroy() : doc.loadingTask?.destroy?.());
      return JSON.stringify(out);
    })()`) as string;
    console.log(name, build, JSON.stringify(opts), r);
  }
  await b.close();
}

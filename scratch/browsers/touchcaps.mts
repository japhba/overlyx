// what the engines report for a touch device context: maxTouchPoints, pointer media queries, ontouchstart
import { webkit, firefox, chromium } from '@playwright/test';
for (const [name, bt] of [['webkit', webkit], ['firefox', firefox], ['chromium', chromium]] as const) {
  const b = await bt.launch();
  for (const opts of [{ hasTouch: true }, { hasTouch: true, isMobile: true }]) {
    let ctx;
    try { ctx = await b.newContext(opts); } catch (e) { console.log(name, JSON.stringify(opts), 'ERROR', String(e).split('\n')[0].slice(0, 100)); continue; }
    const p = await ctx.newPage();
    console.log(name, JSON.stringify(opts), await p.evaluate(() => JSON.stringify({ mtp: navigator.maxTouchPoints, coarse: matchMedia('(pointer: coarse)').matches, anyCoarse: matchMedia('(any-pointer: coarse)').matches, hoverNone: matchMedia('(hover: none)').matches, touch: 'ontouchstart' in window })));
    await ctx.close();
  }
  await b.close();
}

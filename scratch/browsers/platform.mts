import { webkit, firefox, chromium, devices } from '@playwright/test';
for (const [name, bt, dev] of [['webkit', webkit, devices['Desktop Safari']], ['firefox', firefox, devices['Desktop Firefox']], ['ipad', webkit, devices['iPad Pro 11']]] as const) {
  const b = await bt.launch();
  const ctx = await b.newContext({ ...dev });
  const p = await ctx.newPage();
  await p.goto('http://localhost:5207/');
  console.log(name, await p.evaluate(() => JSON.stringify({ platform: navigator.platform, ua: navigator.userAgent, ric: typeof (window as any).requestIdleCallback, touch: navigator.maxTouchPoints, clip: typeof navigator.clipboard?.read, sw: 'serviceWorker' in navigator })));
  await b.close();
}

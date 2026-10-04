import { webkit, firefox, chromium, devices } from '@playwright/test';
const which = process.argv[2];
for (const [name, bt, dev] of [['webkit', webkit, devices['Desktop Safari']], ['firefox', firefox, devices['Desktop Firefox']], ['chromium', chromium, devices['Desktop Chrome']]] as const) {
  if (which && which !== name) continue;
  const b = await bt.launch();
  const ok: string[] = [];
  for (const perm of ['clipboard-read', 'clipboard-write']) { const c = await b.newContext(); try { await c.grantPermissions([perm]); await c.newPage(); ok.push(perm); } catch (e) { ok.push('!' + perm); } await c.close(); }
  const ctx = await b.newContext({ ...dev });
  for (const perm of ok.filter(p => !p.startsWith('!'))) await ctx.grantPermissions([perm]);
  const p = await ctx.newPage();
  await p.goto('http://localhost:5207/');
  await p.setContent('<textarea id=t></textarea><div contenteditable id=d>hello</div>');
  const r: any = {};
  r.write = await p.evaluate(async () => { try { await navigator.clipboard.writeText('abc'); return 'ok'; } catch (e) { return String(e); } });
  r.read = await p.evaluate(async () => { try { return await Promise.race([navigator.clipboard.readText(), new Promise(r => setTimeout(() => r('timeout'), 2000))]); } catch (e) { return String(e); } });
  await p.click('#d'); await p.keyboard.press('Control+a'); await p.keyboard.press('Control+c');
  r.readAfterCtrlC = await p.evaluate(async () => { try { return await Promise.race([navigator.clipboard.readText(), new Promise(r => setTimeout(() => r('timeout'), 2000))]); } catch (e) { return String(e); } });
  await p.click('#t'); await p.keyboard.press('Control+v');
  r.pasted = await p.evaluate(() => (document.getElementById('t') as HTMLTextAreaElement).value);
  await p.fill('#t', ''); 
  await p.click('#d'); await p.keyboard.press('Meta+a'); await p.keyboard.press('Meta+c');
  await p.click('#t'); await p.keyboard.press('Meta+v');
  r.metaPasted = await p.evaluate(() => (document.getElementById('t') as HTMLTextAreaElement).value);
  console.log(name, ok.join(','), JSON.stringify(r));
  await b.close();
}

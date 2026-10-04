// does a context emulated offline still open WebSockets? (the built app on the server's own port, signed in) per engine
import { webkit, firefox, chromium } from '@playwright/test';
import { apiLogin } from '../../e2e/helpers';
for (const [name, bt] of [['webkit', webkit], ['firefox', firefox], ['chromium', chromium]] as const) {
  const b = await bt.launch(); const ctx = await b.newContext({ baseURL: 'http://127.0.0.1:3037' });
  const res = await ctx.request.post('http://127.0.0.1:3037/api/auth/login', { data: (await import('../../e2e/helpers')).adminCredentials() });
  const p = await ctx.newPage();
  await p.goto('http://127.0.0.1:3037/');
  const tryWs = () => p.evaluate(() => new Promise<string>(res => {
    const ws = new WebSocket(`ws://${location.host}/ws?doc=${encodeURIComponent('admin/e2e-probe/main.tex')}`);
    ws.onopen = () => { ws.close(); res('ws OPEN'); };
    ws.onerror = () => res('ws error');
    setTimeout(() => res('ws timeout'), 5000);
  }));
  const online = await tryWs();
  await ctx.setOffline(true);
  const offline = await tryWs();
  console.log(name, 'login', res.status(), 'online:', online, 'offline:', offline);
  await b.close();
}

// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Client = typeof import('../packages/client/src/usage.ts');
type Prefs = typeof import('../packages/client/src/prefs.ts');
type SentBatch = { url: string; body: any };

let usage: Client, prefs: Prefs, sent: SentBatch[], responseStatus: number, offline: boolean;
const originalFetch = globalThis.fetch;
const originalApiBase = (globalThis as typeof globalThis & { OVERLYX_API_BASE?: string }).OVERLYX_API_BASE;

async function loadClient(apiBase = ''): Promise<void> {
  vi.resetModules();
  localStorage.removeItem('ol.prefs');
  (globalThis as typeof globalThis & { OVERLYX_API_BASE?: string }).OVERLYX_API_BASE = apiBase;
  prefs = await import('../packages/client/src/prefs.ts');
  usage = await import('../packages/client/src/usage.ts');
  sent = [];
  responseStatus = 200;
  offline = false;
  globalThis.fetch = vi.fn(async (url: any, init: any) => {
    sent.push({ url: String(url), body: JSON.parse(init.body) });
    if (offline) throw new TypeError('network unavailable');
    return { ok: responseStatus < 400, status: responseStatus } as Response;
  }) as any;
}

function setGpc(value: boolean | undefined): void {
  if (value === undefined) delete (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl;
  else Object.defineProperty(navigator, 'globalPrivacyControl', { configurable: true, value });
}

beforeEach(async () => {
  setGpc(undefined);
  await loadClient();
  prefs.setPref('usageStats', true);
});

afterEach(() => {
  usage?.resetUsageForTests();
  globalThis.fetch = originalFetch;
  if (originalApiBase === undefined) delete (globalThis as typeof globalThis & { OVERLYX_API_BASE?: string }).OVERLYX_API_BASE;
  else (globalThis as typeof globalThis & { OVERLYX_API_BASE?: string }).OVERLYX_API_BASE = originalApiBase;
  setGpc(undefined);
});

describe('optional reliability diagnostics', () => {
  it('defaults off, and explicit beta plus usage consent queues only canonical event fields', async () => {
    expect(prefs.getPrefs().betaDiagnostics).toBe(false);
    expect(usage.reliabilityEnabled()).toBe(false);
    usage.recordReliability('gesture.cancelled', { pointer: 'touch', context: 'poster', durationMs: 251 });
    expect(usage.pendingUsage()).toEqual([]);

    prefs.setPref('betaDiagnostics', true);
    expect(usage.reliabilityEnabled()).toBe(true);
    usage.recordReliability('gesture.cancelled', { pointer: 'touch', context: 'poster', durationMs: 251 });
    expect(usage.pendingUsage()).toEqual([{ name: 'reliability', detail: 'gesture.cancelled touch', where: 'poster', dt: 500, ago: expect.any(Number) }]);
    await usage.flushUsage();
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('/api/usage');
    expect(sent[0].body).toMatchObject({ reliabilityConsent: true, events: [{
      name: 'reliability', detail: 'gesture.cancelled touch', where: 'poster', dt: 500,
    }] });
    expect(Object.keys(sent[0].body.events[0]).sort()).toEqual(['ago', 'detail', 'dt', 'name', 'where']);
  });

  it('requires usage consent, no GPC signal, and the web app rather than the VS Code bridge', async () => {
    prefs.setPref('betaDiagnostics', true);
    prefs.setPref('usageStats', false);
    expect(usage.reliabilityEnabled()).toBe(false);
    usage.recordReliability('canvas.retry');
    expect(usage.pendingUsage()).toEqual([]);

    prefs.setPref('usageStats', true);
    setGpc(true);
    expect(usage.reliabilityEnabled()).toBe(false);
    usage.recordReliability('canvas.retry');
    expect(usage.pendingUsage()).toEqual([]);
    setGpc(false);
    expect(usage.reliabilityEnabled()).toBe(true);

    await loadClient('/vscode-bridge');
    prefs.setPref('usageStats', true);
    prefs.setPref('betaDiagnostics', true);
    expect(usage.reliabilityEnabled()).toBe(false);
    usage.recordReliability('canvas.retry');
    expect(usage.pendingUsage()).toEqual([]);
    await usage.flushUsage();
    expect(sent).toEqual([]);
  });

  it('purges pending diagnostics immediately when beta consent is withdrawn, including an off-on cycle before flush', async () => {
    prefs.setPref('betaDiagnostics', true);
    usage.recordReliability('save.pending', { context: 'document' });
    expect(usage.pendingUsage()).toHaveLength(1);

    prefs.setPref('betaDiagnostics', false);
    prefs.setPref('betaDiagnostics', true);
    await usage.flushUsage();
    expect(sent).toEqual([]);
    expect(usage.pendingUsage()).toEqual([]);
  });

  it('does not requeue diagnostics when consent is withdrawn while a failed request is in flight', async () => {
    prefs.setPref('betaDiagnostics', true);
    let requestStarted!: () => void;
    let rejectRequest!: (reason: unknown) => void;
    const started = new Promise<void>(resolve => { requestStarted = resolve; });
    globalThis.fetch = vi.fn((url: any, init: any) => {
      sent.push({ url: String(url), body: JSON.parse(init.body) });
      requestStarted();
      return new Promise((_, reject) => { rejectRequest = reject; });
    }) as any;

    usage.recordReliability('canvas.retry');
    const flight = usage.flushUsage();
    await started;
    prefs.setPref('betaDiagnostics', false);
    rejectRequest(new TypeError('network unavailable'));
    await flight;
    prefs.setPref('betaDiagnostics', true);
    await usage.flushUsage();

    expect(sent).toHaveLength(1);
    expect(usage.pendingUsage()).toEqual([]);
  });

  it('does not requeue an old diagnostic after consent is turned off then back on before request failure', async () => {
    prefs.setPref('betaDiagnostics', true);
    let requestStarted!: () => void;
    let rejectRequest!: (reason: unknown) => void;
    const started = new Promise<void>(resolve => { requestStarted = resolve; });
    globalThis.fetch = vi.fn((url: any, init: any) => {
      sent.push({ url: String(url), body: JSON.parse(init.body) });
      requestStarted();
      return new Promise((_, reject) => { rejectRequest = reject; });
    }) as any;

    usage.recordReliability('save.pending', { context: 'deck' });
    const flight = usage.flushUsage();
    await started;
    prefs.setPref('betaDiagnostics', false);
    prefs.setPref('betaDiagnostics', true);
    rejectRequest(new TypeError('network unavailable'));
    await flight;
    await usage.flushUsage();

    expect(sent).toHaveLength(1);
    expect(usage.pendingUsage()).toEqual([]);
  });

  it('stops all queued and future telemetry after the server returns 204', async () => {
    prefs.setPref('betaDiagnostics', true);
    usage.recordReliability('diagnostics.enabled');
    responseStatus = 204;
    await usage.flushUsage();
    usage.recordReliability('app.hidden');
    usage.recordUsage('menu', 'File ▸ Open');
    await usage.flushUsage();
    expect(sent).toHaveLength(1);
    expect(sent[0].body.events).toHaveLength(1);
    expect(usage.pendingUsage()).toEqual([]);
    expect(usage.reliabilityEnabled()).toBe(false);
  });

  it('queues only allowlisted events and buckets durations; hostile detail/context/duration inputs never escape', async () => {
    prefs.setPref('betaDiagnostics', true);
    const hostile = [
      'gesture.cancelled pen project/private/main.tex formula=x=3 at 120,240 https://secret.invalid/token',
      'canvas.timeout mouse math “customer text” /projects/name',
      'save.failed password=private',
    ];
    for (const detail of hostile) usage.recordUsage('reliability' as any, detail, { where: 'math', dt: 250 });
    usage.recordUsage('reliability' as any, 'gesture.cancelled pen', { where: 'math x=123', dt: 250 });
    usage.recordReliability('save.failed' as any, { pointer: 'pressure=0.9' as any, context: 'document /private' as any, durationMs: 5 });
    usage.recordReliability('save.failed', { context: 'math', durationMs: Number.NaN });

    usage.recordReliability('gesture.cancelled', { pointer: 'pen', context: 'math', durationMs: 0.1 });
    usage.recordReliability('canvas.timeout', { context: 'ui', durationMs: 251 });
    usage.recordReliability('app.hidden', { context: 'portrait', durationMs: 90000 });
    usage.recordReliability('app.resumed');
    const queued = usage.pendingUsage();
    expect(queued).toHaveLength(4);
    expect(queued.map(event => event.dt)).toEqual([250, 500, 60000, undefined]);
    expect(queued.map(event => event.detail)).toEqual([
      'gesture.cancelled pen', 'canvas.timeout none', 'app.hidden none', 'app.resumed none',
    ]);
    await usage.flushUsage();
    const serialized = JSON.stringify(sent[0].body);
    for (const privateValue of ['customer text', 'projects/name', 'secret.invalid', 'password=private', '120,240', 'pressure=0.9']) {
      expect(serialized).not.toContain(privateValue);
    }
    expect(sent[0].body.events.every((event: any) => event.name === 'reliability')).toBe(true);
  });

  it('keeps only a bounded canonical queue when offline', async () => {
    prefs.setPref('betaDiagnostics', true);
    offline = true;
    for (let i = 0; i < 521; i++) usage.recordReliability('gesture.cancelled', { pointer: 'touch', context: 'page', durationMs: 500 });
    // Drain any automatic batches and let their rejected requests be requeued before inspecting.
    await usage.flushUsage();
    const queued = usage.pendingUsage();
    expect(queued).toHaveLength(500);
    expect(queued.every(event => event.name === 'reliability' && event.detail === 'gesture.cancelled touch' && event.where === 'page' && event.dt === 500)).toBe(true);
    expect(JSON.stringify(queued)).not.toMatch(/projects|https?:|formula|coordinates|pressure/i);
  });
});

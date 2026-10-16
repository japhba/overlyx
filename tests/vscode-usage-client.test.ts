// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { delete (globalThis as any).OVERLYX_API_BASE; delete (globalThis as any).OVERLYX_USAGE_ENABLED; delete (globalThis as any).OVERLYX_VIEW_KIND; vi.unstubAllGlobals(); });

describe('host-gated VS Code webview usage', () => {
  it('sends only to the local bridge and immediately discards queued data when policy changes', async () => {
    vi.resetModules();
    (globalThis as any).OVERLYX_API_BASE = 'http://127.0.0.1:12345/t/test-token';
    (globalThis as any).OVERLYX_USAGE_ENABLED = true;
    (globalThis as any).OVERLYX_VIEW_KIND = 'editor';
    const prefs = await import('../packages/client/src/prefs.ts');
    const usage = await import('../packages/client/src/usage.ts');
    prefs.setPref('usageStats', true);
    const sent: { url: string; body: any }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { sent.push({ url, body: JSON.parse(String(init.body)) }); return { ok: true, status: 200 }; }));
    usage.initUsage();
    usage.recordInteraction('delete', 'unchanged', { target: 'note', content: 'empty' });
    await usage.flushUsage();
    expect(sent[0].url).toBe('http://127.0.0.1:12345/t/test-token/api/usage');
    expect(sent[0].body.events).toContainEqual(expect.objectContaining({ name: 'view', detail: 'editor' }));
    expect(JSON.stringify(sent[0].body)).not.toContain('test-token');
    usage.recordInteraction('cut', 'removed', { target: 'note' });
    (globalThis as any).OVERLYX_USAGE_ENABLED = false;
    window.dispatchEvent(new Event('ol:usage-policy'));
    expect(usage.pendingUsage()).toEqual([]);
    usage.recordInteraction('delete', 'failed');
    expect(usage.pendingUsage()).toEqual([]);
    (globalThis as any).OVERLYX_USAGE_ENABLED = true;
    window.dispatchEvent(new Event('ol:usage-policy'));
    await usage.flushUsage();
    expect(sent[1].body.session).not.toBe(sent[0].body.session);
    expect(sent[1].body.events.every((e: any) => ['session', 'view'].includes(e.name))).toBe(true);
    usage.resetUsageForTests();
  });
});

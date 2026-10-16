import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeInteractionDetail } from '../packages/core/src/interactions.ts';

const state = vi.hoisted(() => ({ enabled: true, level: 'all', usage: true, errors: true, configListeners: [] as ((event: any) => void)[] }));
vi.mock('vscode', () => ({
  version: '1.99.0', UIKind: { Web: 2 },
  env: {
    get isTelemetryEnabled() { return state.enabled; }, uiKind: 1, remoteName: 'ssh-remote',
    createTelemetryLogger: (sender: any) => ({
      get isUsageEnabled() { return state.enabled && state.level === 'all'; },
      onDidChangeEnableStates: () => ({ dispose() {} }),
      logUsage(name: string, data: any) { if (this.isUsageEnabled) sender.sendEventData(name, data); },
      logError(name: string, data: any) { if (state.enabled && ['all', 'error'].includes(state.level)) sender.sendEventData(name, data); },
      dispose() { void sender.flush(); },
    }),
  },
  workspace: {
    getConfiguration: (section: string) => ({ get: (key: string, fallback: any) => section === 'telemetry' ? state.level : key === 'usageStatistics' ? state.usage : key === 'errorReports' ? state.errors : fallback }),
    onDidChangeConfiguration: (listener: (event: any) => void) => { state.configListeners.push(listener); return { dispose() {} }; },
  },
  window: { createOutputChannel: () => ({ error() {}, debug() {}, dispose() {} }) },
}));

const { OverlyxTelemetry } = await import('../packages/vscode/src/host/telemetry.ts');
const sent: { url: string; body: any }[] = [];
let telemetry: InstanceType<typeof OverlyxTelemetry>;
beforeEach(() => {
  Object.assign(state, { enabled: true, level: 'all', usage: true, errors: true, configListeners: [] });
  sent.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, opts: RequestInit) => { sent.push({ url, body: JSON.parse(String(opts.body)) }); return { ok: true, status: 200 }; }));
  telemetry = new OverlyxTelemetry({ extension: { packageJSON: { version: '1.2.3' } } } as any);
});
afterEach(async () => { telemetry.dispose(); await telemetry.flush(); vi.unstubAllGlobals(); });

describe('anonymous VS Code usage telemetry', () => {
  it('passes native and webview events through the logger and sends only whitelisted metadata and fields', async () => {
    telemetry.track('extension-build', 'failed', 251);
    const n = telemetry.usageBatch({ session: 'abcdef0123456789', events: [
      { name: 'interaction', detail: makeInteractionDetail('delete', 'unchanged', { content: 'empty' }), where: 'note', docId: 'alice/secret/main.tex', text: 'private contents' },
      { name: 'toolbar', detail: 'Open “secret main.tex”', where: 'ui', username: 'alice' },
      { name: 'interaction', detail: 'private contents', where: 'note' },
    ], user: 'alice', cwd: '/root/private' });
    expect(n).toBe(2);
    await telemetry.flush();
    expect(sent).toHaveLength(2);
    expect(sent.every(s => s.url === 'https://overlyx.app/api/vscode-usage')).toBe(true);
    expect(sent[0].body).toMatchObject({ schema: 1, extensionVersion: '1.2.3', vscodeVersion: '1.99.0', remote: 'remote', uiKind: 'desktop' });
    expect(sent[0].body.events).toContainEqual(expect.objectContaining({ name: 'interaction', dt: 500 }));
    expect(JSON.stringify(sent)).not.toMatch(/alice|secret|private|main\.tex|machineId|sessionId|\/root/);
    expect(Object.keys(sent[0].body).sort()).toEqual(['arch', 'events', 'extensionVersion', 'platform', 'reliabilityConsent', 'remote', 'schema', 'session', 'uiKind', 'vscodeVersion']);
  });

  it('requires VS Code level All and the extension usage setting', async () => {
    for (const disabled of [{ enabled: false }, { level: 'error' }, { level: 'crash' }, { level: 'off' }, { usage: false }]) {
      Object.assign(state, { enabled: true, level: 'all', usage: true }, disabled);
      telemetry.track('extension-open', 'success');
      expect(telemetry.usageBatch({ session: 'abcdef0123456789', events: [{ name: 'menu', detail: 'File' }] })).toBe(0);
    }
    await telemetry.flush();
    expect(sent).toEqual([]);
  });

  it('purges queued data on revocation even after an off/on cycle and rotates the activation ID', async () => {
    telemetry.track('extension-open', 'success'); await telemetry.flush();
    const first = sent[0].body.session;
    sent.length = 0;
    telemetry.track('extension-save', 'success');
    state.usage = false;
    for (const listener of state.configListeners) listener({ affectsConfiguration: () => true });
    state.usage = true;
    for (const listener of state.configListeners) listener({ affectsConfiguration: () => true });
    await telemetry.flush();
    expect(sent).toEqual([]);
    telemetry.track('extension-build', 'success'); await telemetry.flush();
    expect(sent[0].body.session).not.toBe(first);
  });
});

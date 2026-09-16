import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ source: '/test/live', liveCheck: vi.fn(), liveSchedule: vi.fn(), release: vi.fn(), install: vi.fn() }));
vi.mock('vscode', () => ({
  ExtensionMode: { Production: 1 },
  workspace: { getConfiguration: () => ({ get: (key: string) => key === 'developmentPath' ? state.source : key === 'updates' ? 'off' : undefined }) },
  commands: { executeCommand: state.install },
  window: { showInformationMessage: vi.fn() },
}));
vi.mock('../packages/vscode/src/host/liveUpdater.ts', () => ({ LiveUpdater: class { schedule() { state.liveSchedule(); } check() { return state.liveCheck(); } } }));
vi.mock('../packages/vscode/src/host/updateCheck.ts', () => ({ fetchLatestRelease: state.release, isNewer: () => true }));
import { Updater } from '../packages/vscode/src/host/updater.ts';
const context = () => ({ extensionMode: 1, extension: { packageJSON: { version: '0.4.1' } }, subscriptions: [], globalState: { get: () => undefined, update: vi.fn() } }) as any;
beforeEach(() => { vi.clearAllMocks(); state.source = '/test/live'; state.liveCheck.mockResolvedValue({ status: 'up-to-date', head: 'local-commit', upstream: 'upstream-commit' }); state.release.mockResolvedValue(null); });

it('checks source commits for a live install, even when release updates are off', async () => {
  const updater = new Updater(context()); updater.schedule();
  expect(state.liveSchedule).toHaveBeenCalledOnce();
  expect(await updater.check()).toEqual({ status: 'live-up-to-date', current: 'local-commit', latest: 'upstream-commit' });
  expect(state.release).not.toHaveBeenCalled(); expect(state.install).not.toHaveBeenCalled();
});

it('keeps release checking for a normal VSIX install', async () => {
  state.source = '';
  expect((await new Updater(context()).check()).status).toBe('no-release');
  expect(state.release).toHaveBeenCalledOnce(); expect(state.liveCheck).not.toHaveBeenCalled();
});

/**
 * Self-update from GitHub releases (the extension is distributed as a .vsix, not through the
 * marketplace, so VS Code will not update it by itself): once a day — and on demand through
 * "OverLyX: Check for Updates" — the latest release is compared with the running version; a newer
 * .vsix is downloaded and installed with the built-in installExtension command, then VS Code only
 * needs a reload. `overlyx.updates`: "prompt" (default) asks first, "auto" installs silently,
 * "off" only leaves the manual command.
 */
import * as vscode from 'vscode';
import fs from 'node:fs';
import path from 'node:path';
import { fetchLatestRelease, isNewer, type ReleaseInfo } from './updateCheck.ts';

const DEFAULT_REPO = 'japhba/overlyx';
const CHECK_EVERY_MS = 20 * 60 * 60 * 1000;   // ~daily, tolerant of laptops sleeping

export interface CheckResult {
  status: 'up-to-date' | 'update-available' | 'installed' | 'skipped' | 'no-release' | 'dry-run-downloaded';
  current: string;
  latest?: string;
  vsixPath?: string;
}

export class Updater {
  constructor(private context: vscode.ExtensionContext) {}

  private get currentVersion(): string { return String(this.context.extension.packageJSON.version ?? '0.0.0'); }
  private get config() { return vscode.workspace.getConfiguration('overlyx'); }

  /** Kick off the periodic check (production installs only — a dev host updating itself would be chaos). */
  schedule(): void {
    if (this.context.extensionMode !== vscode.ExtensionMode.Production) return;
    if (this.config.get<string>('updates') === 'off') return;
    const last = this.context.globalState.get<number>('updateLastCheck') ?? 0;
    const delay = Math.max(10_000, last + CHECK_EVERY_MS - Date.now());
    const timer = setTimeout(() => { void this.check({ interactive: false }).catch(() => { /* offline etc. */ }); }, delay);
    this.context.subscriptions.push({ dispose: () => clearTimeout(timer) });
  }

  /**
   * One check. `interactive` = the user asked (always report a result); `dryRun` stops after the
   * download (the integration test exercises the pipeline without installing into the host).
   */
  async check(opts: { interactive: boolean; apiOverride?: string; dryRun?: boolean } = { interactive: true }): Promise<CheckResult> {
    void this.context.globalState.update('updateLastCheck', Date.now());
    const repo = this.config.get<string>('updateRepo') || DEFAULT_REPO;
    const apiOverride = opts.apiOverride ?? this.config.get<string>('updateApi') ?? undefined;
    const current = this.currentVersion;
    const rel = await fetchLatestRelease(repo, apiOverride || undefined);
    if (!rel) {
      if (opts.interactive) void vscode.window.showInformationMessage(`OverLyX ${current}: no published release found.`);
      return { status: 'no-release', current };
    }
    if (!isNewer(rel.version, current)) {
      if (opts.interactive) void vscode.window.showInformationMessage(`OverLyX ${current} is up to date.`);
      return { status: 'up-to-date', current, latest: rel.version };
    }
    if (!opts.interactive && this.context.globalState.get<string>('updateSkip') === rel.version) {
      return { status: 'skipped', current, latest: rel.version };
    }

    const mode = this.config.get<string>('updates') ?? 'prompt';
    // a dry run (tests) never prompts — showInformationMessage would wait for a human forever
    if (!opts.interactive && !opts.dryRun && mode === 'prompt') {
      const pick = await vscode.window.showInformationMessage(
        `OverLyX ${rel.version} is available (you have ${current}).`, 'Update', 'What changed', 'Skip this version');
      if (pick === 'What changed') { if (rel.url) void vscode.env.openExternal(vscode.Uri.parse(rel.url)); return this.check(opts); }
      if (pick === 'Skip this version') { void this.context.globalState.update('updateSkip', rel.version); return { status: 'skipped', current, latest: rel.version }; }
      if (pick !== 'Update') return { status: 'update-available', current, latest: rel.version };
    }

    const vsixPath = await this.download(rel);
    if (opts.dryRun) return { status: 'dry-run-downloaded', current, latest: rel.version, vsixPath };
    await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(vsixPath));
    void this.context.globalState.update('updateSkip', undefined);
    const pick = await vscode.window.showInformationMessage(`OverLyX ${rel.version} installed — reload to use it.`, 'Reload Window');
    if (pick === 'Reload Window') void vscode.commands.executeCommand('workbench.action.reloadWindow');
    return { status: 'installed', current, latest: rel.version, vsixPath };
  }

  private async download(rel: ReleaseInfo): Promise<string> {
    const dir = path.join(this.context.globalStorageUri.fsPath, 'updates');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `overlyx-vscode-${rel.version}.vsix`);
    const res = await fetch(rel.vsixUrl, { headers: { 'user-agent': 'overlyx-vscode' }, signal: AbortSignal.timeout(120000), redirect: 'follow' });
    if (!res.ok) throw new Error(`download failed: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 10000) throw new Error('download too small — not a vsix');
    fs.writeFileSync(file, buf);
    // keep the directory tidy: only the newest download
    for (const f of fs.readdirSync(dir)) { if (f.endsWith('.vsix') && path.join(dir, f) !== file) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ } } }
    return file;
  }
}

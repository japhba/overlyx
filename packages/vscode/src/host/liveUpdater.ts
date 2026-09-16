/** The live install updates source commits; it must never be replaced by a release VSIX. */
import * as vscode from 'vscode';
import fs from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export interface LiveStatus { status: 'up-to-date' | 'updated' | 'checking' | 'blocked' | 'error'; reason: string; head: string; upstream: string; checkedAt: string; activationPending?: boolean; vsixPath?: string; artifactHead?: string }

export class LiveUpdater implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 20);
  private readonly statusFile: string;
  private readonly runningHead: string;
  private timer?: NodeJS.Timeout;
  private notified = '';
  private installing = false;

  constructor(private context: vscode.ExtensionContext, source: string) {
    const git = (...args: string[]) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim();
    this.runningHead = git('rev-parse', 'HEAD');
    this.statusFile = git('rev-parse', '--path-format=absolute', '--git-path', 'overlyx-live-status.json');
    this.item.name = 'OverLyX Live updates';
  }

  read(): LiveStatus | null { return fs.existsSync(this.statusFile) ? JSON.parse(fs.readFileSync(this.statusFile, 'utf8')) : null; }

  schedule(): void {
    this.refresh();
    this.timer = setInterval(() => this.refresh(), 30000);
  }

  private refresh(): void {
    const status = this.read();
    const blocked = status?.status === 'blocked' || status?.status === 'error';
    const reload = status && !status.activationPending && status.head !== this.runningHead;
    this.item.text = `${blocked ? '$(warning)' : reload ? '$(debug-restart)' : '$(sync)'} OverLyX Live${blocked ? ': update blocked' : reload ? ': reload available' : ''}`;
    this.item.tooltip = `Running source: ${this.runningHead.slice(0, 12)}\n${status?.reason ?? 'No upstream check recorded. Run npm run dev:service -w packages/vscode to enable the update timer.'}`;
    this.item.command = reload ? 'workbench.action.reloadWindow' : 'overlyx.checkForUpdates';
    this.item.show();
    // Commands, menus and settings live in the installed manifest, outside the watched JS.
    if (status?.vsixPath && !status.activationPending && status.artifactHead === status.head && !this.installing && this.context.extension.packageJSON.overlyxSourceRevision !== status.artifactHead && this.context.globalState.get('liveInstalledArtifact') !== status.artifactHead) {
      this.installing = true;
      void Promise.resolve(vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(status.vsixPath))).then(async () => {
        await this.context.globalState.update('liveInstalledArtifact', status.artifactHead);
      }, error => { void vscode.window.showErrorMessage(`OverLyX Live manifest update failed: ${String(error)}`); }).finally(() => { this.installing = false; });
    }
    if (blocked) {
      const key = `${status.upstream}:${status.status}`;
      if (key !== this.notified) { this.notified = key; void vscode.window.showWarningMessage(`OverLyX Live update blocked: ${status.reason}`); }
    }
  }

  async check(): Promise<LiveStatus> {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Checking OverLyX Live upstream' }, async () => {
      await exec('systemctl', ['--user', 'start', 'overlyx-live-update.service'], { timeout: 15 * 60 * 1000 });
    });
    const status = this.read();
    if (!status) throw new Error('The live update service did not write a status. Run npm run dev:service -w packages/vscode.');
    this.refresh();
    const reload = !status.activationPending && status.head !== this.runningHead;
    const pick = await vscode.window.showInformationMessage(`OverLyX Live: ${status.reason}`, ...(reload ? ['Reload Window'] : []));
    if (pick === 'Reload Window') void vscode.commands.executeCommand('workbench.action.reloadWindow');
    return status;
  }

  dispose(): void { clearInterval(this.timer); this.item.dispose(); }
}

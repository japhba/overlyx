/**
 * Privacy-conscious crash diagnostics for the extension host.
 *
 * VS Code's TelemetryLogger is deliberately kept in front of our sender: it honours the user's
 * global telemetry level, removes likely PII from strings, exposes reports in VS Code's telemetry
 * output, and attributes otherwise-unhandled extension errors to this logger. We additionally
 * avoid VS Code's built-in common properties so stable machine/session identifiers never reach
 * OverLyX. The receiver turns distinct failures into deduplicated GitHub issues.
 */
import * as vscode from 'vscode';

const ENDPOINT = 'https://overlyx.app/api/vscode-telemetry';
const MAX_PENDING = 20;

export interface ErrorReporter {
  report(error: unknown, area: string, data?: Record<string, string | number | boolean | undefined>): void;
}

function asError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(typeof value === 'string' ? value : String(value));
}

/** The network side of TelemetryLogger. Calls are best-effort and never affect the editor. */
class OverlyxTelemetrySender implements vscode.TelemetrySender {
  private pending = new Set<Promise<void>>();

  constructor(
    private enabled: () => boolean,
    private common: Record<string, string>,
    private output: vscode.LogOutputChannel,
  ) {}

  sendEventData(eventName: string, data: Record<string, unknown> = {}): void {
    if (eventName !== 'error') return; // this extension collects errors, not usage behaviour
    this.enqueue({ schema: 1, event: eventName, ...this.common, ...data });
  }

  sendErrorData(error: Error, data: Record<string, unknown> = {}): void {
    this.enqueue({
      schema: 1,
      event: 'unhandled-error',
      ...this.common,
      ...data,
      errorName: error.name,
      message: error.message,
      stack: error.stack ?? '',
    });
  }

  async flush(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  private enqueue(body: Record<string, unknown>): void {
    if (!this.enabled() || this.pending.size >= MAX_PENDING) return;
    let request!: Promise<void>;
    request = fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': `overlyx-vscode/${this.common.extensionVersion}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    }).then(response => {
      if (!response.ok && response.status !== 204) this.output.debug(`Diagnostic receiver answered ${response.status}`);
    }).catch(error => {
      // Being offline, behind a proxy, or blocking telemetry is normal. Keep this local and quiet.
      this.output.debug(`Could not send diagnostic: ${asError(error).message}`);
    }).finally(() => this.pending.delete(request));
    this.pending.add(request);
  }
}

export class OverlyxTelemetry implements ErrorReporter, vscode.Disposable {
  private readonly output = vscode.window.createOutputChannel('OverLyX', { log: true });
  private readonly sender: OverlyxTelemetrySender;
  private readonly logger: vscode.TelemetryLogger;

  constructor(private context: vscode.ExtensionContext) {
    const common = {
      extensionVersion: String(context.extension.packageJSON.version ?? 'unknown'),
      vscodeVersion: vscode.version,
      platform: process.platform,
      arch: process.arch,
      remote: vscode.env.remoteName ? 'remote' : 'local',
      uiKind: vscode.env.uiKind === vscode.UIKind.Web ? 'web' : 'desktop',
    };
    this.sender = new OverlyxTelemetrySender(() => this.enabled, common, this.output);
    this.logger = vscode.env.createTelemetryLogger(this.sender, {
      // In particular, do not add machineId or sessionId. The fields above are enough to diagnose
      // packaging, compatibility and remote-extension problems.
      ignoreBuiltInCommonProperties: true,
    });
  }

  private get enabled(): boolean {
    return vscode.env.isTelemetryEnabled && vscode.workspace.getConfiguration('overlyx').get<boolean>('errorReports', true);
  }

  report(value: unknown, area: string, data: Record<string, string | number | boolean | undefined> = {}): void {
    const error = asError(value);
    // The local channel retains the useful original. TelemetryLogger cleans the remote copy.
    this.output.error(`[${area}] ${error.stack ?? error.message}`);
    if (!this.enabled) return;
    this.logger.logError('error', {
      area: area.slice(0, 80),
      errorName: error.name.slice(0, 80),
      message: error.message.slice(0, 1000),
      stack: error.stack?.slice(0, 6000) ?? '',
      ...data,
    });
  }

  dispose(): void {
    this.logger.dispose(); // calls sender.flush(), if needed
    this.output.dispose();
  }
}

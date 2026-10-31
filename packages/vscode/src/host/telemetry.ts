/**
 * Anonymous usage statistics and sanitized crash diagnostics for the extension host.
 *
 * VS Code's TelemetryLogger is deliberately kept in front of our sender: it honours the user's
 * global telemetry level, removes likely PII from strings, exposes reports in VS Code's telemetry
 * output, and attributes otherwise-unhandled extension errors to this logger. We additionally
 * avoid VS Code's built-in common properties so stable machine/session identifiers never reach
 * OverLyX. Receivers keep bounded anonymous usage and deduplicated error reports on the server.
 */
import * as vscode from 'vscode';
import crypto from 'node:crypto';
import { makeInteractionDetail, type InteractionAction, type InteractionOutcome } from '@overlyx/core/interactions.ts';
import { reliabilityDurationBucket } from '@overlyx/core/reliability.ts';
import { sanitizeUsageEvents, validUsageSession, type SafeUsageEvent } from '@overlyx/core/usagePayload.ts';
import { broadcastUsageStats } from './appearance.ts';
import { cleanTypeset } from '@overlyx/core/typeset.ts';

const ENDPOINT = 'https://overlyx.app/api/vscode-telemetry';
const USAGE_ENDPOINT = 'https://overlyx.app/api/vscode-usage';
const MAX_PENDING = 20;

export function usageStatisticsEnabled(): boolean {
  try {
    return vscode.env.isTelemetryEnabled && vscode.workspace.getConfiguration('telemetry').get<string>('telemetryLevel', 'all') === 'all'
      && vscode.workspace.getConfiguration('overlyx').get<boolean>('usageStatistics', true);
  } catch { return false; }
}

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
  private usage = new Map<string, { session: string; reliabilityConsent: boolean; events: (SafeUsageEvent & { at: number })[] }>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private enabled: () => boolean,
    private common: Record<string, string>,
    private output: vscode.LogOutputChannel,
    private usageEnabled: () => boolean,
  ) {}

  sendEventData(eventName: string, data: Record<string, unknown> = {}): void {
    if (eventName === 'usage') {
      if (!this.usageEnabled() || !validUsageSession(data.session)) return;
      const consent = data.reliabilityConsent === true;
      const events = sanitizeUsageEvents([data], consent);
      if (!events.length) return;
      const key = data.session + (consent ? ':beta' : '');
      if (!this.usage.has(key) && this.usage.size >= 20) return;
      const group = this.usage.get(key) ?? { session: data.session, reliabilityConsent: consent, events: [] };
      group.events.push(...events.map(e => ({ ...e, at: Date.now() - e.ago })));
      this.usage.set(key, group);
      if (group.events.length >= 40) this.flushUsage();
      else if (!this.timer) { this.timer = setTimeout(() => this.flushUsage(), 20000); this.timer.unref(); }
      return;
    }
    if (eventName === 'typeset') {
      // (flat through the logger, which cleans each string; put together again for the receiver, core typeset.ts)
      const t = cleanTypeset({ ...data, packages: typeof data.packages === 'string' ? data.packages.split(',').filter(Boolean) : undefined });
      if (t) this.enqueue({ schema: 1, event: 'typeset', ...this.common, typeset: t });
      return;
    }
    if (eventName !== 'error') return;
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
    this.flushUsage();
    await Promise.allSettled([...this.pending]);
  }

  purgeUsage(): void { this.usage.clear(); if (this.timer) clearTimeout(this.timer); this.timer = null; }

  private flushUsage(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const groups = [...this.usage.values()];
    this.usage.clear();
    if (!this.usageEnabled()) return;
    const now = Date.now();
    for (const group of groups) this.enqueue({ schema: 1, ...this.common, session: group.session, reliabilityConsent: group.reliabilityConsent,
      events: group.events.slice(0, 200).map(({ at, ...e }) => ({ ...e, ago: Math.max(0, now - at) })) }, USAGE_ENDPOINT, this.usageEnabled);
  }

  private enqueue(body: Record<string, unknown>, endpoint = ENDPOINT, enabled = this.enabled): void {
    if (!enabled() || this.pending.size >= (endpoint === USAGE_ENDPOINT ? MAX_PENDING - 5 : MAX_PENDING)) return;
    let request!: Promise<void>;
    request = fetch(endpoint, {
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
  private readonly subscriptions: vscode.Disposable[] = [];
  private usageSession = crypto.randomBytes(8).toString('hex');
  private usageStarted = false;

  constructor(private context: vscode.ExtensionContext) {
    const common = {
      extensionVersion: String(context.extension.packageJSON.version ?? 'unknown'),
      vscodeVersion: vscode.version,
      platform: process.platform,
      arch: process.arch,
      remote: vscode.env.remoteName ? 'remote' : 'local',
      uiKind: vscode.env.uiKind === vscode.UIKind.Web ? 'web' : 'desktop',
    };
    this.sender = new OverlyxTelemetrySender(() => this.enabled, common, this.output, () => this.usageEnabled);
    this.logger = vscode.env.createTelemetryLogger(this.sender, {
      // In particular, do not add machineId or sessionId. The fields above are enough to diagnose
      // packaging, compatibility and remote-extension problems.
      ignoreBuiltInCommonProperties: true,
    });
    const policyChanged = () => {
      this.sender.purgeUsage(); this.usageSession = crypto.randomBytes(8).toString('hex'); this.usageStarted = false;
      broadcastUsageStats(this.usageEnabled);
    };
    this.subscriptions.push(this.logger.onDidChangeEnableStates(policyChanged), vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('overlyx.usageStatistics') || e.affectsConfiguration('telemetry.telemetryLevel')) policyChanged();
    }));
  }

  private get enabled(): boolean {
    return vscode.env.isTelemetryEnabled && vscode.workspace.getConfiguration('overlyx').get<boolean>('errorReports', true);
  }

  private get usageEnabled(): boolean { return usageStatisticsEnabled() && this.logger?.isUsageEnabled === true; }

  /** Called only by the token-protected local bridge. Rebuild fields before TelemetryLogger sees them. */
  usageBatch(value: unknown): number {
    try {
      if (!this.usageEnabled || !value || typeof value !== 'object') return 0;
      const b = value as Record<string, unknown>;
      if (!validUsageSession(b.session)) return 0;
      const consent = b.reliabilityConsent === true;
      const events = sanitizeUsageEvents(b.events, consent);
      for (const e of events) this.logger.logUsage('usage', { ...e, session: b.session, reliabilityConsent: consent });
      return events.length;
    } catch { return 0; }
  }

  track(action: InteractionAction, outcome: InteractionOutcome, durationMs?: number): void {
    try {
      if (!this.usageEnabled) return;
      if (!this.usageStarted) {
        this.usageStarted = true;
        this.logger.logUsage('usage', { name: 'session', detail: 'vscode', ago: 0, session: this.usageSession });
      }
      const detail = makeInteractionDetail(action, outcome);
      const dt = durationMs === undefined ? null : reliabilityDurationBucket(durationMs);
      if (detail) this.logger.logUsage('usage', { name: 'interaction', detail, where: 'ui', ago: 0, session: this.usageSession, ...(dt === null ? {} : { dt }) });
    } catch { /* Diagnostics must never interrupt editing or saving. */ }
  }

  /** Useful for shutdown and focused tests; no disk-backed telemetry queue. */
  flush(): Promise<void> { return this.sender.flush(); }

  report(value: unknown, area: string, data: Record<string, string | number | boolean | undefined> = {}): void {
    this.track('app-error', 'failed');
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

  /** A formula the editor could not typeset while on the screen (client editor/typesetreports.ts), from the token-protected local bridge. */
  typeset(value: unknown): void {
    try {
      const t = cleanTypeset(value);
      if (!t || !this.enabled) return;
      this.logger.logError('typeset', { ...t, packages: t.packages?.join(',') });
    } catch { /* Diagnostics must never interrupt editing. */ }
  }

  dispose(): void {
    for (const s of this.subscriptions) s.dispose();
    void this.sender.flush();
    this.logger.dispose(); // calls sender.flush(), if needed
    this.output.dispose();
  }
}

import { isInteractionTarget, parseInteractionDetail } from './interactions.ts';
import { isReliabilityContext, isReliabilityDurationBucket, parseReliabilityDetail } from './reliability.ts';

export const USAGE_KINDS = ['session', 'view', 'menu', 'palette', 'shortcut', 'toolbar', 'key', 'chord', 'key-unbound', 'dialog', 'notice', 'error', 'undo', 'redo', 'reliability', 'interaction'] as const;
export interface SafeUsageEvent { name: typeof USAGE_KINDS[number]; detail: string; ago: number; where?: string; ok?: boolean; dt?: number }
export const validUsageSession = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8,32}$/.test(value);

export function scrubUsageDetail(s: unknown, max = 120): string {
  return String(s ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/“[^”]*”|"[^"]*"|‘[^’]*’|`[^`]*`|'[^']{2,}'/g, '“…”')
    .replace(/\S+@\S+/g, '<email>')
    .replace(/\S*?(?:\/|\\|\.(?:tex|lyx|bib|pdf|png|jpe?g|svg|gif|eps|md|txt|board|json|zip|csv|sty|cls))\b[^\s:;,!?()[\]]*/gi, '<file>')
    .replace(/\d+(?:[.,]\d+)?/g, '#').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Rebuild a bounded event from allowed fields; extra fields never reach a sender. */
export function sanitizeUsageEvents(input: unknown, reliabilityConsent = false): SafeUsageEvent[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 200).flatMap(raw => {
    if (!raw || typeof raw !== 'object' || !(USAGE_KINDS as readonly unknown[]).includes(raw.name)) return [];
    const typed = raw.name === 'interaction' || raw.name === 'reliability';
    if (raw.name === 'interaction' && (!parseInteractionDetail(raw.detail) || !isInteractionTarget(raw.where))) return [];
    if (raw.name === 'reliability' && (!reliabilityConsent || !parseReliabilityDetail(raw.detail) || raw.where !== undefined && !isReliabilityContext(raw.where))) return [];
    if (typed && raw.dt !== undefined && !isReliabilityDurationBucket(raw.dt)) return [];
    const e: SafeUsageEvent = { name: raw.name, detail: typed ? raw.detail : scrubUsageDetail(raw.detail), ago: typeof raw.ago === 'number' && Number.isFinite(raw.ago) ? Math.round(Math.max(0, Math.min(raw.ago, 21600000))) : 0 };
    if (typeof raw.where === 'string' && /^[a-z]{1,12}$/.test(raw.where)) e.where = raw.where;
    if (!typed && typeof raw.ok === 'boolean') e.ok = raw.ok;
    if (typeof raw.dt === 'number' && Number.isFinite(raw.dt) && raw.dt >= 0) e.dt = Math.round(Math.min(raw.dt, 86400000));
    return [e];
  });
}

/** Only release versions and coarse runtime categories, shared by many installations. */
export function vscodeUsageMeta(raw: unknown): { detail: string; version: string } | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const version = (v: unknown) => typeof v === 'string' && /^(?:\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?|unknown)$/.test(v) && v.length <= 60;
  if (!version(m.extensionVersion) || !version(m.vscodeVersion)) return null;
  if (!['linux', 'darwin', 'win32', 'freebsd', 'openbsd', 'aix', 'sunos', 'android'].includes(String(m.platform)) || !['x64', 'arm64', 'arm', 'ia32', 'riscv64', 'ppc64', 's390x', 'loong64'].includes(String(m.arch))) return null;
  if (!['local', 'remote'].includes(String(m.remote)) || !['web', 'desktop'].includes(String(m.uiKind))) return null;
  return { detail: `vscode ${m.platform} ${m.arch} ${m.remote} ${m.uiKind}`, version: `vscode:${m.extensionVersion};code:${m.vscodeVersion}` };
}

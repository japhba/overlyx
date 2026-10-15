/** Content-free reliability event names suitable for bounded aggregate telemetry. */
export const RELIABILITY_EVENTS = [
  'diagnostics.enabled',
  'screen.orientation',
  'keyboard.load-start',
  'keyboard.ready',
  'keyboard.fallback-error',
  'keyboard.fallback-timeout',
  'keyboard.late-ready',
  'keyboard.owner-disposed',
  'gesture.cancelled',
  'gesture.capture-lost',
  'gesture.interrupted',
  'gesture.palm-ignored',
  'canvas.ready',
  'canvas.timeout',
  'canvas.retry',
  'canvas.recovered',
  'canvas.denied',
  'save.pending',
  'save.saved',
  'save.offline-local',
  'save.storage-warning',
  'save.failed',
  'app.hidden',
  'app.resumed',
] as const;

export const POINTERS = ['mouse', 'touch', 'pen', 'none'] as const;
export const CONTEXTS = ['ui', 'math', 'document', 'deck', 'poster', 'page', 'portrait', 'landscape'] as const;
export const DURATION_BUCKETS = [0, 250, 500, 1000, 3000, 10000, 30000, 60000] as const;

export type ReliabilityEvent = typeof RELIABILITY_EVENTS[number];
export type ReliabilityPointer = typeof POINTERS[number];
export type ReliabilityContext = typeof CONTEXTS[number];
export type ReliabilityDurationBucket = typeof DURATION_BUCKETS[number];

const eventSet: ReadonlySet<string> = new Set(RELIABILITY_EVENTS);
const pointerSet: ReadonlySet<string> = new Set(POINTERS);
const contextSet: ReadonlySet<string> = new Set(CONTEXTS);
const durationSet: ReadonlySet<number> = new Set(DURATION_BUCKETS);

export function isReliabilityContext(value: unknown): value is ReliabilityContext {
  return typeof value === 'string' && contextSet.has(value);
}

export function isReliabilityDurationBucket(value: unknown): value is ReliabilityDurationBucket {
  return typeof value === 'number' && durationSet.has(value);
}

/** Round up to the next bounded duration bucket; invalid values have no duration. */
export function reliabilityDurationBucket(ms: unknown): ReliabilityDurationBucket | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  const bounded = Math.max(0, Math.min(60000, ms));
  return DURATION_BUCKETS.find(bucket => bounded <= bucket) ?? 60000;
}

/** Produce the sole permitted event detail form. No caller-provided free text is retained. */
export function makeReliabilityDetail(event: unknown, pointer: unknown = 'none'): string | null {
  if (typeof event !== 'string' || !eventSet.has(event) || typeof pointer !== 'string' || !pointerSet.has(pointer)) return null;
  return `${event} ${pointer}`;
}

/** Parse only the exact canonical event/pointer pair; reject all unrecognized payloads. */
export function parseReliabilityDetail(detail: unknown): { event: ReliabilityEvent; pointer: ReliabilityPointer } | null {
  if (typeof detail !== 'string') return null;
  const separator = detail.indexOf(' ');
  if (separator <= 0 || separator !== detail.lastIndexOf(' ')) return null;
  const event = detail.slice(0, separator), pointer = detail.slice(separator + 1);
  if (!eventSet.has(event) || !pointerSet.has(pointer)) return null;
  return { event: event as ReliabilityEvent, pointer: pointer as ReliabilityPointer };
}

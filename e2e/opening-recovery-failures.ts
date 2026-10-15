/** Narrow allowlist for request aborts with directly observed browser lifecycle causes. */
export type OpeningFailure = {
  id: number;
  url: string;
  errorCode: string;
  resourceType: string;
  protocol: 'http' | 'data' | 'blob' | 'other';
  destination: string;
  startedAt: number;
  failedAt: number;
  startPhase: string;
  failurePhase: string;
};

export type EventSourceClose = {
  url: string;
  at: number;
  endpoint: 'project-events' | 'other';
  parentMainRealm: boolean;
};

export type OpeningFailureClassification = {
  total: number;
  expectedLifecycle: number;
  expectedDemoMedia: number;
  expectedProjectEvents: number;
  unexpected: number;
  expectedIds: number[];
  unexpectedIds: number[];
  projectEventsPairs: { failureId: number; closeIndex: number }[];
};

const demoPath = /^\/landing\/(?:wysiwyg|tex|slides|drawing|collab|vscode)-(?:light|dark)\.(?:webm|mp4)$/;
const projectEventsPath = /^\/api\/projects\/[^/]+\/events$/;

function sameOriginHttpUrl(rawUrl: string, expectedOrigin: string): URL | null {
  try {
    const url = new URL(rawUrl);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== expectedOrigin) return null;
    return url;
  } catch {
    return null;
  }
}

function isExpectedDemoMedia(failure: OpeningFailure, expectedOrigin: string): boolean {
  if (failure.errorCode !== 'ERR_ABORTED' || failure.destination !== 'landing-demo-media' ||
      failure.resourceType !== 'media' || failure.protocol !== 'http' ||
      failure.startPhase !== 'before-login' || failure.failurePhase !== 'before-login' ||
      !Number.isFinite(failure.startedAt) || !Number.isFinite(failure.failedAt)) return false;
  const url = sameOriginHttpUrl(failure.url, expectedOrigin);
  return !!url && demoPath.test(url.pathname) && !url.search && !url.hash;
}

function isProjectEventsFailure(failure: OpeningFailure, expectedOrigin: string): boolean {
  if (failure.errorCode !== 'ERR_ABORTED' || failure.destination !== 'sse' ||
      failure.resourceType !== 'eventsource' || failure.protocol !== 'http' ||
      !Number.isFinite(failure.startedAt) || !Number.isFinite(failure.failedAt)) return false;
  const url = sameOriginHttpUrl(failure.url, expectedOrigin);
  return !!url && projectEventsPath.test(url.pathname) && !url.search && !url.hash;
}

/**
 * Classifies only two proven lifecycle abort classes. Raw URLs are consumed in memory and
 * intentionally omitted from the returned evidence. Each EventSource close can explain at
 * most one failure, and temporal matching is directional (request start <= close <= failure).
 */
export function classifyOpeningFailures(
  baseUrl: string,
  failures: OpeningFailure[],
  closes: EventSourceClose[],
): OpeningFailureClassification {
  const expectedOrigin = new URL(baseUrl).origin;
  const expectedIds = new Set<number>();
  const expectedDemoIds = new Set<number>();
  const expectedEventsIds = new Set<number>();
  const idCounts = new Map<number, number>();
  for (const failure of failures) idCounts.set(failure.id, (idCounts.get(failure.id) ?? 0) + 1);
  const duplicateIds = new Set([...idCounts].filter(([, count]) => count > 1).map(([id]) => id));
  const canClassify = (failure: OpeningFailure): boolean => Number.isSafeInteger(failure.id) && failure.id >= 0 &&
    !duplicateIds.has(failure.id) && Number.isFinite(failure.startedAt) && Number.isFinite(failure.failedAt);

  for (const failure of failures) {
    if (!canClassify(failure)) continue;
    if (isExpectedDemoMedia(failure, expectedOrigin)) {
      expectedIds.add(failure.id);
      expectedDemoIds.add(failure.id);
    }
  }

  const pairedCloseIndexes = new Set<number>();
  const projectEventsPairs: { failureId: number; closeIndex: number }[] = [];
  const orderedFailures = [...failures].sort((a, b) => a.failedAt - b.failedAt || a.id - b.id);
  for (const failure of orderedFailures) {
    if (!canClassify(failure)) continue;
    if (!isProjectEventsFailure(failure, expectedOrigin)) continue;
    const closeIndex = closes.findIndex((close, index) => {
      if (pairedCloseIndexes.has(index) || !close.parentMainRealm || close.endpoint !== 'project-events') return false;
      if (!Number.isFinite(close.at)) return false;
      if (close.url !== failure.url || close.at < failure.startedAt || close.at > failure.failedAt) return false;
      return failure.failedAt - close.at <= 1000;
    });
    if (closeIndex >= 0) {
      pairedCloseIndexes.add(closeIndex);
      expectedIds.add(failure.id);
      expectedEventsIds.add(failure.id);
      projectEventsPairs.push({ failureId: failure.id, closeIndex });
    }
  }

  const expectedIdList = failures.filter(failure => canClassify(failure) && expectedIds.has(failure.id)).map(failure => failure.id);
  const unexpectedIdList = failures.filter(failure => !canClassify(failure) || !expectedIds.has(failure.id)).map(failure => failure.id);
  return {
    total: failures.length,
    expectedLifecycle: expectedIds.size,
    expectedDemoMedia: expectedDemoIds.size,
    expectedProjectEvents: expectedEventsIds.size,
    unexpected: unexpectedIdList.length,
    expectedIds: expectedIdList,
    unexpectedIds: unexpectedIdList,
    projectEventsPairs,
  };
}

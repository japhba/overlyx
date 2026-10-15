import { describe, expect, it } from 'vitest';
import { classifyOpeningFailures, type EventSourceClose, type OpeningFailure } from '../e2e/opening-recovery-failures';

const baseUrl = 'http://127.0.0.1:3017';
const demo = (overrides: Partial<OpeningFailure> = {}): OpeningFailure => ({
  id: 1, url: `${baseUrl}/landing/tex-light.webm`, errorCode: 'ERR_ABORTED',
  resourceType: 'media', protocol: 'http', destination: 'landing-demo-media',
  startedAt: 10, failedAt: 20, startPhase: 'before-login', failurePhase: 'before-login', ...overrides,
});
const events = (overrides: Partial<OpeningFailure> = {}): OpeningFailure => ({
  id: 2, url: `${baseUrl}/api/projects/luna1%2Fdeck/events`, errorCode: 'ERR_ABORTED',
  resourceType: 'eventsource', protocol: 'http', destination: 'sse',
  startedAt: 100, failedAt: 500, startPhase: 'login-done', failurePhase: 'panel', ...overrides,
});
const close = (overrides: Partial<EventSourceClose> = {}): EventSourceClose => ({
  url: events().url, at: 450, endpoint: 'project-events', parentMainRealm: true, ...overrides,
});

describe('opening-recovery request-failure lifecycle classification', () => {
  it('allows the exact same-origin public landing demo media abort before login', () => {
    expect(classifyOpeningFailures(baseUrl, [demo()], []).expectedIds).toEqual([1]);
  });

  it.each([
    ['other error', { errorCode: 'ERR_CONNECTION_RESET' }],
    ['non-media resource', { resourceType: 'fetch' }],
    ['non-HTTP protocol', { protocol: 'data' }],
    ['unclassified destination', { destination: 'static' }],
    ['other origin', { url: 'http://example.invalid/landing/tex-light.webm' }],
    ['unlisted path', { url: `${baseUrl}/landing/other-light.webm` }],
    ['query string', { url: `${baseUrl}/landing/tex-light.webm?x=1` }],
    ['fragment', { url: `${baseUrl}/landing/tex-light.webm#x` }],
    ['start outside before-login', { startPhase: 'login-done' }],
    ['failure outside before-login', { failurePhase: 'login-done' }],
  ] as const)('does not allow demo media with %s', (_label, overrides) => {
    const result = classifyOpeningFailures(baseUrl, [demo(overrides)], []);
    expect(result.expectedLifecycle).toBe(0);
    expect(result.unexpectedIds).toEqual([1]);
  });

  it('allows an exact same-origin project EventSource abort paired to an in-window parent close', () => {
    const result = classifyOpeningFailures(baseUrl, [events()], [close()]);
    expect(result).toMatchObject({ total: 1, expectedLifecycle: 1, expectedProjectEvents: 1, unexpected: 0, expectedIds: [2] });
  });

  it('accepts inclusive request-start and one-second close-to-failure boundaries', () => {
    const result = classifyOpeningFailures(baseUrl, [events({ startedAt: 100, failedAt: 1100 })], [close({ at: 100 })]);
    expect(result.expectedIds).toEqual([2]);
  });

  it.each([
    ['other error', { errorCode: 'ERR_NETWORK' }, {}],
    ['wrong request type', { resourceType: 'fetch' }, {}],
    ['wrong destination', { destination: 'api-metadata' }, {}],
    ['non-HTTP protocol', { protocol: 'blob' }, {}],
    ['other origin', { url: 'http://example.invalid/api/projects/luna1%2Fdeck/events' }, {}],
    ['wrong path', { url: `${baseUrl}/api/projects/luna1%2Fdeck/other` }, {}],
    ['query string', { url: `${baseUrl}/api/projects/luna1%2Fdeck/events?x=1` }, {}],
    ['close URL differs', {}, { url: `${baseUrl}/api/projects/luna1%2Fother/events` }],
    ['not a project-events close', {}, { endpoint: 'other' }],
    ['not parent main realm', {}, { parentMainRealm: false }],
    ['close precedes request start', { startedAt: 451 }, {}],
    ['close follows failure', { failedAt: 449 }, {}],
    ['close-to-failure exceeds one second', { failedAt: 1451 }, {}],
  ] as const)('does not allow EventSource abort with %s', (_label, failureOverrides, closeOverrides) => {
    const result = classifyOpeningFailures(baseUrl, [events(failureOverrides)], [close(closeOverrides)]);
    expect(result.expectedProjectEvents).toBe(0);
    expect(result.unexpectedIds).toEqual([2]);
  });

  it('pairs closes one-to-one and does not reuse a close for repeated failures', () => {
    const first = events({ id: 2, failedAt: 480 });
    const second = events({ id: 3, failedAt: 500 });
    const result = classifyOpeningFailures(baseUrl, [first, second], [close()]);
    expect(result.expectedIds).toEqual([2]);
    expect(result.unexpectedIds).toEqual([3]);
  });

  it('fails closed for duplicate or invalid request IDs', () => {
    const duplicate = classifyOpeningFailures(baseUrl, [demo({ id: 7 }), demo({ id: 7 })], []);
    expect(duplicate.expectedLifecycle).toBe(0);
    expect(duplicate.unexpectedIds).toEqual([7, 7]);
    const invalid = classifyOpeningFailures(baseUrl, [demo({ id: Number.NaN })], []);
    expect(invalid.expectedLifecycle).toBe(0);
    expect(invalid.unexpected).toBe(1);
  });

  it('fails closed for non-finite failure or close timestamps', () => {
    const badFailure = classifyOpeningFailures(baseUrl, [events({ startedAt: Number.NaN })], [close()]);
    expect(badFailure.expectedProjectEvents).toBe(0);
    const badClose = classifyOpeningFailures(baseUrl, [events()], [close({ at: Number.NaN })]);
    expect(badClose.expectedProjectEvents).toBe(0);
  });

  it('keeps total and unexpected counts distinct when both allowed classes and an unknown abort occur', () => {
    const result = classifyOpeningFailures(baseUrl, [demo(), events(), demo({ id: 3, url: `${baseUrl}/unlisted` })], [close()]);
    expect(result).toMatchObject({ total: 3, expectedLifecycle: 2, expectedDemoMedia: 1, expectedProjectEvents: 1, unexpected: 1 });
  });
});

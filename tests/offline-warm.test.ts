import { expect, it, vi } from 'vitest';
import { warmOfflineResponses } from '../packages/client/src/offline-warm';

function request(user: unknown, ok = true) {
  return vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({ ok, json: async () => ({ user }) }) as Response);
}

it('warms identity but never protected resources before sign-in', async () => {
  const fetcher = request(null);
  await warmOfflineResponses('#/morgan/research/slides/index.html', fetcher as typeof fetch);
  expect(fetcher.mock.calls).toEqual([['/api/auth/me', { credentials: 'same-origin' }]]);
});

it('warms the authenticated project list and the actual document metadata', async () => {
  const fetcher = request({ id: 7 });
  await warmOfflineResponses('#/raw:morgan/research/slides/index.html?view=code', fetcher as typeof fetch);
  expect(fetcher.mock.calls).toEqual([
    ['/api/auth/me', { credentials: 'same-origin' }],
    ['/api/projects', { credentials: 'same-origin' }],
    ['/api/docs/morgan%2Fresearch%2Fslides%2Findex.html/meta', { credentials: 'same-origin' }],
  ]);
});

it('does not request metadata for a share link or a malformed hash', async () => {
  for (const hash of ['#/share/public-example', '#/%malformed']) {
    const fetcher = request({ id: 7, guest: true });
    await warmOfflineResponses(hash, fetcher as typeof fetch);
    expect(fetcher.mock.calls).toHaveLength(2);
    expect(fetcher.mock.calls[1]).toEqual(['/api/projects', { credentials: 'same-origin' }]);
  }
});

it('does not start protected warm requests after a failed identity check', async () => {
  const unauthorized = request(null, false);
  await warmOfflineResponses('#/morgan/research/doc.tex', unauthorized as typeof fetch);
  expect(unauthorized.mock.calls).toHaveLength(1);
  const offline = vi.fn(async () => { throw new TypeError('offline'); });
  await expect(warmOfflineResponses('#/morgan/research/doc.tex', offline as typeof fetch)).resolves.toBeUndefined();
  expect(offline.mock.calls).toHaveLength(1);
});

import { describe, expect, it } from 'vitest';
import { saveReliabilityEvent } from '../packages/client/src/deliverable/reliability.ts';
import type { DeliverableSaveState } from '../packages/client/src/deliverable/host.ts';

describe('content-free deliverable save reliability mapping', () => {
  it('maps save-state categories to fixed events only', () => {
    const cases: [DeliverableSaveState | null, string | null][] = [
      [null, null],
      [{ state: 'saved', pending: false }, 'save.saved'],
      [{ state: 'saving', pending: false }, 'save.pending'],
      [{ state: 'connecting', pending: true }, 'save.pending'],
      [{ state: 'offline', pending: true, localPending: false }, 'save.offline-local'],
      [{ state: 'stale', pending: false }, 'save.failed'],
      [{ state: 'connecting', pending: false }, null],
      [{ state: 'offline', pending: false, localPending: true }, null],
    ];
    for (const [state, expected] of cases) expect(saveReliabilityEvent(state)).toBe(expected);
  });

  it('reduces storage and remote error details to event names and never returns the error text', () => {
    const secret = 'PRIVATE-TEXT-DOC-URL-COORDINATE-ERROR-MARKER';
    const storageWarning = saveReliabilityEvent({ state: 'offline', pending: true, localPending: false, localError: secret });
    const staleFailure = saveReliabilityEvent({ state: 'stale', pending: false, localError: secret });
    expect(storageWarning).toBe('save.storage-warning');
    expect(staleFailure).toBe('save.failed');
    expect(JSON.stringify([storageWarning, staleFailure])).not.toContain(secret);
    expect(JSON.stringify([storageWarning, staleFailure])).toMatch(/^[\[\]",a-z.-]+$/);
  });
});

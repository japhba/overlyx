import type { DeliverableSaveState } from './host';
import type { ReliabilityEvent } from '@overlyx/core/reliability.ts';

/** The state category only: never retain localError's text or host identity. */
export function saveReliabilityEvent(state: DeliverableSaveState | null): ReliabilityEvent | null {
  if (!state) return null;
  if (state.state === 'stale') return 'save.failed';
  if (state.localError) return 'save.storage-warning';
  if (state.state === 'offline' && state.pending && state.localPending === false) return 'save.offline-local';
  if (state.pending || state.state === 'saving') return 'save.pending';
  return state.state === 'saved' ? 'save.saved' : null;
}

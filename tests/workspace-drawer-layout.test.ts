import { describe, expect, it } from 'vitest';
import { DRAWER_LAYOUT_QUERY, foldDrawersOnNarrow } from '../packages/client/src/app/drawerLayout';

function fakeMedia(initial: boolean) {
  const listeners = new Set<() => void>();
  const media = {
    matches: initial,
    addEventListener: (_type: string, listener: () => void) => { listeners.add(listener); },
    removeEventListener: (_type: string, listener: () => void) => { listeners.delete(listener); },
  } as unknown as Pick<MediaQueryList, 'matches' | 'addEventListener' | 'removeEventListener'>;
  return {
    media,
    change(narrow: boolean) {
      Object.assign(media, { matches: narrow });
      for (const listener of listeners) listener();
    },
    listenerCount: () => listeners.size,
  };
}

describe('workspace drawer layout', () => {
  it('matches the 900px drawer breakpoint, not the 760px document-pane breakpoint', () => {
    expect(DRAWER_LAYOUT_QUERY).toBe('(max-width: 900px)');
  });

  it('folds on wide to narrow entry and only once while narrow', () => {
    const m = fakeMedia(false);
    let folds = 0;
    const stop = foldDrawersOnNarrow(m.media, () => { folds++; });
    expect(folds).toBe(0);
    m.change(false);
    expect(folds).toBe(0);
    m.change(true);
    expect(folds).toBe(1);
    m.change(true); // rotation or software-keyboard resize within the drawer layout
    expect(folds).toBe(1);
    stop();
  });

  it('preserves a drawer deliberately opened on an already narrow layout', () => {
    const m = fakeMedia(true);
    let open = true;
    const stop = foldDrawersOnNarrow(m.media, () => { open = false; });
    m.change(true);
    expect(open).toBe(true);
    m.change(false);
    expect(open).toBe(true);
    m.change(true);
    expect(open).toBe(false);
    stop();
  });

  it('folds again after a later wide to narrow transition', () => {
    const m = fakeMedia(false);
    let folds = 0;
    const stop = foldDrawersOnNarrow(m.media, () => { folds++; });
    m.change(true);
    m.change(false);
    m.change(true);
    expect(folds).toBe(2);
    stop();
  });

  it('removes the listener when the workspace is disposed', () => {
    const m = fakeMedia(false);
    let folds = 0;
    const stop = foldDrawersOnNarrow(m.media, () => { folds++; });
    expect(m.listenerCount()).toBe(1);
    stop();
    expect(m.listenerCount()).toBe(0);
    m.change(true);
    expect(folds).toBe(0);
  });
});

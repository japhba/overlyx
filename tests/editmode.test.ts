/**
 * The mode switch (app/EditModeSwitch.tsx): Editing · Suggesting · Viewing over the document's
 * change tracking and this editor's read-only state.
 */
import { describe, it, expect } from 'vitest';
import { editModeOf, applyEditMode, CHANGE_VIEWS, type EditMode } from '../packages/client/src/app/EditModeSwitch.tsx';

function switchTo(mode: EditMode, tracking: boolean, viewing: boolean) {
  const calls: string[] = [];
  applyEditMode(mode, { tracking, toggleTracking: () => { calls.push('toggle'); tracking = !tracking; }, setViewing: on => { calls.push(`viewing=${on}`); viewing = on; } });
  return { mode: editModeOf(tracking, viewing), calls };
}

describe('the mode switch', () => {
  it('shows Viewing over tracking, Suggesting when tracking, else Editing', () => {
    expect(editModeOf(false, false)).toBe('editing');
    expect(editModeOf(true, false)).toBe('suggesting');
    expect(editModeOf(true, true)).toBe('viewing');
    expect(editModeOf(false, true)).toBe('viewing');
  });

  it('Suggesting and Editing set change tracking; Viewing leaves it alone', () => {
    expect(switchTo('suggesting', false, false)).toEqual({ mode: 'suggesting', calls: ['viewing=false', 'toggle'] });
    expect(switchTo('editing', true, false)).toEqual({ mode: 'editing', calls: ['viewing=false', 'toggle'] });
    expect(switchTo('viewing', true, false)).toEqual({ mode: 'viewing', calls: ['viewing=true'] });
    // from Viewing back to what tracking already is: no tracking switch
    expect(switchTo('suggesting', true, true)).toEqual({ mode: 'suggesting', calls: ['viewing=false'] });
    expect(switchTo('editing', false, true)).toEqual({ mode: 'editing', calls: ['viewing=false'] });
  });

  it('offers every combination of the insertion / deletion filter once', () => {
    expect(new Set(CHANGE_VIEWS.map(c => `${c.ins}/${c.del}`)).size).toBe(4);
    expect(CHANGE_VIEWS.find(c => c.id === 'insertions')).toMatchObject({ label: 'Only additions', ins: true, del: false });
  });
});

/**
 * Margin mode's split (app/notespane.tsx): the notes & comments pane is a share of the document
 * pane, like VS Code's editor groups, within limits that keep both sides usable.
 */
import { describe, expect, it } from 'vitest';
import { NOTES_SHARE_DEFAULT, NOTES_SHARE_MAX, NOTES_SHARE_MIN, clampShare, notesColumnWidth } from '../packages/client/src/app/notespane';

describe('notes pane width', () => {
  it('is its share of the document pane, so it scales with the window', () => {
    expect(notesColumnWidth(1000, NOTES_SHARE_DEFAULT)).toBe(300);
    expect(notesColumnWidth(1600, NOTES_SHARE_DEFAULT)).toBe(480);
  });
  it('keeps 200px for the cards and 360px for the text', () => {
    expect(notesColumnWidth(500, 0.15)).toBe(200);          // 75px wanted
    expect(notesColumnWidth(900, 0.6)).toBe(540);           // 540 wanted, the text keeps 360
    expect(notesColumnWidth(800, 0.6)).toBe(440);           // 480 wanted, the text keeps 360
    expect(notesColumnWidth(520, 0.3)).toBe(200);           // too narrow for both: the cards keep their minimum
  });
  it('clamps the share a drag or the stored setting asks for', () => {
    expect(clampShare(0)).toBe(NOTES_SHARE_MIN);
    expect(clampShare(2)).toBe(NOTES_SHARE_MAX);
    expect(clampShare(0.42)).toBe(0.42);
  });
});

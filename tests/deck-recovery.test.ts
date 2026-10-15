// @vitest-environment happy-dom
import { beforeEach, expect, it } from 'vitest';
import { loadTextDrafts, saveTextDrafts, draftWords } from '../packages/client/src/deliverable/recovery.ts';
import { clearLocalData } from '../packages/client/src/app/localData.ts';

beforeEach(() => localStorage.clear());

it('persists only valid recovery copies and makes plain text available', () => {
  const key = 'ol.textRecovery:one';
  const draft = { id: '1', html: '<p>Original &amp; revised<br>line</p>', reason: 'Concurrent edit' };
  expect(saveTextDrafts(key, [draft])).toBe(true);
  expect(loadTextDrafts(key)).toEqual([draft]);
  expect(draftWords(draft.html)).toContain('Original & revised\nline');
  localStorage.setItem(key, JSON.stringify([draft, { id: 5, html: 'not valid' }]));
  expect(loadTextDrafts(key)).toEqual([draft]);
  expect(saveTextDrafts(key, [])).toBe(true);
  expect(localStorage.getItem(key)).toBeNull();
});

it('malformed browser storage does not strand the editor', () => {
  localStorage.setItem('ol.textRecovery:broken', '{broken');
  expect(loadTextDrafts('ol.textRecovery:broken')).toEqual([]);
});

it('sign-out removes private recovery text while preserving unrelated preferences', async () => {
  localStorage.setItem('ol.textRecovery:first', '[private]');
  localStorage.setItem('ol.textRecovery:second', '[private]');
  localStorage.setItem('ol.deckZoom', 'fit');
  await clearLocalData();
  expect(localStorage.getItem('ol.textRecovery:first')).toBeNull();
  expect(localStorage.getItem('ol.textRecovery:second')).toBeNull();
  expect(localStorage.getItem('ol.deckZoom')).toBe('fit');
});

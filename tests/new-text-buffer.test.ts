// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { bufferedTextHtml, draftWords } from '../packages/client/src/deliverable/recovery.ts';

it('keeps committed Unicode, pasted paragraphs and HTML punctuation available for recovery', () => {
  const html = bufferedTextHtml([{ key: '', text: '🙂 λ <results> & data' }, { key: 'Enter' }, { key: '', text: '日本語' }]);
  expect(html).not.toContain('<results>');
  expect(draftWords(html)).toBe('🙂 λ <results> & data\n日本語');
});

it('recovers the text after caret edits and deletion rather than the raw key stream', () => {
  expect(draftWords(bufferedTextHtml([
    { key: '', text: 'abc🙂' }, { key: 'Backspace' }, { key: 'ArrowLeft' }, { key: 'Delete' }, { key: '', text: 'λ' },
  ]))).toBe('abλ');
});

it('keeps replacement selections and stops at Escape without copying shortcut names', () => {
  expect(draftWords(bufferedTextHtml([
    { key: '', text: 'Keep old' }, { key: 'ArrowLeft', shift: true }, { key: 'ArrowLeft', shift: true },
    { key: 'ArrowLeft', shift: true }, { key: '', text: 'new' }, { key: 'z', ctrl: true }, { key: 'Escape' }, { key: 'x' },
  ]))).toBe('Keep new');
});

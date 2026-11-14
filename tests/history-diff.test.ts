/** The History pane's comparisons (app/history/): changed passages with their words, restoring one, changed slides. */
import { it, expect } from 'vitest';
import { hunks, wordDiff, changeCount } from '../packages/client/src/app/history/textdiff';
import { slidesOf, slideChanges, slidePage } from '../packages/client/src/app/history/slidediff';

it('finds the changed passage and the changed word in it', () => {
  const old = 'one\ntwo\nThe quick brown fox.\nfour\nfive\n';
  const now = 'one\ntwo\nThe quick red fox.\nfour\nfive\nsix\n';
  const list = hunks(old, now);
  expect(list).toHaveLength(2);
  expect(list[0].oldText).toBe('The quick brown fox.\n');
  expect(list[0].newText).toBe('The quick red fox.\n');
  expect(list[0].words.old.filter(p => p.kind === 'del').map(p => p.text)).toEqual(['brown']);
  expect(list[0].words.new.filter(p => p.kind === 'add').map(p => p.text)).toEqual(['red']);
  expect(list[0].before).toEqual(['one\n', 'two\n']);
  expect(list[1].oldText).toBe('');
  expect(list[1].newText).toBe('six\n');
  expect(changeCount(list)).toEqual({ added: 2, removed: 1 });
});

it('restoring a hunk puts the old passage back exactly where it was', () => {
  const old = 'a\nb\nc\nd\ne\nf\ng\n';
  const now = 'a\nB!\nc\nd\ne\nf\ng\nh\n';
  for (const h of hunks(old, now)) {
    const restored = now.slice(0, h.bOffset) + h.oldText + now.slice(h.bOffset + h.newText.length);
    // each hunk alone takes back only its own change
    expect(hunks(old, restored)).toHaveLength(hunks(old, now).length - 1);
  }
});

it('folds a lone blank between two changed words into the change', () => {
  const d = wordDiff('alpha beta gamma', 'alpha delta epsilon');
  expect(d.old.map(p => p.kind)).toEqual(['same', 'del']);
  expect(d.new).toEqual([{ kind: 'same', text: 'alpha ' }, { kind: 'add', text: 'delta epsilon' }]);
});

it('lists the slides that changed, came and went, and shows one slide alone', () => {
  const deck = (...s: string[]) => `<!doctype html><html><head><title>t</title></head><body>${s.map(x => `<section class="slide"><h1>${x}</h1></section>`).join('\n')}</body></html>`;
  const a = slidesOf(deck('One', 'Two', 'Three', 'Four'));
  const b = slidesOf(deck('One', 'Two (new)', 'Four', 'Five'));
  expect(slideChanges(a, b)).toEqual([
    { kind: 'changed', oldNo: 2, newNo: 2 },
    { kind: 'removed', oldNo: 3, newNo: null },
    { kind: 'added', oldNo: null, newNo: 4 },
  ]);
  const page = slidePage(b, 1, '/ol-d/tok/talk/');
  expect(page).toContain('<base href="/ol-d/tok/talk/">');
  expect(page).toContain('Two (new)');
  expect(page).not.toContain('<h1>One</h1>');
  expect(page).not.toContain('Five');
});

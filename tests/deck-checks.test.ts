import { describe, it, expect } from 'vitest';
import { sayIssue, checkGroups, checkCount, withLint, ontoMoves, shiftLength } from '../packages/client/src/deliverable/checks';
import type { PageIssue, PageReport } from '../packages/client/src/deliverable/protocol';

const issue = (i: Partial<PageIssue> & { kind: PageIssue['kind'] }): PageIssue => ({ text: 'for agents', ...i });

describe('Check, in people\'s words', () => {
  it('says what is wrong and what would fix it, in points and without element names', () => {
    const small = sayIssue(issue({ kind: 'small-text', name: 'Footnote', what: 'text', n: { px: 12, min: 16 } }), 'deck');
    expect(small.say).toBe('“Footnote” is 9 pt — too small to read from the back of a room.');
    expect(small.fix).toBe('Use 12 pt or more on this slide.');
    const cut = sayIssue(issue({ kind: 'overflow', name: 'A long paragraph that goes on and on and on and on', what: 'text', n: { dy: 40, dx: 0, cut: true } }), 'deck');
    expect(cut.say).toMatch(/^“A long paragraph that goes on and o…” does not fit its box: the end is cut off\.$/);
    const off = sayIssue(issue({ kind: 'offpage', name: 'Title', n: { sides: 'right bottom' } }), 'deck');
    expect(off.say).toBe('“Title” runs off the slide at the right and bottom.');
    const pic = sayIssue(issue({ kind: 'off-slide', what: 'picture', n: { sides: 'left', cut: 30 } }), 'poster');
    expect(pic.say).toBe('A picture is cut off at the poster’s left (about 30 % of it).');
    for (const i of [small, cut, off, pic]) expect(i.say + i.fix).not.toMatch(/<|px\b|div|data-/);
  });

  it('a poster: sizes as printed, pictures by their pixels', () => {
    const t = sayIssue(issue({ kind: 'small-text', name: 'References', n: { px: 16, min: 24, pt: 12, minPt: 18, assumed: false } }), 'poster');
    expect(t.say).toBe('“References” is 12 pt in print — too small to read from a metre or two away.');
    expect(t.fix).toMatch(/^Use 18 pt or more/);
    const a0 = sayIssue(issue({ kind: 'small-text', name: 'References', n: { px: 6, min: 9, pt: 13, minPt: 18, assumed: true } }), 'poster');
    expect(a0.say).toMatch(/about 13 pt when it is printed as an A0/);
    const blur = sayIssue(issue({ kind: 'low-res', what: 'picture', n: { w: 640, h: 480, cm: 40, dpi: 41, need: 2400, assumed: false } }), 'poster');
    expect(blur.say).toBe('A picture has too few pixels for its size in print: 640 pixels across 40 cm — it will look blurred.');
    expect(blur.fix).toBe('Use a picture at least 2400 pixels wide, or show it smaller.');
  });

  it('lists the slides that have something, the same thing once, overlaps with "It is meant"', () => {
    const pages: PageReport[] = [
      { index: 0, title: 'Cover', issues: [] },
      { index: 1, title: 'Results', issues: [
        issue({ kind: 'overlap', name: 'One', path: [1, 1, 0], n: { other: '"Two"' } }),
        issue({ kind: 'contrast', name: 'Pale', path: [1, 1, 2], n: { ratio: 1.6, need: 3 } }),
        issue({ kind: 'contrast', name: 'Pale', path: [1, 1, 2], n: { ratio: 1.6, need: 3 } }),
        issue({ kind: 'overlap', what: 'picture', n: { other: '<div.box>', covers: true } }),
      ] },
    ];
    const groups = checkGroups(pages, 'deck');
    expect(groups.map(g => g.slide)).toEqual([1]);
    expect(checkCount(groups)).toBe(3);
    expect(groups[0].entries[0]).toMatchObject({ say: "“One” and “Two” lie on top of each other.", lint: "no-overlap", path: [1, 1, 0] });
    expect(groups[0].entries[2].say).toBe('A picture covers part of another object.');
    // (no object to mark: no "It is meant")
    expect(groups[0].entries[2].lint).toBeUndefined();
  });

  it('"It is meant" adds its word to data-ol-lint, keeping the others', () => {
    expect(withLint(null, 'no-overlap')).toBe('no-overlap');
    expect(withLint('no-edge', 'no-overlap')).toBe('no-edge no-overlap');
    expect(withLint(' no-overlap ', 'no-overlap')).toBe('no-overlap');
    expect(sayIssue(issue({ kind: 'off-slide', what: 'picture', path: [1, 1, 3], n: { sides: 'right', cut: 20 } }), 'deck').lint).toBe('no-edge');
    expect(sayIssue(issue({ kind: 'off-slide', what: 'picture', n: { all: true } }), 'deck').lint).toBeUndefined();
  });

  it('one-click fixes: text that does not fit shrinks, objects off the slide move the least back onto it', () => {
    const pages: PageReport[] = [{ index: 0, title: '', issues: [
      issue({ kind: 'overflow', path: [1, 1, 0], n: { dy: 30, cut: true } }),
      issue({ kind: 'overflow', path: [1, 1, 1], n: { dx: 90 } }),
      issue({ kind: 'offpage', path: [1, 1, 1], n: { sides: 'right' } }),
      issue({ kind: 'small-text', path: [1, 1, 2], n: { px: 10, min: 16 } }),
    ] }];
    const [g] = checkGroups(pages, 'deck');
    expect(g.entries.map(e => [e.kind, e.act])).toEqual([['overflow', 'fit'], ['offpage', 'onto'], ['small-text', undefined]]);
    const f = { left: 0, top: 0, right: 1280, bottom: 720 };
    expect(ontoMoves({ left: 1100, top: 600, right: 1400, bottom: 800 }, f)).toEqual({ dx: -120, dy: -80 });
    expect(ontoMoves({ left: -50, top: 10, right: 100, bottom: 60 }, f)).toEqual({ dx: 50, dy: 0 });
    // (wider than the slide: its left edge onto the slide's)
    expect(ontoMoves({ left: 100, top: 0, right: 1500, bottom: 50 }, f)).toEqual({ dx: -100, dy: 0 });
    // (the move in the unit the source has: a poster's mm stay mm)
    expect(shiftLength('1050px', 1050, -120)).toBe('930px');
    expect(shiftLength('', 300, 12.345)).toBe('312.35px');
    expect(shiftLength('60mm', 226.77, -96)).toBe('34.6mm');
  });
});

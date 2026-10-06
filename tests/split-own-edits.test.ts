// @vitest-environment happy-dom
/**
 * One's own paragraph splits, joins and inline insertions, with nobody else editing: the server's
 * repair of moves (server/moves.ts) must leave them alone, and Ctrl+Z must undo them.
 *
 * - Enter right after (or before) a formula or a quote in a paragraph loaded from the file: the unit
 *   after the split point has the moved unit as its Yjs origin, and the repair took it for a late
 *   edit — the rest of the paragraph went back into the first half, an empty paragraph below it.
 *   Records now carry what their author had (`sv`).
 * - "abc" typed with smart quotes into a run: the closing quote's run split re-examined the opening
 *   quote (the author's own item next to its earlier copies) and moved it to the end of the paragraph.
 * - Ctrl+Z after Enter: the server restated the editor's record, the editor followed it to its own
 *   copies (followMoves) — undo then restored the originals as the copies it was deleting, and the
 *   paragraph lost its first half.
 */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { ySyncPluginKey } from 'y-prosemirror';
import { schema } from '@overlyx/core';
import { Net, par, text, math, type Json, type Peer } from './yjs-net';
import { encodeRecord, decodeRecord, sawBefore } from '../packages/core/src/moves';

const quote = (kind: string): Json => ({ type: 'quotes', attrs: { kind } });
const bold = [{ type: 'series', attrs: { value: 'bold' } }];

const TESTING = 'testing effects (testing things enhances memory more than $x$ rereading)';
const testing = () => ({ type: 'doc', content: [par(text('testing effects (testing things enhances memory more than '), math('x'), text(' rereading)')), par(text('Next paragraph.'))] });
/** proposal.tex's paragraph: quote insets and bold text */
const WHY = 'Why (mechanistically and normatively) do learners (people/machines) learn better when they <quotes>practice<quotes>/generate instead of just <quotes>observing<quotes>/recognizing/verifying things? I.e., why do you need to study?';
const why = () => ({
  type: 'doc', content: [par(
    text('Why (mechanistically and normatively) do learners (people/machines) learn better when they '), quote('eld'), text('practice'), quote('erd'),
    text('/'), text('generate', bold), text(' instead of just '), quote('eld'), text('observing'), quote('erd'), text('/'), text('recognizing', bold),
    text('/verifying things? I.e., why do you need to study?')), par(text('Next paragraph.'))],
});
const loss = () => ({ type: 'doc', content: [par(text('The loss '), math('L'), text(' is minimised over '), math('\\theta'), text(' by gradient descent.')), par(text('Next.'))] });

/** an editor with y-prosemirror's undo manager (yUndoPlugin tracks the sync plugin's origin) */
function editor(doc: Json, repair = true): { net: Net; a: Peer; um: Y.UndoManager } {
  const net = new Net(doc, { repair });
  const a = net.peer('a', 200);
  const um = new Y.UndoManager(a.ydoc.getXmlFragment('prosemirror'), { trackedOrigins: new Set([ySyncPluginKey]) });
  return { net, a, um };
}

describe('Enter next to an inline node stays where it was pressed', () => {
  const cases: [string, () => Json, (a: Peer) => number, string[]][] = [
    ['after a formula', loss, a => a.find(' is minimised'), ['The loss $L$', ' is minimised over $\\theta$ by gradient descent.']],
    ['before a formula', loss, a => a.find('The loss ') + 'The loss '.length, ['The loss ', '$L$ is minimised over $\\theta$ by gradient descent.']],
    ['after an opening quote', why, a => a.find('practice'), [WHY.slice(0, WHY.indexOf('practice')), WHY.slice(WHY.indexOf('practice'))]],
    ['before a quote', why, a => a.find('observing') - 1, [WHY.slice(0, WHY.indexOf('<quotes>observing')), WHY.slice(WHY.indexOf('<quotes>observing'))]],
  ];
  for (const [label, doc, at, halves] of cases) {
    it(label, () => {
      const { net, a } = editor(doc());
      a.enter(at(a));
      expect(a.pars().slice(0, 2)).toEqual(halves);
      expect(net.converged().slice(0, 2)).toEqual(halves);
    });
  }
});

describe('smart quotes typed into a run', () => {
  it('"abc" in the middle of a paragraph: both quotes stay where they were typed', () => {
    const { net, a } = editor({ type: 'doc', content: [par(text('The central comparison is teacher-supplied versus student-generated data.')), par(text('Next.'))] });
    const insertQuote = (side: 'l' | 'r') => a.view.dispatch(a.view.state.tr.replaceSelectionWith(schema.nodes.quotes.create({ kind: `e${side}d` }), false));
    a.select(a.find('versus'));
    insertQuote('l'); net.flush();
    a.type('abc'); net.flush();
    insertQuote('r'); net.flush();
    a.type(' '); net.flush();
    expect(net.converged()[0]).toBe('The central comparison is teacher-supplied <quotes>abc<quotes> versus student-generated data.');
  });
});

describe('undo of one\'s own split or join', () => {
  for (const repair of [true, false]) {
    describe(repair ? 'with the server repair' : 'without it', () => {
      it('Enter near the start, undo, redo, undo', () => {
        const { net, a, um } = editor(testing(), repair);
        a.enter(a.find('sting effects'));
        expect(net.converged()).toEqual(['te', 'sting effects (testing things enhances memory more than $x$ rereading)', 'Next paragraph.']);
        um.undo();
        expect(net.converged()).toEqual([TESTING, 'Next paragraph.']);
        um.redo();
        expect(net.converged()).toEqual(['te', 'sting effects (testing things enhances memory more than $x$ rereading)', 'Next paragraph.']);
        um.undo();
        expect(net.converged()).toEqual([TESTING, 'Next paragraph.']);
      });

      it('Enter near the end (the second half moves), undo', () => {
        const { net, a, um } = editor(testing(), repair);
        a.enter(a.find('ading)'));
        expect(net.converged()).toEqual(['testing effects (testing things enhances memory more than $x$ rere', 'ading)', 'Next paragraph.']);
        um.undo();
        expect(net.converged()).toEqual([TESTING, 'Next paragraph.']);
      });

      it('Enter, typing in the new paragraph, undo twice', () => {
        const { net, a, um } = editor(testing(), repair);
        a.enter(a.find('things'));
        net.flush();
        um.stopCapturing();
        a.type('NEW ');
        expect(net.converged()).toEqual(['testing effects (testing ', 'NEW things enhances memory more than $x$ rereading)', 'Next paragraph.']);
        um.undo();
        expect(net.converged()).toEqual(['testing effects (testing ', 'things enhances memory more than $x$ rereading)', 'Next paragraph.']);
        um.undo();
        expect(net.converged()).toEqual([TESTING, 'Next paragraph.']);
      });

      it('typing, Enter in the typed text, undo twice', () => {
        const { net, a, um } = editor(testing(), repair);
        a.type('XYZ ', a.find('rereading'));
        net.flush();
        um.stopCapturing();
        a.enter(a.find('YZ '));
        net.flush();
        um.stopCapturing();
        um.undo();
        expect(net.converged()).toEqual(['testing effects (testing things enhances memory more than $x$ XYZ rereading)', 'Next paragraph.']);
        um.undo();
        expect(net.converged()).toEqual([TESTING, 'Next paragraph.']);
      });

      it('a join (Backspace at the start of a paragraph), undo', () => {
        const { net, a, um } = editor(testing(), repair);
        a.joinAt('Next paragraph');
        expect(net.converged()).toEqual([TESTING + 'Next paragraph.']);
        um.undo();
        expect(net.converged()).toEqual([TESTING, 'Next paragraph.']);
      });

      for (const [label, at] of [['right after a quote', (a: Peer) => a.find('practice')], ['before a quote', (a: Peer) => a.find('observing') - 1]] as const) {
        it(`Enter ${label} in a paragraph with quotes and bold, undo`, () => {
          const { net, a, um } = editor(why(), repair);
          a.enter(at(a));
          net.flush();
          um.undo();
          expect(net.converged()).toEqual([WHY, 'Next paragraph.']);
        });
      }
    });
  }
});

describe('move records', () => {
  const base = { t: 1, server: false, size: 2, protect: [Y.createID(1, 1)], adopt: [], entries: [1, 2, 2, 1, 200, 6] };
  it('carry what their author had; records without it still read', () => {
    const sv = new Map([[1, 230], [7, 3]]);
    const r = decodeRecord('c200-9', encodeRecord({ ...base, sv }))!;
    expect(r.entries).toEqual(base.entries);
    expect([...r.sv!]).toEqual([...sv]);
    expect(sawBefore(r, Y.createID(1, 229))).toBe(true);
    expect(sawBefore(r, Y.createID(1, 230))).toBe(false);
    expect(sawBefore(r, Y.createID(9, 0))).toBe(false);
    const old = decodeRecord('c200-9', encodeRecord(base))!;
    expect(old.sv).toBeUndefined();
    expect(sawBefore(old, Y.createID(1, 0))).toBe(false);
  });
});

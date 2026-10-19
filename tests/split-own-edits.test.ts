// @vitest-environment happy-dom
/**
 * One's own paragraph splits, joins and inline insertions, with nobody else editing: they stay as
 * they were made, and Ctrl+Z undoes them. (Scenarios from the CRDT's model 1, whose server-side
 * repair of moves once took such edits for late ones: Enter right after or before a formula or a
 * quote, smart quotes typed into a run, undo after Enter. Model 2 moves nothing and repairs nothing.)
 */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { closeHistory } from 'prosemirror-history';
import { schema } from '@overlyx/core';
import { Net, par, text, math, type Json, type Peer } from './yjs-net';

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

/** an editor and its undo (ProseMirror's history, editor/collab.ts) */
function editor(doc: Json): { net: Net; a: Peer; um: { undo(): void; redo(): void; stopCapturing(): void } } {
  const net = new Net(doc);
  const a = net.peer('a', 200);
  const um = { undo: () => { a.undo(); }, redo: () => { a.redo(); }, stopCapturing: () => { a.view.dispatch(closeHistory(a.view.state.tr)); } };
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
  {
    {
      it('Enter near the start, undo, redo, undo', () => {
        const { net, a, um } = editor(testing());
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
        const { net, a, um } = editor(testing());
        a.enter(a.find('ading)'));
        expect(net.converged()).toEqual(['testing effects (testing things enhances memory more than $x$ rere', 'ading)', 'Next paragraph.']);
        um.undo();
        expect(net.converged()).toEqual([TESTING, 'Next paragraph.']);
      });

      it('Enter, typing in the new paragraph, undo twice', () => {
        const { net, a, um } = editor(testing());
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
        const { net, a, um } = editor(testing());
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
        const { net, a, um } = editor(testing());
        a.joinAt('Next paragraph');
        expect(net.converged()).toEqual([TESTING + 'Next paragraph.']);
        um.undo();
        expect(net.converged()).toEqual([TESTING, 'Next paragraph.']);
      });

      for (const [label, at] of [['right after a quote', (a: Peer) => a.find('practice')], ['before a quote', (a: Peer) => a.find('observing') - 1]] as const) {
        it(`Enter ${label} in a paragraph with quotes and bold, undo`, () => {
          const { net, a, um } = editor(why());
          a.enter(at(a));
          net.flush();
          um.undo();
          expect(net.converged()).toEqual([WHY, 'Next paragraph.']);
        });
      }
    }
  }
});

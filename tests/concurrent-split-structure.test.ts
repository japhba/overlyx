// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import * as Y from 'yjs';
import { ySyncPluginKey } from 'y-prosemirror';
import { TextSelection } from 'prosemirror-state';
import { Net, par, text, math, emph, type Peer } from './yjs-net';

const content = { type: 'doc', content: [
  par(text('INTRO')),
  { ...par(text('START '), text('OMEGA', emph), text(' '), math('u^2'), text(' SIGMA END ')), attrs: { layout: 'Standard', align: 'center' } },
  par(text('TAIL')),
] };
const act = (net: Net, fn: () => void) => {
  fn();
  for (const peer of net.peers) peer.view.dispatch(peer.view.state.tr.setSelection(TextSelection.atStart(peer.view.state.doc)));
};
const clean = (net: Net) => net.converged().map(paragraph => paragraph.replace(/\s+/g, ' ').trim());
const close = (net: Net) => { for (const peer of net.peers) { peer.view.destroy(); peer.ydoc.destroy(); } net.server.destroy(); };

it('recovers a copied text suffix with its marks while preserving a formula in the joined tail', () => {
  const net = new Net({ type: 'doc', content: [
    par(text('INTRO')),
    par(text('START '), text('OMEGA', emph), text(' SIGMA END ')),
    par(text('TAIL '), math('u^2'), text(' AFTER')),
  ] }), a = net.peer('a', 100), b = net.peer('b', 200);
  try {
    act(net, () => a.joinAt('TAIL'));
    act(net, () => net.offline(b));
    act(net, () => b.mark('SIGMA', 'series', { value: 'bold' }));
    act(net, () => b.typeBefore('OMEGA', 'MIDDLE '));
    act(net, () => b.enterBefore('MIDDLE'));
    act(net, () => b.enterBefore('OMEGA'));
    net.online(b);
    expect(clean(net)).toEqual(['INTRO', 'START', 'MIDDLE', 'OMEGA SIGMA END TAIL $u^2$ AFTER']);
    net.restart();
    net.online(a); net.online(b);
    expect(clean(net)).toEqual(['INTRO', 'START', 'MIDDLE', 'OMEGA SIGMA END TAIL $u^2$ AFTER']);
    for (const peer of net.peers) {
      expect(peer.formulas()).toEqual(['u^2']);
      expect(peer.marked('emph')).toBe('OMEGA');
      expect(peer.marked('series')).toBe('SIGMA');
    }
  } finally { close(net); }
});

function splitOffline(net: Net, b: Peer): void {
  act(net, () => net.offline(b));
  act(net, () => b.setFormula('u^2', 'u^3'));
  act(net, () => b.mark('SIGMA', 'series', { value: 'bold' }));
  act(net, () => b.typeBefore('OMEGA', 'MIDDLE '));
  act(net, () => b.enterBefore('MIDDLE'));
  act(net, () => b.enterBefore('OMEGA'));
}

for (const delivery of ['split-first', 'join-first', 'restart'] as const) {
  it(`keeps both independent Enter boundaries, inline attributes and marks after a stale join (${delivery})`, () => {
    const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200);
    try {
      act(net, () => a.joinAt('TAIL'));
      splitOffline(net, b);
      if (delivery !== 'split-first') net.send(a);
      if (delivery === 'restart') net.restart();
      net.online(b);
      if (!a.online) net.online(a);
      expect(clean(net)).toEqual(['INTRO', 'START', 'MIDDLE', 'OMEGA $u^3$ SIGMA END TAIL']);
      for (const peer of net.peers) {
        expect(peer.formulas()).toEqual(['u^3']);
        expect(peer.marked('emph')).toBe('OMEGA');
        expect(peer.marked('series')).toBe('SIGMA');
        expect(peer.view.state.doc.child(3).attrs.align).toBe('center');
      }
    } finally { close(net); }
  });
}

it('retains explicit deletion and its Undo mapping in a recovered split suffix', () => {
  const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200);
  let undo: Y.UndoManager | undefined;
  try {
    act(net, () => a.joinAt('TAIL'));
    splitOffline(net, b);
    undo = new Y.UndoManager(b.ydoc.getXmlFragment('prosemirror'), { trackedOrigins: new Set([ySyncPluginKey]) });
    act(net, () => { const at = b.find('END '); b.select(at, at + 4); b.view.dispatch(b.view.state.tr.deleteSelection()); });
    net.send(a);
    net.online(b);
    expect(clean(net)).toEqual(['INTRO', 'START', 'MIDDLE', 'OMEGA $u^3$ SIGMA TAIL']);
    act(net, () => undo!.undo());
    expect(clean(net)).toEqual(['INTRO', 'START', 'MIDDLE', 'OMEGA $u^3$ SIGMA END TAIL']);
    act(net, () => undo!.redo());
    expect(clean(net)).toEqual(['INTRO', 'START', 'MIDDLE', 'OMEGA $u^3$ SIGMA TAIL']);
    for (const peer of net.peers) {
      expect(peer.formulas()).toEqual(['u^3']);
      expect(peer.marked('emph')).toBe('OMEGA');
      expect(peer.marked('series')).toBe('SIGMA');
    }
  } finally { undo?.destroy(); close(net); }
});

for (const bold of [true, false]) {
  it(`preserves an already delivered ${bold ? 'bold change' : 'bold removal'} unseen by a stale join`, () => {
    const net = new Net({ type: 'doc', content: [
      par(text('INTRO')),
      par(text('START '), text('SIGMA', bold ? undefined : [{ type: 'series', attrs: { value: 'bold' } }]), text(' END ')),
      par(text('TAIL')),
    ] }), a = net.peer('a', 100), b = net.peer('b', 200);
    try {
      act(net, () => a.joinAt('TAIL'));
      act(net, () => {
        if (bold) b.mark('SIGMA', 'series', { value: 'bold' });
        else {
          const at = b.find('SIGMA');
          b.view.dispatch(b.view.state.tr.removeMark(at, at + 5, b.view.state.schema.marks.series));
        }
      });
      // The server has the formatting before the stale join arrives, so this
      // tests a formerly live directive rather than one received as a tombstone.
      net.send(b); net.send(a);
      expect(clean(net)).toEqual(['INTRO', 'START SIGMA END TAIL']);
      for (const peer of net.peers) expect(peer.marked('series')).toBe(bold ? 'SIGMA' : '');
    } finally { close(net); }
  });
}

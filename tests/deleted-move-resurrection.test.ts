// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { TextSelection } from 'prosemirror-state';
import * as Y from 'yjs';
import { ySyncPluginKey } from 'y-prosemirror';
import { Net, par, text, math, type Peer } from './yjs-net';
import { MOVES_MAP, MOVES_ORIGIN, decodeRecord, encodeRecord } from '../packages/core/src/moves';

const words = (n: number, from: number) => Array.from({ length: n }, (_, i) => `w${String(from + i).padStart(3, '0')}`).join(' ');
const content = { type: 'doc', content: [
  par(text(words(6, 1) + ' '), math('a+b'), text(' ' + words(8, 7) + ' '), math('c'), text(' ' + words(5, 15) + ' ')),
  par(text(words(10, 20) + ' ')),
  par(text(words(4, 30) + ' '), math('x^2'), text(' ' + words(4, 34) + ' ')),
] };
const reset = (net: Net) => { for (const p of net.peers) p.view.dispatch(p.view.state.tr.setSelection(TextSelection.atStart(p.view.state.doc))); };
function act(net: Net, fn: () => void): void { fn(); reset(net); }
function remove(p: Peer, word: string): void {
  const from = p.find(word);
  p.select(from, from + word.length + 1);
  p.view.dispatch(p.view.state.tr.deleteSelection());
}
function finish(net: Net, deleted: string[], inserted: string[] = []): string {
  for (const p of net.peers) if (!p.online) net.online(p);
  const final = net.converged().join(' ');
  for (const word of deleted) expect(final.split(/[\s$]+/), `${word} was explicitly deleted`).not.toContain(word);
  for (const word of inserted) expect(final.split(/[\s$]+/).filter(w => w === word)).toHaveLength(1);
  for (let i = 1; i <= 37; i++) {
    const word = `w${String(i).padStart(3, '0')}`;
    if (!deleted.includes(word)) expect(final.split(/[\s$]+/).filter(w => w === word), word).toHaveLength(1);
  }
  expect(net.peers.map(p => p.formulas())).toEqual(net.peers.map(() => ['a+b', 'c', 'x^2']));
  for (const p of net.peers) { p.view.destroy(); p.ydoc.destroy(); }
  net.server.destroy();
  return final;
}

function expectBaseOrder(final: string, deleted: string[]): void {
  const got = final.split(/[\s$]+/).filter(word => /^w\d{3}$/.test(word));
  expect(got).toEqual(Array.from({ length: 37 }, (_, i) => `w${String(i + 1).padStart(3, '0')}`).filter(word => !deleted.includes(word)));
}

describe('explicit deletions survive competing paragraph copies', () => {
  it('retains an offline deletion followed by a split when a stale peer copied the deleted word', () => {
    const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200);
    act(net, () => net.offline(a));
    act(net, () => remove(a, 'w004'));
    act(net, () => b.typeBefore('w005', 'Tb6 '));
    act(net, () => b.enterBefore('w004'));
    act(net, () => a.enterBefore('w002'));
    act(net, () => net.flush());
    finish(net, ['w004'], ['Tb6']);
  });

  it('removes a word deleted from a local split copy before a competing stale split arrives', () => {
    const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200);
    act(net, () => b.typeBefore('w013', 'Tb1 '));
    act(net, () => b.enterBefore('Tb1'));
    act(net, () => a.enterBefore('w014'));
    act(net, () => remove(a, 'w014'));
    finish(net, ['w014'], ['Tb1']);
  });

  it('retains two independent deletions when an offline deleter subsequently splits its stale run', () => {
    const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200), c = net.peer('c', 300);
    act(net, () => remove(a, 'w027'));
    act(net, () => net.offline(b));
    act(net, () => remove(b, 'w022'));
    act(net, () => c.enterBefore('w022'));
    act(net, () => net.flush());
    act(net, () => b.enterBefore('w027'));
    finish(net, ['w022', 'w027']);
  });

  for (const history of ['current', 'restart'] as const) it(`retains a deletion from a joined copy through concurrent joins and splits (${history} history)`, () => {
    const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200);
    act(net, () => a.enterBefore('w030'));
    act(net, () => net.flush());
    act(net, () => b.joinAt('w030'));
    act(net, () => net.flush());
    act(net, () => a.typeBefore('w030', 'Ta3 '));
    act(net, () => remove(b, 'w028'));
    act(net, () => a.enterBefore('w032'));
    act(net, () => a.joinAt('Ta3'));
    // The two authors have not received each other's edits, so their local
    // actions commute. A restart here persists the propagated deletion before
    // the stale peer's join arrives and tries to re-copy the merged string.
    if (history === 'restart') net.restart();
    act(net, () => b.joinAt('w030'));
    expectBaseOrder(finish(net, ['w028'], ['Ta3']), ['w028']);
  });

  it('retains a deletion from an offline joined copy after two other authors move its original run', () => {
    const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200), c = net.peer('c', 300);
    act(net, () => net.offline(a));
    act(net, () => a.joinAt('w020'));
    act(net, () => b.joinAt('w020'));
    act(net, () => c.enterBefore('w013'));
    act(net, () => remove(a, 'w024'));
    act(net, () => net.offline(c));
    act(net, () => a.enterBefore('w016'));
    act(net, () => net.receive(b));
    act(net, () => net.offline(b));
    act(net, () => b.joinAt('w013'));
    expectBaseOrder(finish(net, ['w024']), ['w024']);
  });

  for (const history of ['current', 'restart'] as const) it(`retains a propagated deletion when a third offline author copies that tombstone again (${history} history)`, () => {
    const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200), c = net.peer('c', 300);
    act(net, () => net.offline(a));
    act(net, () => remove(a, 'w006'));
    act(net, () => b.enterBefore('w004'));
    act(net, () => net.flush());
    act(net, () => net.offline(c));
    act(net, () => net.online(a));
    act(net, () => net.flush());
    if (history === 'restart') net.restart();
    act(net, () => c.enterBefore('w005'));
    expectBaseOrder(finish(net, ['w006']), ['w006']);
  });

  for (const history of ['current', 'restart'] as const) it(`allows the author to undo and redo an explicit deletion after it propagated to a split copy (${history} history)`, () => {
    const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200);
    const undo = new Y.UndoManager(a.ydoc.getXmlFragment('prosemirror'), { trackedOrigins: new Set([ySyncPluginKey]) });
    act(net, () => net.offline(a));
    act(net, () => remove(a, 'w006'));
    act(net, () => b.enterBefore('w004'));
    act(net, () => net.flush());
    act(net, () => net.online(a));
    expect(net.converged().join(' ')).not.toContain('w006');
    if (history === 'restart') {
      net.restart();
      for (const peer of net.peers) net.online(peer);
      act(net, () => net.flush());
    }
    act(net, () => undo.undo());
    const restored = net.converged().join(' ');
    expect(restored.split(/[\s$]+/).filter(word => word === 'w006')).toHaveLength(1);
    expectBaseOrder(restored, []);
    act(net, () => undo.redo());
    undo.destroy();
    expectBaseOrder(finish(net, ['w006']), ['w006']);
  });

  for (const history of ['current', 'restart', 'legacy', 'legacy-pruned'] as const) it(`keeps text typed beside a copied word when another author deletes that word (${history} history)`, () => {
    const net = new Net(content), a = net.peer('a', 100), b = net.peer('b', 200);
    net.peer('c', 300);
    act(net, () => b.enterBefore('w006'));
    act(net, () => net.flush());
    if (history.startsWith('legacy')) {
      // Persisted records written before destination-run retention protected
      // only deleted originals. Preserve that valid old record format.
      const records = net.server.getMap(MOVES_MAP);
      net.server.transact(() => {
        for (const [key, value] of records) {
          const record = decodeRecord(key, value)!;
          record.protect = record.protect.filter(id => Y.getItem(net.server.store, id).deleted);
          delete record.joined;
          records.set(key, encodeRecord(record));
        }
      }, MOVES_ORIGIN);
    }
    if (history !== 'current') {
      net.restart();
      for (const p of net.peers) net.online(p);
      act(net, () => net.flush());
    }
    if (history === 'legacy-pruned') {
      // Removing an unrelated expired record reloads the move index. Guards
      // inferred from the retained legacy records must survive that reset.
      net.server.getMap(MOVES_MAP).set('s-expired', encodeRecord({ t: 0, server: true, size: 0, protect: [], adopt: [], entries: [] }));
      net.repair!.prune();
      expect(net.server.getMap(MOVES_MAP).has('s-expired')).toBe(false);
      act(net, () => net.flush());
    }
    act(net, () => b.typeBefore('w006', 'Tb2 '));
    act(net, () => remove(a, 'w006'));
    finish(net, ['w006'], ['Tb2']);
  });
});

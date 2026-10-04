// @vitest-environment happy-dom
/**
 * A paragraph split (or join) while somebody else edits the same paragraph without having seen it yet.
 * Yjs cannot move text: the split copies one half into a new paragraph, so whatever the other side
 * typed, deleted or formatted in the copied original was misplaced or lost on reconnect. The
 * editor records what it copied (core/moves.ts) and the server moves the concurrent edits after the
 * copy (server/moves.ts): every typed word survives once, where its author put it.
 */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { prosemirrorJSONToYXmlFragment } from 'y-prosemirror';
import { schema } from '@overlyx/core';
import { Net, par, text, math, once, absent } from './yjs-net';
import { MoveRepair } from '../packages/server/src/moves';
import { recordCopies } from '../packages/core/src/moves';

const ENCODER = [
  text('The encoder is composed of a stack of '), math('N=6'),
  text(' identical layers. Each layer has two sub-layers: a multi-head self-attention mechanism. That is, the output is '),
  math('\\mathrm{LayerNorm}(x)'), text(', where '), math('f(x)'), text(' is the function.'),
];
const encoder = () => ({ type: 'doc', content: [par(...ENCODER), par(text('Next paragraph.'))] });

describe('a split on one side, edits on the other side that has not seen it', () => {
  it('Enter near the end: offline typing in the copied half lands there, also behind formulas', () => {
    const net = new Net(encoder());
    const on = net.peer('online', 200), off = net.peer('offline', 100);
    net.offline(off);
    on.enterBefore('That is');
    net.flush();
    off.typeBefore('a multi-head', 'OFFA ');
    off.typeBefore('the output', 'OFFB ');
    off.typeBefore('is the function', 'OFFC ');
    off.typeAfter('the function.', ' OFFD');
    net.online(off);
    const t = net.converged();
    expect(t).toEqual([
      'The encoder is composed of a stack of $N=6$ identical layers. Each layer has two sub-layers: OFFA a multi-head self-attention mechanism. ',
      'That is, OFFB the output is $\\mathrm{LayerNorm}(x)$, where $f(x)$ OFFC is the function. OFFD',
      'Next paragraph.',
    ]);
  });

  it('Enter near the start: offline typing in the copied first half lands there', () => {
    const net = new Net(encoder());
    const on = net.peer('online', 200), off = net.peer('offline', 100);
    net.offline(off);
    on.enterBefore('stack of');
    net.flush();
    off.typeBefore('encoder is', 'OFFA ');
    off.typeBefore('composed', 'OFFB ');
    off.typeBefore('a stack', 'OFFC ');
    off.typeBefore('multi-head', 'OFFD ');
    net.online(off);
    const t = net.converged();
    expect(t[0]).toBe('The OFFA encoder is OFFB composed of OFFC a ');
    expect(t[1]).toMatch(/^stack of \$N=6\$ identical layers\. Each layer has two sub-layers: a OFFD multi-head/);
  });

  it('offline deletions in the copied half are applied to the copy', () => {
    const net = new Net(encoder());
    const on = net.peer('online', 200), off = net.peer('offline', 100);
    net.offline(off);
    on.enterBefore('That is');
    net.flush();
    off.remove('the output is ');
    off.remove(' is the function.');
    net.online(off);
    const t = net.converged();
    expect(t[1]).toBe('That is, $\\mathrm{LayerNorm}(x)$, where $f(x)$');
  });

  it('offline formatting and a formula edit in the copied half survive', () => {
    const net = new Net(encoder());
    const on = net.peer('online', 200), off = net.peer('offline', 100);
    net.offline(off);
    on.enterBefore('That is');
    net.flush();
    off.mark('the output', 'emph', { value: 'on' });
    off.setFormula('f(x)', 'g(y)');
    net.online(off);
    const t = net.converged();
    expect(t[1]).toBe('That is, the output is $\\mathrm{LayerNorm}(x)$, where $g(y)$ is the function.');
    for (const p of net.peers) expect(p.marked('emph')).toBe('the output');
  });

  it('the splitter offline: what the online side typed meanwhile is kept and placed', () => {
    const net = new Net(encoder());
    const on = net.peer('online', 200), off = net.peer('offline', 100);
    net.offline(off);
    off.enterBefore('That is');
    off.typeBefore('That is', 'SPLITTER ');
    on.typeBefore('the output', 'ONB ');
    on.typeBefore('is the function', 'ONC ');
    on.remove('a multi-head ');
    net.flush();
    net.online(off);
    const t = net.converged();
    expect(t).toEqual([
      'The encoder is composed of a stack of $N=6$ identical layers. Each layer has two sub-layers: self-attention mechanism. ',
      'SPLITTER That is, ONB the output is $\\mathrm{LayerNorm}(x)$, where $f(x)$ ONC is the function.',
      'Next paragraph.',
    ]);
  });

  for (const order of ['peer-first', 'server-first'] as const) {
    it(`both sides offline, then the typist reconnects (${order})`, () => {
      const net = new Net(encoder());
      const a = net.peer('splitter', 200), b = net.peer('typist', 100);
      net.offline(a); net.offline(b);
      a.enterBefore('That is');
      b.typeBefore('the output', 'TYPB ');
      b.typeBefore('is the function', 'TYPC ');
      net.online(a, order);
      net.online(b, order);
      const t = net.converged();
      expect(t[1]).toBe('That is, TYPB the output is $\\mathrm{LayerNorm}(x)$, where $f(x)$ TYPC is the function.');
    });
  }
});

describe('two people split the same paragraph before syncing', () => {
  for (const [first, second] of [['That is', 'multi-head'], ['multi-head', 'That is'], ['That is', 'That is']] as const) {
    it(`at "${first}" and "${second}": every passage once, in order`, () => {
      const net = new Net(encoder());
      const a = net.peer('a', 100), b = net.peer('b', 200);
      net.offline(a); net.offline(b);
      a.enterBefore(first);
      b.enterBefore(second);
      net.online(a);
      net.online(b);
      const t = net.converged();
      for (const s of ['The encoder', 'identical layers', 'multi-head', 'That is', 'the output', 'where', 'is the function', 'Next paragraph']) once(t, s);
      const all = t.join('|');
      expect(all.indexOf('multi-head')).toBeLessThan(all.indexOf('That is'));
      expect(t.filter(p => p === '').length).toBeLessThanOrEqual(first === second ? 1 : 0);
    });
  }
});

describe('joins', () => {
  it('Backspace at a paragraph start while somebody offline types into it', () => {
    const net = new Net({ type: 'doc', content: [par(text('First paragraph.')), par(text('Second '), math('x'), text(' paragraph here.'))] });
    const on = net.peer('online', 200), off = net.peer('offline', 100);
    net.offline(off);
    on.joinAt('Second');
    net.flush();
    off.typeBefore('paragraph here', 'OFF ');
    off.typeBefore('Second', 'START ');
    net.online(off);
    const t = net.converged();
    expect(t).toEqual(['First paragraph.START Second $x$ OFF paragraph here.']);
  });
});

describe('the repair', () => {
  it('a server restart between the split and the reconnect: the kept originals and the records are loaded again', () => {
    const net = new Net(encoder());
    const on = net.peer('online', 200), off = net.peer('offline', 100);
    net.offline(off);
    on.enterBefore('That is');
    net.flush();
    net.restart();
    off.typeBefore('is the function', 'LATE ');
    off.remove('the output is ');
    net.online(on);
    net.online(off);
    const t = net.converged();
    expect(t[1]).toBe('That is, $\\mathrm{LayerNorm}(x)$, where $f(x)$ LATE is the function.');
  });

  for (const where of ['on a worker’s mirror', 'on the document itself'] as const) {
    it(`the server’s own diff (a file changed on disk), made ${where}, is applied as it is: nothing it deleted comes back, nothing moves`, () => {
      const net = new Net(encoder());
      const a = net.peer('a', 100);
      a.enterBefore('That is');
      a.typeBefore('the output', 'the output ');
      net.flush();
      // the file has the paragraph whole again, without the doubled words: the diff joins the halves
      // (copying them, recorded like an editor's copies) and drops the words
      const diff = (d: Y.Doc) => d.transact(tr => { prosemirrorJSONToYXmlFragment(schema, encoder(), d.getXmlFragment('prosemirror')); recordCopies(tr); }, 'file-load');
      if (where === 'on the document itself') diff(net.server);
      else {
        const mirror = new Y.Doc();
        Y.applyUpdate(mirror, Y.encodeStateAsUpdate(net.server));
        const knew = Y.decodeStateVector(Y.encodeStateVector(mirror));
        const updates: Uint8Array[] = [];
        mirror.on('update', (u: Uint8Array) => updates.push(u));
        diff(mirror);
        net.repair!.receive(Y.mergeUpdates(updates), 'file-load', { step2: false, knows: knew, server: true });
      }
      expect(net.converged()).toEqual([
        'The encoder is composed of a stack of $N=6$ identical layers. Each layer has two sub-layers: a multi-head self-attention mechanism. That is, the output is $\\mathrm{LayerNorm}(x)$, where $f(x)$ is the function.',
        'Next paragraph.',
      ]);
    });
  }

  it('records older than the retention period are dropped', () => {
    const net = new Net(encoder());
    const a = net.peer('a', 100);
    a.enterBefore('That is');
    net.flush();
    const map = net.server.getMap('moves');
    expect(map.size).toBe(1);
    const later = new MoveRepair(net.server, { now: () => Date.now() + 31 * 86400000 });
    later.prune();
    expect(map.size).toBe(0);
  });

  it('a paragraph split while another split arrives later: nothing doubled, nothing lost, repeat reconnects change nothing', () => {
    const net = new Net(encoder());
    const a = net.peer('a', 100), b = net.peer('b', 200), c = net.peer('c', 300);
    net.offline(b); net.offline(c);
    a.enterBefore('That is');
    a.typeBefore('That is', 'AAA ');
    b.typeBefore('the output', 'BBB ');
    c.enterBefore('where');
    c.typeBefore('where', 'CCC ');
    net.flush();
    net.online(b);
    net.flush();
    net.online(c);
    const t = net.converged();
    for (const s of ['AAA', 'BBB', 'CCC', 'That is', 'the output', 'where', 'is the function']) once(t, s);
    // reconnecting again (the same updates once more) changes nothing
    net.offline(b); net.offline(c);
    net.online(b); net.online(c);
    expect(net.converged()).toEqual(t);
    absent(t, 'undefined');
  });
});

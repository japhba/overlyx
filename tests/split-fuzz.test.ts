// @vitest-environment happy-dom
/**
 * Randomized splits, joins, typing and deletions on two or three editors that go offline and come
 * back in random orders, through the server's repair (server/moves.ts). Every word is unique, so
 * the invariants are exact: the editors converge; every word typed and not deleted is there once,
 * every deleted one is gone; and the words any editor showed at any time keep their order.
 *
 * A run is a script of steps ("b Enter before w016", "a offline", …): a failing seed can be
 * replayed and shrunk to the steps that matter (OVERLYX_FUZZ_DEBUG=<seed>).
 */
import { describe, expect, it } from 'vitest';
import { TextSelection } from 'prosemirror-state';
import { joinBackward } from 'prosemirror-commands';
import { Net, Peer, par, text, math, dumpDoc, type Json } from './yjs-net';

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

const words = (n: number, from: number) => Array.from({ length: n }, (_, i) => `w${String(from + i).padStart(3, '0')}`).join(' ');
const WORD = /^(w\d{3}|T[a-c]\d+)$/;

function baseDoc(): Json {
  return {
    type: 'doc', content: [
      // every paragraph ends with a space: a join keeps the words apart
      par(text(words(6, 1) + ' '), math('a+b'), text(' ' + words(8, 7) + ' '), math('c'), text(' ' + words(5, 15) + ' ')),
      par(text(words(10, 20) + ' ')),
      par(text(words(4, 30) + ' '), math('x^2'), text(' ' + words(4, 34) + ' ')),
    ],
  };
}

/** text positions right before a word (start of a text node, or after a space); `first`: at the start of its paragraph */
function wordStarts(p: Peer): { pos: number; word: string; first: boolean }[] {
  const out: { pos: number; word: string; first: boolean }[] = [];
  p.view.state.doc.forEach((block, offset) => {
    let first = true;
    block.forEach((n, pos) => {
      if (!n.isText) { first = false; return; }
      const t = n.text!;
      for (let i = 0; i < t.length; i++) {
        if ((i === 0 || t[i - 1] === ' ') && t[i] !== ' ') out.push({ pos: offset + 1 + pos + i, word: /^\S+/.exec(t.slice(i))![0], first: first && i === 0 });
      }
      first = false;
    });
  });
  return out;
}

const allWords = (pars: string[]) => pars.join(' ').split(/[\s$]+/).filter(w => WORD.test(w));

/** one step of a script on the network; false when it does not apply (any more) */
function step(net: Net, ps: Peer[], line: string): boolean {
  const [name, verb, ...rest] = line.replace(/^end: /, '').split(' ');
  if (name === 'flush') { net.flush(); return true; }
  const p = ps.find(q => q.name === name);
  if (!p) return false;
  const at = (word: string) => wordStarts(p).find(w => w.word === word);
  switch (verb) {
    case 'offline': if (!p.online) return false; net.offline(p); return true;
    case 'online': if (p.online) return false; net.online(p, rest[0] as 'peer-first' | 'server-first'); return true;
    case 'sends': if (!p.online) return false; net.send(p); return true;
    case 'receives': if (!p.online) return false; net.receive(p); return true;
    case 'types': { const w = at(rest[2]); if (!w) return false; p.type(rest[0] + ' ', w.pos); return true; }
    case 'Enter': { const w = at(rest[1]); if (!w || w.pos <= 1) return false; p.enter(w.pos); return true; }
    case 'joins': {
      const w = at(rest[1]);
      if (!w || !w.first || w.pos <= 1) return false;
      p.select(w.pos);
      return joinBackward(p.view.state, p.view.dispatch);
    }
    case 'deletes': {
      const w = at(rest[0]);
      if (!w) return false;
      const t = p.view.state.doc.textBetween(w.pos, Math.min(w.pos + w.word.length + 1, p.view.state.doc.content.size));
      if (t !== w.word + ' ') return false;
      // selected and deleted, as a user would (the cursor where the deletion was)
      p.select(w.pos, w.pos + w.word.length + 1);
      p.view.dispatch(p.view.state.tr.deleteSelection());
      return true;
    }
  }
  return false;
}

/** a random script of `steps` steps for `peers` editors (made while running it) */
export function generate(seed: number, steps: number, peers: number, opts: { joins?: boolean } = {}): string[] {
  const r = rng(seed);
  const pick = <T>(a: T[]) => a[Math.floor(r() * a.length)];
  const net = new Net(baseDoc());
  const ps = ['a', 'b', 'c'].slice(0, peers).map((n, i) => net.peer(n, 100 * (i + 1)));
  const counter = new Map<Peer, number>();
  const log: string[] = [];
  for (let i = 0; i < steps; i++) {
    const p = pick(ps);
    const roll = r();
    let line: string | null = null;
    if (roll < 0.12) line = p.online ? `${p.name} offline` : `${p.name} online ${r() < 0.5 ? 'peer-first' : 'server-first'}`;
    else if (roll < 0.45) {
      const n = (counter.get(p) ?? 0) + 1;
      counter.set(p, n);
      line = `${p.name} types T${p.name}${n} before ${pick(wordStarts(p)).word}`;
    } else if (roll < 0.62) { const w = pick(wordStarts(p).filter(x => x.pos > 1)); if (w) line = `${p.name} Enter before ${w.word}`; }
    else if (roll < 0.7) { if (opts.joins !== false) { const w = pick(wordStarts(p).filter(x => x.first && x.pos > 1)); if (w) line = `${p.name} joins before ${w.word}`; } }
    else if (roll < 0.8) { const w = pick(wordStarts(p).filter(x => WORD.test(x.word))); if (w) line = `${p.name} deletes ${w.word}`; }
    else if (roll < 0.9) line = 'flush';
    else line = `${p.name} ${r() < 0.5 ? 'sends' : 'receives'}`;
    if (line && step(net, ps, line)) log.push(line);
    p.view.dispatch(p.view.state.tr.setSelection(TextSelection.atStart(p.view.state.doc)));
  }
  for (const p of ps) if (!p.online) log.push(`end: ${p.name} online ${r() < 0.5 ? 'peer-first' : 'server-first'}`);
  return log;
}

/** run a script; the problems found (none: all invariants hold) */
export function replay(script: string[], peers: number, opts: { dumpAt?: number } = {}): { problems: string[]; final: string[] } {
  // OVERLYX_FUZZ_REPAIR=0: the server applies updates as they are (the behaviour before moves.ts)
  const net = new Net(baseDoc(), { repair: process.env.OVERLYX_FUZZ_REPAIR !== '0' });
  const ps = ['a', 'b', 'c'].slice(0, peers).map((n, i) => net.peer(n, 100 * (i + 1)));
  const base = allWords(net.converged());
  const typed = new Set<string>(), deleted = new Set<string>();
  const views: string[][] = [];
  const dump = (what: string) => { console.log('--- server', what); dumpDoc(net.server); for (const p of ps) { console.log('---', p.name, p.online ? 'online' : 'offline', JSON.stringify(p.pars())); dumpDoc(p.ydoc); } };
  script.forEach((line, i) => {
    if (i === opts.dumpAt) dump(`before ${i}: ${line}`);
    if (!step(net, ps, line)) return;
    const m = /^\S+ types (\S+)/.exec(line); if (m) typed.add(m[1]);
    const d = /^\S+ deletes (\S+)/.exec(line); if (d) deleted.add(d[1]);
    // what its author saw when acting (a view between a sync message and the repair that follows it is passing)
    const actor = ps.find(q => line.startsWith(q.name + ' '));
    if (actor && actor.inbox.length === 0 && / (types|Enter|joins|deletes) /.test(line)) views.push(allWords(actor.pars()));
    for (const q of ps) q.view.dispatch(q.view.state.tr.setSelection(TextSelection.atStart(q.view.state.doc)));
  });
  for (const p of ps) if (!p.online) net.online(p);
  const final = net.converged();
  if (opts.dumpAt === script.length) dump('at the end');
  const got = allWords(final);
  const counts = new Map<string, number>();
  for (const w of got) counts.set(w, (counts.get(w) ?? 0) + 1);
  const problems: string[] = [];
  for (const w of [...base, ...typed]) {
    const c = counts.get(w) ?? 0;
    if (deleted.has(w)) { if (c) problems.push(`${w} deleted but present ${c}×`); }
    else if (c !== 1) problems.push(`${w} present ${c}×`);
  }
  for (const w of counts.keys()) if (!typed.has(w) && !base.includes(w)) problems.push(`${w} unknown`);
  if (process.env.OVERLYX_FUZZ_ONLY === 'lost') return { problems: problems.filter(p => /present 0×/.test(p)), final };
  if (process.env.OVERLYX_FUZZ_ORDER === '0') return { problems, final };
  // order: what any editor showed keeps its order
  const index = new Map(got.map((w, i) => [w, i]));
  for (const v of views) {
    const seen = v.filter(w => index.has(w));
    for (let i = 1; i < seen.length; i++) if (index.get(seen[i - 1])! > index.get(seen[i])!) { problems.push(`order: ${seen[i - 1]} before ${seen[i]} was shown`); break; }
    if (problems.length > 5) break;
  }
  return { problems, final };
}

const fails = (script: string[], peers: number) => { try { return replay(script, peers).problems.length > 0; } catch { return true; } };

/** the shortest script found (greedily) that still fails */
export function shrink(script: string[], peers: number): string[] {
  let cur = script;
  for (let changed = true; changed;) {
    changed = false;
    for (let i = cur.length - 1; i >= 0; i--) {
      const next = cur.slice(0, i).concat(cur.slice(i + 1));
      if (fails(next, peers)) { cur = next; changed = true; }
    }
  }
  return cur;
}

const STEPS = Number(process.env.OVERLYX_FUZZ_STEPS ?? 40);
const JOINS = process.env.OVERLYX_FUZZ_JOINS !== '0';

describe.skipIf(!process.env.OVERLYX_FUZZ_DEBUG)('one seed, shrunk', () => {
  it('replays it', () => {
    const seed = Number(process.env.OVERLYX_FUZZ_DEBUG), peers = seed > 1000 ? 3 : 2;
    const script = generate(seed, seed > 1000 ? STEPS + 10 : STEPS, peers, { joins: JOINS });
    const small = process.env.OVERLYX_FUZZ_SHRINK === '0' ? script : shrink(script, peers);
    const dumpAt = process.env.OVERLYX_FUZZ_DUMP === undefined ? undefined : process.env.OVERLYX_FUZZ_DUMP === 'end' ? small.length : Number(process.env.OVERLYX_FUZZ_DUMP);
    console.log(small.map((l, i) => `${i}: ${l}`).join('\n'));
    const { problems, final } = replay(small, peers, { dumpAt });
    console.log(problems, JSON.stringify(final, null, 1));
  }, 600000);
});

describe.skipIf(!!process.env.OVERLYX_FUZZ_DEBUG)('randomized splits and joins with offline editors', () => {
  const seeds = Number(process.env.OVERLYX_FUZZ_SEEDS ?? 150);
  for (const [peers, from, count, steps] of [[2, 1, seeds, STEPS], [3, 1001, Math.ceil(seeds / 2), STEPS + 10]] as const) {
    it(`${count} seeds, ${peers} editors`, () => {
      const failures: string[] = [];
      for (let seed = from; seed < from + count; seed++) {
        const script = generate(seed, steps, peers, { joins: JOINS });
        let res: { problems: string[]; final: string[] };
        try { res = replay(script, peers); } catch (e) { res = { problems: [String(e)], final: [] }; }
        if (res.problems.length) failures.push(`seed ${seed}: ${res.problems.join('; ')}`);
      }
      if (process.env.OVERLYX_FUZZ_LIST) {
        console.log('failing:', failures.map(f => f.split(':')[0].slice(5)).join(' '));
        const kinds = { lost: 0, doubled: 0, undeleted: 0, order: 0 };
        for (const f of failures) {
          if (/present 0×/.test(f)) kinds.lost++;
          if (/present [2-9]×/.test(f)) kinds.doubled++;
          if (/deleted but present/.test(f)) kinds.undeleted++;
          if (/order:/.test(f)) kinds.order++;
        }
        console.log('kinds:', JSON.stringify(kinds));
      }
      expect(failures.slice(0, 5).join('\n'), `${failures.length} of ${count} seeds failed`).toBe('');
    }, 600000);
  }
});

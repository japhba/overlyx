/**
 * Navigation history (packages/client/src/app/navhistory.ts): which cursor moves become entries,
 * Back / Forward, arrival at a restored place, coalescing while a document opens.
 */
import { describe, it, expect } from 'vitest';
import { NavHistory, JUMP_DISTANCE } from '../packages/client/src/app/navhistory.ts';

const at = (pos: number) => ({ pos, ctx: 'text before ' + pos });
const A = 'p/main.tex', B = 'p/appendix.tex';

describe('navigation history', () => {
  it('typing and small moves update the current entry; a far move or an explicit jump adds one', () => {
    const h = new NavHistory();
    h.visit(A, at(10), { now: 1000 });
    expect(h.entries.length).toBe(1);
    h.visit(A, at(15), { now: 1001 });                  // stepping through the text
    h.visit(A, at(20), { now: 1002, docChanged: true }); // typing
    expect(h.entries.length).toBe(1);
    expect(h.current()?.cursor?.pos).toBe(20);
    h.visit(A, at(20 + JUMP_DISTANCE), { now: 1003 });  // a far click
    expect(h.entries.length).toBe(2);
    expect(h.canBack()).toBe(true);
    h.jump(() => h.visit(A, at(20 + JUMP_DISTANCE + 30), { now: 1004 }));   // a cross-reference two lines down
    expect(h.entries.length).toBe(3);
    expect(h.index).toBe(2);
  });

  it('a document being loaded never makes an entry; opening another document does', () => {
    const h = new NavHistory();
    h.visit(A, at(10), { now: 1000 });
    h.visit(B, at(1), { now: 1001, docChanged: true });   // B's content arriving (a child of the combined view, say)
    expect(h.entries.length).toBe(1);
    h.visit(B, at(500), { now: 1002 });                  // the restored cursor in B
    expect(h.entries.map(e => e.docId)).toEqual([A, B]);
    h.visit(B, at(2000), { now: 1500 });                 // ?goto=label, settling within the same second
    expect(h.entries.length).toBe(2);
    expect(h.current()?.cursor?.pos).toBe(2000);
    h.visit(B, at(4000), { now: 5000 });                 // a real jump later
    expect(h.entries.length).toBe(3);
  });

  it('Back and Forward walk the stack, and the arrival does not count as a new jump', () => {
    const h = new NavHistory();
    h.visit(A, at(10), { now: 1 });
    h.jump(() => h.visit(A, at(3000), { now: 2 }));
    h.visit(A, at(3040), { now: 3 });                    // moved a little at the target
    const back = h.back(10);
    expect(back).toEqual({ docId: A, cursor: at(10) });
    expect(h.index).toBe(0);
    h.visit(A, at(10), { now: 11 });                     // the caller placed the cursor there
    expect(h.entries.length).toBe(2);
    expect(h.canForward()).toBe(true);
    const fwd = h.forward(20);
    expect(fwd?.cursor?.pos).toBe(3040);                 // where one was at the target, not where the jump landed
    h.visit(A, at(3040), { now: 21 });
    expect(h.canForward()).toBe(false);
    expect(h.back(30)?.cursor?.pos).toBe(10);
    h.restored();
    h.visit(A, at(12), { now: 31 });                     // a small move after arriving: still the same entry
    expect(h.entries.length).toBe(2);
    // a new jump from here drops the forward entries
    h.jump(() => h.visit(A, at(900), { now: 40 }));
    expect(h.entries.map(e => e.cursor?.pos)).toEqual([12, 900]);
    expect(h.canForward()).toBe(false);
  });

  it('Back into another document: the first cursor there is the arrival, later loading events are ignored', () => {
    const h = new NavHistory();
    h.visit(A, at(100), { now: 1 });
    h.visit(B, at(700), { now: 2 });
    expect(h.back(3)?.docId).toBe(A);
    h.visit(A, at(1), { now: 4, docChanged: true });     // A loads again
    expect(h.entries[0].cursor?.pos).toBe(100);
    h.visit(A, at(100), { now: 5 });                     // the editor put the cursor where it was
    expect(h.index).toBe(0);
    expect(h.entries.length).toBe(2);
    h.visit(A, at(100), { now: 6 });                     // the first-sync visit says the same
    expect(h.entries.length).toBe(2);
    h.visit(A, at(3000), { now: 7 });                    // a far click right after arriving is a jump (no settling after Back)
    expect(h.entries.length).toBe(2);                    // (the forward entry is replaced by it)
    expect(h.entries[1]).toEqual({ docId: A, cursor: at(3000) });
    expect(h.canForward()).toBe(false);
  });

  it('going somewhere else while a restore is on its way cancels the restore', () => {
    const h = new NavHistory();
    h.visit(A, at(100), { now: 1 });
    h.visit(B, at(700), { now: 2 });
    h.visit(A, at(2000), { now: 3 });
    h.back(4);                                           // → B
    h.visit(A, at(50), { now: 5 });                      // but the user clicked in A instead
    expect(h.entries.map(e => e.docId)).toEqual([A, B, A]);
    expect(h.index).toBe(2);
    expect(h.current()?.cursor?.pos).toBe(50);
  });

  it('text-file tabs are entries without a position', () => {
    const h = new NavHistory();
    h.visit(A, at(100), { now: 1 });
    h.visit('text:p/preamble.tex', null, { now: 2 });
    h.visit('text:p/preamble.tex', null, { now: 3 });    // the hash handler fires again: no duplicate
    expect(h.entries.length).toBe(2);
    expect(h.back()?.docId).toBe(A);
  });

  it('keeps at most 100 entries', () => {
    const h = new NavHistory();
    for (let i = 0; i < 150; i++) h.jump(() => h.visit(A, at(i * 10), { now: i }));
    expect(h.entries.length).toBe(100);
    expect(h.index).toBe(99);
    expect(h.current()?.cursor?.pos).toBe(1490);
  });
});

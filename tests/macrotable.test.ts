import { describe, it, expect } from 'vitest';
import { setDocumentMacros, macroTableFor } from '../packages/client/src/editor/lyxmath/macrotable';

const A = {}, B = {}, C = {};

describe('per-view macro tables (open documents must not clobber each other)', () => {
  it('each view keeps its own server macros', () => {
    setDocumentMacros(A, { bh: { def: '\\boldsymbol{h}', args: 0 } });
    setDocumentMacros(B, {});
    expect(macroTableFor(A, undefined).table.bh).toEqual({ nargs: 0, def: '\\boldsymbol{h}' });
    expect(macroTableFor(B, undefined).table.bh).toBeUndefined();
    // applying B's (empty) table did not touch A's — the old single global did exactly that
    expect(macroTableFor(A, undefined).table.bh).toBeTruthy();
  });
  it('merge stacks onto the table applied just before (master, then children)', () => {
    setDocumentMacros(A, { a: { def: 'x', args: 0 } });
    setDocumentMacros(C, { b: { def: 'y', args: 0 } }, true);
    expect(macroTableFor(C, undefined).table.a).toBeTruthy();
    expect(macroTableFor(C, undefined).table.b).toBeTruthy();
    expect(macroTableFor(A, undefined).table.b).toBeUndefined();
  });
  it('fallback macros are present and cache keys differ per view', () => {
    expect(macroTableFor(A, undefined).table.llbracket).toBeTruthy();
    expect(macroTableFor(A, undefined).key).not.toBe(macroTableFor(B, undefined).key);
  });
});

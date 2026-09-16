/**
 * The VS Code extension's update protocol (packages/vscode/src/shared/documentModel.ts): the
 * webview numbers its updates, the host acknowledges the last one it applied with every snapshot,
 * and the webview merges a snapshot against the model of *that* update — never against a newer one
 * still in flight. The bug this pins down: text deleted in the editor came back a moment later when
 * a snapshot the host had computed before the deletion (its re-read after an auto save) arrived.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { lyxToPm } from '@overlyx/core';
import { parseTex } from '../packages/core/src/tex/index.ts';
import { SyncLedger, mergeModels, documentModel, sameModel } from '../packages/vscode/src/shared/documentModel.ts';

const model = (text: string) => { const r = parseTex(text + '\n', { layoutDir: path.resolve('lyx/lib/layouts'), localDirs: [] }); return documentModel(lyxToPm(r.doc), r.doc.header.lines); };

describe('SyncLedger', () => {
  const D0 = model('Alpha beta gamma.'), D1 = model('Alpha gamma.'), D2 = model('Alpha.');

  it('merges a late snapshot against the update it acknowledges, so a newer deletion survives', () => {
    const ledger = new SyncLedger(D0);
    expect(ledger.base).toBe(D0);
    const u1 = ledger.send(D1);            // "beta" deleted; sent with base D0
    expect(ledger.base).toBe(D1);
    const u2 = ledger.send(D2);            // "gamma" deleted; sent with base D1
    expect(ledger.inFlight).toBe(2);
    // the host re-read the file after applying update 1 (an auto save) and pushes that: it reflects u1 only
    const base = ledger.baseFor(u1);
    expect(base).toBe(D1);
    expect(ledger.inFlight).toBe(1);
    const merged = mergeModels(base, D2, D1);
    expect(sameModel(merged, D2)).toBe(true);
    // the old protocol merged against the last model sent — and took the snapshot for the newer state
    expect(sameModel(mergeModels(D2, D2, D1), D1)).toBe(true);
    ledger.applied(D1);
    expect(ledger.base).toBe(D2);          // update 2 is still in flight: the next update is based on it
    // the snapshot for update 2
    expect(ledger.baseFor(u2)).toBe(D2);
    ledger.applied(D2);
    expect(ledger.inFlight).toBe(0);
    expect(ledger.base).toBe(D2);
  });

  it('with nothing in flight, a snapshot becomes the agreed model', () => {
    const ledger = new SyncLedger(D0);
    expect(ledger.baseFor(null)).toBe(D0);
    ledger.applied(D1);
    expect(ledger.base).toBe(D1);
    const u = ledger.send(D2);
    expect(u.seq).toBe(1);
    expect(u.epoch).toBe(ledger.epoch);
  });

  it('acknowledgements from another editor session (a reloaded webview) retire nothing', () => {
    const ledger = new SyncLedger(D0);
    ledger.send(D1);
    expect(ledger.baseFor({ epoch: 'previous-webview', seq: 99 })).toBe(D0);
    expect(ledger.inFlight).toBe(1);
    expect(ledger.baseFor({ epoch: ledger.epoch, seq: 1 })).toBe(D1);
    expect(ledger.inFlight).toBe(0);
  });
});

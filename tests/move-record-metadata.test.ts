import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import * as decoding from 'lib0/decoding';
import { encodeRecord, decodeRecord, type MoveRecord } from '../packages/core/src/moves';

const base = { t: 1, server: false, size: 2, protect: [Y.createID(1, 1)], adopt: ['c200-9'], entries: [1, 2, 2, 1, 200, 6] };
// Captured from the version-1 encoder before joined metadata was introduced.
const legacy = Uint8Array.from([1,1,0,2,2,1,200,1,1,0,1,1,6,99,50,48,48,45,57,1,0,2,2,1,2,6]);
const legacyWithVector = Uint8Array.from([...legacy, 2,1,230,1,7,3]);
const vector = new Map([[1, 230], [7, 3]]);

/** The previous version-1 reader consumes its optional state vector and ignores
 * any later metadata. Keep this independent of the current decodeRecord. */
function readAsLegacy(bytes: Uint8Array): Omit<MoveRecord, 'key' | 'joined'> {
  const dec = decoding.createDecoder(bytes);
  expect(decoding.readVarUint(dec)).toBe(1);
  const t = decoding.readVarUint(dec), server = decoding.readVarUint(dec) === 1, size = decoding.readVarUint(dec);
  const clients = Array.from({ length: decoding.readVarUint(dec) }, () => decoding.readVarUint(dec));
  const protect = Array.from({ length: decoding.readVarUint(dec) }, () => Y.createID(clients[decoding.readVarUint(dec)], decoding.readVarUint(dec)));
  const adopt = Array.from({ length: decoding.readVarUint(dec) }, () => decoding.readVarString(dec));
  const entries: number[] = [];
  for (let n = decoding.readVarUint(dec); n > 0; n--) {
    const source = clients[decoding.readVarUint(dec)], clock = decoding.readVarUint(dec), len = decoding.readVarUint(dec), side = decoding.readVarUint(dec), destination = decoding.readVarUint(dec);
    entries.push(source, clock, len, side, destination ? clients[destination - 1] : -1, destination ? decoding.readVarUint(dec) : 0);
  }
  let sv: Map<number, number> | undefined;
  if (decoding.hasContent(dec)) {
    sv = new Map();
    for (let n = decoding.readVarUint(dec); n > 0; n--) sv.set(decoding.readVarUint(dec), decoding.readVarUint(dec));
  }
  return { t, server, size, protect, adopt, entries, ...(sv ? { sv } : {}) };
}

describe('move record join metadata remains compatible with version 1', () => {
  it('reads old records with absent and known author history', () => {
    expect(decodeRecord('c200-9', legacy)).toEqual({ key: 'c200-9', ...base });
    expect(decodeRecord('c200-9', legacyWithVector)).toEqual({ key: 'c200-9', ...base, sv: vector });
  });

  it('leaves unextended version-1 records byte-for-byte unchanged', () => {
    expect(encodeRecord(base)).toEqual(legacy);
    expect(encodeRecord({ ...base, sv: vector })).toEqual(legacyWithVector);
  });

  for (const joined of [true, false] as const) for (const history of ['absent', 'empty', 'known'] as const) {
    const sv = history === 'absent' ? undefined : history === 'empty' ? new Map<number, number>() : vector;
    it(`preserves explicit ${joined ? 'join' : 'split'} and ${history} author history`, () => {
      const record = { ...base, joined, ...(sv ? { sv } : {}) };
      expect(decodeRecord('c200-9', encodeRecord(record))).toEqual({ key: 'c200-9', ...record });
      // An older reader sees the unchanged move fields and a harmless empty
      // vector envelope when the extended record's history was unknown.
      expect(readAsLegacy(encodeRecord(record))).toEqual({ ...base, sv: sv ?? new Map() });
    });
  }

  it('keeps absent metadata distinct from an explicit split with a genuinely empty vector', () => {
    const oldEmpty = decodeRecord('c200-9', Uint8Array.from([...legacy, 0]))!;
    expect(oldEmpty.sv).toEqual(new Map());
    expect(oldEmpty.joined).toBeUndefined();
    const split = decodeRecord('c200-9', encodeRecord({ ...base, sv: new Map(), joined: false }))!;
    expect(split.sv).toEqual(new Map());
    expect(split.joined).toBe(false);
  });
});

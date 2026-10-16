import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { countRevision, eligible, finish, databaseSignals, privateText, type Signal } from './maintenance.ts';

const signal: Signal = { key: 'issue:7', revision: 'updated-1', kind: 'github-issue', title: 'Delete note', detail: '', priority: 1 };

test('unchanged evidence stays idle; changed evidence reopens a completed investigation', () => {
  const seen = finish(signal, undefined, 'no_fix', 1000);
  assert.equal(eligible(signal, seen, Date.now()), false);
  assert.equal(eligible({ ...signal, revision: 'updated-2' }, seen, 1001), true);
  assert.equal(countRevision(7), countRevision(4));
  const usage = { ...signal, revision: '3' };
  const counted = finish(usage, undefined, 'fixed', 1000);
  assert.equal(eligible({ ...usage, revision: '2' }, counted, 1001), false);
  assert.equal(eligible({ ...usage, revision: '4' }, counted, 1001), true);
});

test('failed runs back off and stop retrying after three attempts until evidence changes', () => {
  let seen = finish(signal, undefined, 'retry', 1000);
  assert.equal(eligible(signal, seen, 1001), false);
  assert.equal(eligible(signal, seen, seen.nextAt), true);
  seen = finish(signal, seen, 'retry', seen.nextAt);
  seen = finish(signal, seen, 'retry', seen.nextAt);
  assert.equal(eligible(signal, seen, seen.nextAt), false);
  assert.equal(eligible({ ...signal, revision: 'updated-2' }, seen, seen.nextAt), true);
});

test('screening reads reports without accounts, omits mail and strips credentials', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE reports (id INTEGER, kind TEXT, title TEXT, body TEXT, count INTEGER, version TEXT, last_at INTEGER, user_id INTEGER);
    CREATE TABLE usage_events (id INTEGER, session TEXT, at INTEGER, name TEXT, detail TEXT, ok INTEGER, place TEXT, dt INTEGER, version TEXT);
    INSERT INTO reports VALUES (1, 'feedback', 'Note cannot be deleted', 'contact someone@example.test token=private-credential', 1, 'abc123', 1000, 999);
    INSERT INTO reports VALUES (2, 'mail', 'Private mail', 'Personal correspondence', 1, 'abc123', 1000, 999);`);
  try {
    const signals = databaseSignals(db, 0);
    assert.equal(signals.length, 1);
    assert.equal(signals[0].kind, 'feedback');
    const text = JSON.stringify(signals);
    assert.doesNotMatch(text, /someone@|private-credential|Personal correspondence|user_id|999/);
    assert.match(text, /Note cannot be deleted/);
    assert.equal(privateText('Bearer sk-abcdefghijklmno'), '[credential]');
  } finally { db.close(); }
});

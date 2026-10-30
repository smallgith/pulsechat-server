import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionStore } from '../sessions.js';
import { createHash } from 'node:crypto';

test('sessions last at least 31 days, renew with activity and survive serialization/restart', () => {
  let now = 1000000000,
    saves = 0;
  const day = 86400000;
  const db = { accounts: { alice: {} }, sessions: {} };
  const options = { now: () => now, days: 1 };
  const store = sessionStore(
    db,
    () => {
      saves++;
    },
    options
  );
  const token = store.create('alice');
  assert.equal(store.expires(token) - now, 31 * day);
  assert.equal(Object.keys(db.sessions)[0], createHash('sha256').update(token).digest('hex'));
  for (let i = 0; i < 100; i++) assert.equal(store.user(token), 'alice');
  assert.equal(saves, 1);
  now += 29 * day;
  assert.equal(store.user(token), 'alice');
  assert.equal(store.expires(token) - now, 31 * day);
  const restored = JSON.parse(JSON.stringify(db));
  const restarted = sessionStore(restored, () => {}, options);
  now += 30 * day;
  assert.equal(restarted.user(token), 'alice');
  now += 32 * day;
  assert.equal(restarted.user(token), null);
  assert.equal(restarted.user('forged-token'), null);
});

test('logout revocation and deleted accounts do not get renewed', () => {
  const db = { accounts: { alice: {} }, sessions: {} };
  const store = sessionStore(db, () => {});
  const token = store.create('alice');
  delete db.accounts.alice;
  assert.equal(store.user(token), null);
  db.accounts.alice = {};
  db.sessions = {};
  assert.equal(store.user(token), null);
});

test('a temporary renewal write failure preserves the existing valid login', () => {
  let now = 1000000000,
    fail = false;
  const db = { accounts: { alice: {} }, sessions: {} };
  const store = sessionStore(
    db,
    () => {
      if (fail) throw new Error('Disk temporarily busy');
    },
    { now: () => now }
  );
  const token = store.create('alice'),
    originalExpiry = store.expires(token);
  now += 2 * 86400000;
  fail = true;
  assert.equal(store.user(token), 'alice');
  assert.equal(store.expires(token), originalExpiry);
  fail = false;
  assert.equal(store.user(token), 'alice');
  assert.ok(store.expires(token) > originalExpiry);
});

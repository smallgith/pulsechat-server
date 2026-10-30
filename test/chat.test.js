import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';
import { googleCredential, testGoogleClientId } from './support/google-fixture.js';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = mkdtempSync(path.join(tmpdir(), 'pulsechat-test-'));
const port = 15840 + Math.floor(Math.random() * 1000), url = `http://127.0.0.1:${port}`;
let server, output = '';
const sockets = [];
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function start() {
  output = '';
  server = spawn(process.execPath, ['--import', './test/support/google-provider.js', 'index.js'], { cwd: root, env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, GOOGLE_CLIENT_ID: testGoogleClientId, CLIENT_URL: '*', FOUNDER_PHONE: '9000000099', FOUNDER_NAME: 'Test founder', CLOUDINARY_CLOUD_NAME: '', CLOUDINARY_API_KEY: '', CLOUDINARY_API_SECRET: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (d) => { output += d; }); server.stderr.on('data', (d) => { output += d; });
  for (let i = 0; i < 300; i++) { try { if ((await fetch(`${url}/api/health`)).ok) return; } catch {} if (server.exitCode !== null) break; await delay(50); }
  throw new Error(`Server did not start: ${output}`);
}
async function stop() { if (!server || server.exitCode !== null) return; const ended = new Promise((r) => server.once('exit', r)); server.kill(); await ended; }
const api = async (route, body, token) => {
  const response = await fetch(`${url}/api/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: response.status, ...(await response.json()) };
};
const emit = (s, name, payload) => new Promise((resolve, reject) => s.timeout(3000).emit(name, payload, (err, res) => err ? reject(err) : resolve(res)));
async function connect(token, name) {
  const s = io(url, { transports: ['websocket'], reconnection: false }); sockets.push(s);
  await new Promise((resolve, reject) => { s.once('connect', resolve); s.once('connect_error', reject); });
  const result = await emit(s, 'register', { token, name });
  return { s, ...result };
}
async function login(phone, name) {
  const auth = await api('auth/google', { credential: googleCredential(phone, name) }); assert.ok(auth.token);
  assert.ok(auth.expiresAt >= Date.now() + 31 * 86400000);
  return { token: auth.token, phone: auth.user.phone, ...(await connect(auth.token, name)) };
}
const legacyPhone = '9000000044', legacyToken = 'previous-version-session-token';
before(async () => {
  writeFileSync(path.join(dataDir, 'chat.json'), JSON.stringify({
    accounts: { [legacyPhone]: { phone: legacyPhone, name: 'Legacy user', joinedAt: Date.now() } },
    sessions: { [createHash('sha256').update(legacyToken).digest('hex')]: {
      phone: legacyPhone, expires: Date.now() + 30 * 86400000,
    } },
  }));
  await start();
});
after(async () => { sockets.forEach((s) => s.disconnect()); await stop(); if (!path.resolve(dataDir).startsWith(path.join(tmpdir(), 'pulsechat-test-'))) throw new Error('Unsafe temporary directory'); rmSync(dataDir, { recursive: true, force: true }); });

test('real-time messaging, permissions, groups, calls and persistence', async (t) => {
  const a = await login('9000000001', 'Aarav'), b = await login('9000000002', 'Bela'), c = await login('9000000003', 'Chirag');
  let message, group;
  const rid = [a.phone, b.phone].sort().join('::');
  await t.test('Google sessions are required, SMS is removed and founder is configured', async () => {
    const unauth = await connect('forged-token'); assert.equal(unauth.ok, false);
    assert.equal((await api('send-otp', { phone: '9000000044' })).status, 410);
    assert.equal((await api('verify-otp', { phone: '9000000044', otp: '111111' })).status, 410);
    assert.equal((await api('auth/google', { credential: 'forged' })).status, 401);
    assert.ok(a.users.some((u) => u.isFounder && u.name === 'Test founder'));
    const malformed = io(url, { reconnection: false }); sockets.push(malformed);
    await new Promise((resolve) => malformed.once('connect', resolve)); malformed.emit('register', null, 'not-an-ack');
    assert.equal((await fetch(`${url}/api/health`)).status, 200);
  });
  await t.test('live message, delivery, deduplication and explicit read receipts', async () => {
    const received = new Promise((r) => b.s.once('message', r));
    const payload = { to: b.phone, text: 'Hello Bela', clientId: 'one' };
    const res = await emit(a.s, 'send_message', payload); message = res.message;
    assert.equal((await received).id, message.id); assert.equal(message.status, 'delivered');
    assert.equal((await emit(a.s, 'send_message', payload)).message.id, message.id);
    await emit(b.s, 'seen', { roomId: rid, ids: [message.id] });
    const history = await emit(a.s, 'get_history', { with: b.phone });
    assert.equal(history.messages.length, 1); assert.equal(history.messages[0].status, 'seen');
    assert.equal((await emit(c.s, 'seen', { roomId: rid, ids: [message.id] })).ok, false);
  });
  await t.test('legacy accounts explicitly link Google and reset PINs through the same verified identity', async () => {
    const credential = googleCredential('legacy-google-identity', 'Legacy user');
    assert.equal((await api('auth/google/link', { credential }, legacyToken)).status, 200);
    const linked = await api('auth/google', { credential });
    assert.equal(linked.user.phone, legacyPhone);
    assert.equal((await api('lock-reset', { googleCredential: credential }, linked.token)).status, 200);
    assert.equal((await api('lock-reset', { googleCredential: googleCredential('another-identity') }, linked.token)).status, 403);
    const session = await fetch(`${url}/api/session`, { headers: { Authorization: `Bearer ${linked.token}` } });
    assert.equal(session.status, 200);
    assert.ok((await session.json()).expiresAt > Date.now() + 31 * 86400000);
  });
  await t.test('edit/reply/react/forward and owner authorization', async () => {
    assert.equal((await emit(b.s, 'edit_message', { roomId: rid, messageId: message.id, text: 'forged' })).ok, false);
    assert.equal((await emit(c.s, 'delete_message', { roomId: rid, messageId: message.id, forEveryone: false })).ok, false);
    assert.equal((await emit(c.s, 'react_message', { roomId: rid, messageId: message.id, emoji: '👍' })).ok, false);
    await emit(a.s, 'edit_message', { roomId: rid, messageId: message.id, text: 'Hello, edited' });
    await emit(b.s, 'react_message', { roomId: rid, messageId: message.id, emoji: '❤️' });
    await emit(b.s, 'react_message', { roomId: rid, messageId: message.id, emoji: '👍' });
    const h = await emit(a.s, 'get_history', { with: b.phone });
    assert.equal(h.messages[0].text, 'Hello, edited'); assert.ok(h.messages[0].editedAt); assert.deepEqual(h.messages[0].reactions, { '👍': [b.phone] });
    const reply = await emit(b.s, 'send_message', { to: a.phone, text: 'Reply', replyTo: { id: message.id, fromName: 'forged' } });
    assert.equal(reply.message.replyTo.fromName, 'Aarav');
    const forward = await emit(a.s, 'send_message', { to: c.phone, text: h.messages[0].text, forwarded: true }); assert.equal(forward.message.forwarded, true);
  });
  await t.test('offline contacts, queued delivery, notes, personal preferences and block', async () => {
    b.s.disconnect(); await delay(100);
    const offline = await emit(a.s, 'send_message', { to: b.phone, text: 'For later' }); assert.equal(offline.message.status, 'sent');
    const rejoined = await connect(b.token); b.s = rejoined.s;
    assert.equal(rejoined.conversations[rid].find((m) => m.id === offline.message.id).status, 'delivered');
    assert.ok(rejoined.users.find((u) => u.phone === a.phone));
    assert.equal((await emit(a.s, 'send_message', { to: a.phone, text: 'Private note' })).message.status, 'seen');
    for (const key of ['pinned', 'archived', 'favorites', 'muted', 'starred']) assert.equal((await emit(a.s, 'preferences', { key, value: key === 'starred' ? message.id : b.phone, enabled: true })).ok, true);
    await emit(b.s, 'preferences', { key: 'blocked', value: a.phone, enabled: true });
    assert.equal((await emit(a.s, 'send_message', { to: b.phone, text: 'Blocked' })).ok, false);
    await emit(b.s, 'preferences', { key: 'blocked', value: a.phone, enabled: false });
  });
  await t.test('group creation, live delivery, admin changes and revoked access', async () => {
    group = (await emit(a.s, 'create_group', { name: 'Project team', description: 'Working group', members: [b.phone] })).group;
    assert.equal(group.members.length, 2);
    assert.equal((await emit(c.s, 'get_history', { with: group.id })).ok, false);
    assert.equal((await emit(b.s, 'update_group', { id: group.id, action: 'add', phone: c.phone })).ok, false);
    await emit(a.s, 'update_group', { id: group.id, action: 'add', phone: c.phone });
    const received = new Promise((r) => c.s.once('message', r));
    await emit(b.s, 'send_message', { to: group.id, text: 'Hello team' }); assert.equal((await received).roomId, group.id);
    await emit(a.s, 'update_group', { id: group.id, action: 'admin', phone: b.phone });
    assert.equal((await emit(b.s, 'update_group', { id: group.id, action: 'details', name: 'Renamed team', description: 'Updated' })).ok, true);
    await emit(a.s, 'update_group', { id: group.id, action: 'remove', phone: c.phone });
    assert.equal((await emit(c.s, 'send_message', { to: group.id, text: 'Intrusion' })).ok, false);
    assert.equal((await emit(c.s, 'get_history', { with: group.id })).ok, false);
  });
  await t.test('24-hour status with real view count and owner-only deletion', async () => {
    const update = new Promise((r) => b.s.once('statuses', r));
    await emit(a.s, 'post_status', { text: 'Building something useful', color: '#4338ca' });
    const status = (await update).find((s) => s.from === a.phone); assert.ok(status.expiresAt > Date.now());
    const view = new Promise((r) => a.s.once('statuses', r)); b.s.emit('view_status', { id: status.id });
    assert.deepEqual((await view).find((s) => s.id === status.id).viewedBy, [b.phone]);
    assert.equal((await emit(b.s, 'delete_status', { id: status.id })).ok, false);
    assert.equal((await emit(a.s, 'delete_status', { id: status.id })).ok, true);
  });
  await t.test('authenticated uploads work without a cloud provider', async () => {
    const makeForm = () => { const form = new FormData(); form.append('file', new Blob(['Hello file'], { type: 'text/plain' }), 'hello.txt'); return form; };
    assert.equal((await fetch(`${url}/api/upload`, { method: 'POST', body: makeForm() })).status, 401);
    const response = await fetch(`${url}/api/upload`, { method: 'POST', headers: { Authorization: `Bearer ${a.token}` }, body: makeForm() });
    const file = await response.json(); assert.ok(file.url); const download = await fetch(file.url);
    assert.equal(await download.text(), 'Hello file'); assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
    assert.match(download.headers.get('content-disposition'), /attachment/);
    assert.equal((await emit(a.s, 'send_message', { to: b.phone, file })).ok, true);
    assert.equal((await emit(a.s, 'send_message', { to: b.phone, file: { url: 'javascript:alert(1)' } })).ok, false);
  });
  await t.test('call signaling, busy/offline validation, scoped end and history', async () => {
    const incoming = new Promise((r) => b.s.once('incoming_call', r));
    const call = { to: b.phone, callId: 'test-call', type: 'audio', offer: { type: 'offer', sdp: 'test-offer' } };
    assert.equal((await emit(a.s, 'call_user', call)).ok, true); assert.equal((await incoming).from, a.phone);
    assert.equal((await emit(c.s, 'call_end', { callId: call.callId })).ok, false);
    assert.equal((await emit(c.s, 'call_user', { ...call, callId: 'busy-call' })).ok, false);
    const answer = new Promise((r) => a.s.once('call_answer', r));
    await emit(b.s, 'call_answer', { callId: call.callId, answer: { type: 'answer', sdp: 'test-answer' } }); assert.equal((await answer).answer.sdp, 'test-answer');
    const logs = new Promise((r) => a.s.once('calls', r)); await emit(a.s, 'call_end', { callId: call.callId }); assert.equal((await logs)[0].status, 'completed');
    assert.equal((await emit(a.s, 'call_user', { ...call, to: '9000000099', callId: 'offline-call' })).ok, true);
    assert.equal((await emit(a.s, 'call_end', { callId: 'offline-call' })).ok, true);
  });
  await t.test('delete for me is private and delete for everyone removes content', async () => {
    await emit(b.s, 'delete_message', { roomId: rid, messageId: message.id, forEveryone: false });
    assert.ok(!(await emit(b.s, 'get_history', { with: a.phone })).messages.some((m) => m.id === message.id));
    assert.ok((await emit(a.s, 'get_history', { with: b.phone })).messages.some((m) => m.id === message.id));
    await emit(a.s, 'delete_message', { roomId: rid, messageId: message.id, forEveryone: true });
    const deleted = (await emit(a.s, 'get_history', { with: b.phone })).messages.find((m) => m.id === message.id);
    assert.equal(deleted.deleted, true); assert.equal(deleted.text, '');
  });
  await t.test('restart preserves authenticated sessions, messages, groups and preferences; timers expire', async () => {
    await emit(a.s, 'profile', { name: 'Updated Aarav', about: 'Testing profile sync' });
    const stale = await connect(a.token, 'Old cached name'); assert.equal(stale.user.name, 'Updated Aarav'); stale.s.disconnect();
    await emit(a.s, 'disappearing', { to: b.phone, duration: 86400000 });
    const expiring = (await emit(a.s, 'send_message', { to: b.phone, text: 'Expires' })).message; assert.ok(expiring.expiresAt);
    sockets.forEach((s) => s.disconnect()); await delay(100); await stop();
    const file = path.join(dataDir, 'chat.json'), stored = JSON.parse(readFileSync(file, 'utf8'));
    stored.history[rid].find((m) => m.id === expiring.id).expiresAt = Date.now() - 1000; writeFileSync(file, JSON.stringify(stored));
    await start(); const restored = await connect(a.token);
    assert.equal(restored.ok, true); assert.ok(restored.groups.some((g) => g.name === 'Renamed team'));
    assert.ok(restored.preferences.pinned.includes(b.phone)); assert.ok(restored.conversations[rid].length > 0);
    assert.ok(!restored.conversations[rid].some((m) => m.id === expiring.id));
    assert.equal((await api('logout', {}, a.token)).ok, true); assert.equal((await connect(a.token)).ok, false);
  });
});

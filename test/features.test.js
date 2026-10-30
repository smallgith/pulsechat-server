import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { io } from 'socket.io-client';
import { googleCredential, testGoogleClientId } from './support/google-fixture.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(tmpdir(), 'pulsechat-features-'));
const port = 18000 + Math.floor(Math.random() * 1000),
  base = `http://127.0.0.1:${port}`;
let server,
  logs = '',
  a,
  b,
  c;
const sockets = [];
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (s, event, data) =>
  new Promise((resolve, reject) =>
    s.timeout(5000).emit(event, data, (error, result) => (error ? reject(error) : resolve(result)))
  );
const hash = (data) => createHash('sha256').update(data).digest('hex');
async function api(route, token, body, method = 'POST', headers = {}) {
  const response = await fetch(`${base}/api/${route}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json',
      ...headers,
    },
    body: body == null ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });
  return { status: response.status, ...(await response.json()) };
}
async function start() {
  logs = '';
  server = spawn(process.execPath, ['--import', './test/support/google-provider.js', 'index.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dir,
      PUBLIC_SERVER_URL: base,
      GOOGLE_CLIENT_ID: testGoogleClientId,
      CLIENT_URL: '*',
      FOUNDER_PHONE: '9880000099',
      FOUNDER_EMAIL: '9880000099@example.test',
      MAX_UPLOAD_MB: '2048',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (v) => {
    logs += v;
  });
  server.stderr.on('data', (v) => {
    logs += v;
  });
  for (let i = 0; i < 300; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {}
    await delay(50);
  }
  throw new Error(logs);
}
async function stop() {
  if (server.exitCode !== null) return;
  const exit = new Promise((r) => server.once('exit', r));
  server.kill();
  await exit;
}
async function reconnect(user) {
  const s = io(base, { transports: ['websocket'], reconnection: false });
  sockets.push(s);
  await new Promise((resolve, reject) => {
    s.once('connect', resolve);
    s.once('connect_error', reject);
  });
  const state = await emit(s, 'register', { token: user.token, name: user.name });
  assert.equal(state.ok, true);
  s.owner = user.phone;
  user.s = s;
  return state;
}
async function login(phone, name) {
  const auth = await api('auth/google', null, { credential: googleCredential(phone, name) });
  const user = { phone: auth.user.phone, name, token: auth.token };
  await reconnect(user);
  return user;
}
before(async () => {
  await start();
  a = await login('9880000001', 'Alice');
  b = await login('9880000002', 'Bob');
  c = await login('9880000003', 'Cara');
});
after(async () => {
  sockets.forEach((s) => s.disconnect());
  await stop();
  assert.ok(path.resolve(dir).startsWith(path.join(tmpdir(), 'pulsechat-features-')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('large verified transfers resume across restarts and reject corruption/other owners', async () => {
  const size = 27 * 1024 ** 2 + 17;
  const init = await api('uploads', a.token, {
    name: 'large-project.zip',
    mime: 'application/zip',
    size,
    fingerprint: 'test-content-v1',
  });
  assert.equal(init.status, 201);
  assert.equal(init.chunkSize, 4 * 1024 ** 2);
  assert.equal((await api(`uploads/${init.id}`, b.token, null, 'GET')).status, 404);
  const chunk = Buffer.alloc(init.chunkSize, 7);
  assert.equal(
    (
      await api(`uploads/${init.id}`, a.token, chunk, 'PATCH', {
        'Upload-Offset': '0',
        'Upload-Checksum': '0'.repeat(64),
      })
    ).status,
    422
  );
  const first = await api(`uploads/${init.id}`, a.token, chunk, 'PATCH', {
    'Upload-Offset': '0',
    'Upload-Checksum': hash(chunk),
  });
  assert.equal(first.offset, chunk.length);
  assert.equal(
    (
      await api(`uploads/${init.id}`, a.token, chunk, 'PATCH', {
        'Upload-Offset': '0',
        'Upload-Checksum': hash(chunk),
      })
    ).status,
    409
  );
  assert.equal((await api(`uploads/${init.id}/complete`, a.token, {})).status, 409);
  sockets.forEach((s) => s.disconnect());
  await stop();
  await start();
  await reconnect(a);
  await reconnect(b);
  await reconnect(c);
  const resumed = await api('uploads', a.token, {
    name: 'large-project.zip',
    mime: 'application/zip',
    size,
    fingerprint: 'test-content-v1',
  });
  assert.equal(resumed.id, init.id);
  assert.equal(resumed.offset, chunk.length);
  for (let offset = resumed.offset; offset < size;) {
    const data = Buffer.alloc(Math.min(init.chunkSize, size - offset), 7);
    const part = await api(`uploads/${init.id}`, a.token, data, 'PATCH', {
      'Upload-Offset': String(offset),
      'Upload-Checksum': hash(data),
    });
    assert.equal(part.status, 200);
    offset = part.offset;
  }
  const file = await api(`uploads/${init.id}/complete`, a.token, {});
  assert.equal(file.size, size);
  assert.equal((await api(`uploads/${init.id}/complete`, a.token, {})).url, file.url);
  const pendingMeta = path.join(dir, 'transfers', `${init.id}.json`);
  const interrupted = JSON.parse(fs.readFileSync(pendingMeta, 'utf8'));
  interrupted.completed = false;
  fs.writeFileSync(pendingMeta, JSON.stringify(interrupted));
  fs.unlinkSync(path.join(dir, 'uploads', `${init.id}.json`));
  const recovered = await api(`uploads/${init.id}/complete`, a.token, {});
  assert.equal(recovered.url, file.url);
  const download = await fetch(file.url);
  assert.equal(Number(download.headers.get('content-length')), size);
  assert.equal(hash(Buffer.from(await download.arrayBuffer())), hash(Buffer.alloc(size, 7)));
  const range = await fetch(file.url, { headers: { Range: 'bytes=0-15' } });
  assert.equal(range.status, 206);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), Buffer.alloc(16, 7));
  assert.equal((await emit(a.s, 'send_message', { to: b.phone, file })).ok, true);
  const cancelled = await api('uploads', a.token, {
    name: 'cancel.txt',
    mime: 'text/plain',
    size: 1024,
    fingerprint: 'cancel',
  });
  assert.equal((await api(`uploads/${cancelled.id}`, a.token, null, 'DELETE')).ok, true);
  assert.equal((await api(`uploads/${cancelled.id}`, a.token, null, 'GET')).status, 404);
  assert.equal(
    (await api('uploads', a.token, { name: 'too-big', size: 3 * 1024 ** 3, fingerprint: 'large' }))
      .status,
    400
  );
});

test('poll votes, task workflow, decisions, contacts, stickers and event RSVPs persist', async () => {
  const rid = [a.phone, b.phone].sort().join('::');
  const poll = (
    await emit(a.s, 'send_message', {
      to: b.phone,
      poll: { question: 'Release day?', options: ['Friday', 'Monday'] },
    })
  ).message;
  assert.ok(poll.poll);
  assert.equal(
    (
      await emit(c.s, 'message_action', {
        roomId: rid,
        messageId: poll.id,
        action: 'vote',
        optionId: poll.poll.options[0].id,
      })
    ).ok,
    false
  );
  await emit(b.s, 'message_action', {
    roomId: rid,
    messageId: poll.id,
    action: 'vote',
    optionId: poll.poll.options[0].id,
  });
  await emit(b.s, 'message_action', {
    roomId: rid,
    messageId: poll.id,
    action: 'vote',
    optionId: poll.poll.options[1].id,
  });
  let history = (await emit(a.s, 'get_history', { with: b.phone })).messages;
  assert.deepEqual(
    history.find((m) => m.id === poll.id).poll.options.map((o) => o.voters.length),
    [0, 1]
  );
  await emit(a.s, 'message_action', { roomId: rid, messageId: poll.id, action: 'close_poll' });
  assert.equal(
    (
      await emit(b.s, 'message_action', {
        roomId: rid,
        messageId: poll.id,
        action: 'vote',
        optionId: poll.poll.options[0].id,
      })
    ).ok,
    false
  );
  const task = (
    await emit(a.s, 'send_message', {
      to: b.phone,
      task: { title: 'Ship the update', assignee: b.phone, priority: 'high' },
    })
  ).message;
  await emit(b.s, 'message_action', {
    roomId: rid,
    messageId: task.id,
    action: 'task_state',
    state: 'doing',
  });
  assert.equal(
    (await emit(a.s, 'get_history', { with: b.phone })).messages.find((m) => m.id === task.id).task
      .state,
    'doing'
  );
  assert.equal(
    (
      await emit(a.s, 'send_message', {
        to: b.phone,
        task: { title: 'Invalid owner', assignee: c.phone },
      })
    ).ok,
    false
  );
  const decision = (
    await emit(a.s, 'send_message', {
      to: b.phone,
      decision: { title: 'Use resumable uploads', context: 'Big project files' },
    })
  ).message;
  await emit(b.s, 'message_action', { roomId: rid, messageId: decision.id, action: 'agree' });
  const event = (
    await emit(a.s, 'send_message', {
      to: b.phone,
      event: { title: 'Launch call', at: Date.now() + 86400000, location: 'Studio' },
    })
  ).message;
  await emit(b.s, 'message_action', {
    roomId: rid,
    messageId: event.id,
    action: 'rsvp',
    response: 'going',
  });
  assert.equal(
    (await emit(a.s, 'send_message', { to: b.phone, contact: { name: 'Cara', phone: '9880000003' } }))
      .ok,
    true
  );
  assert.equal(
    (
      await emit(a.s, 'send_message', {
        to: b.phone,
        sticker: { emoji: '🚀', label: 'Let’s ship!', color: 'violet' },
      })
    ).ok,
    true
  );
  history = (await emit(a.s, 'get_history', { with: b.phone })).messages;
  assert.equal(history.find((m) => m.id === decision.id).decision.agreedBy.length, 2);
  assert.equal(history.find((m) => m.id === event.id).event.responses[b.phone], 'going');
  await emit(a.s, 'delete_message', { roomId: rid, messageId: task.id, forEveryone: true });
  assert.equal(
    (await emit(a.s, 'get_history', { with: b.phone })).messages.find((m) => m.id === task.id).task,
    null
  );
});

test('group invitations, permissions, member tags and change history enforce roles', async () => {
  const g = (await emit(a.s, 'create_group', { name: 'Launch crew', members: [b.phone] })).group;
  assert.equal((await emit(b.s, 'group_invite', { id: g.id })).ok, false);
  const link = await emit(a.s, 'group_invite', { id: g.id });
  assert.equal(link.ok, true);
  assert.equal((await reconnect(b)).groups.find((x) => x.id === g.id).inviteToken, undefined);
  assert.equal((await emit(c.s, 'preview_invite', { token: link.token })).group.count, 2);
  assert.equal((await emit(c.s, 'join_group', { token: link.token })).group.members.length, 3);
  await emit(a.s, 'group_invite', { id: g.id, reset: true });
  assert.equal((await emit(c.s, 'preview_invite', { token: link.token })).ok, false);
  assert.equal((await emit(b.s, 'group_settings', { id: g.id, adminsOnly: true })).ok, false);
  await emit(a.s, 'group_settings', { id: g.id, adminsOnly: true, memberInvites: true });
  assert.equal((await emit(b.s, 'send_message', { to: g.id, text: 'Not allowed' })).ok, false);
  assert.equal(
    (await emit(a.s, 'send_message', { to: g.id, text: 'Admin announcement' })).ok,
    true
  );
  await emit(b.s, 'member_tag', { id: g.id, tag: 'Designer' });
  const state = await reconnect(a),
    saved = state.groups.find((x) => x.id === g.id);
  assert.equal(saved.tags[b.phone], 'Designer');
  assert.ok(saved.activity.length >= 3);
  assert.equal((await emit(b.s, 'group_invite', { id: g.id })).ok, true);
});

test('scheduled messages run while the author is offline; lists, focus and mark-all-read work', async () => {
  const queued = new Promise((resolve) => a.s.once('scheduled', resolve));
  assert.equal(
    (
      await emit(a.s, 'schedule_message', {
        to: b.phone,
        text: 'Offline scheduled delivery',
        at: Date.now() + 1200,
      })
    ).ok,
    true
  );
  assert.equal((await queued)[0].state, 'pending');
  sockets.filter((s) => s.owner === a.phone).forEach((s) => s.disconnect());
  const received = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Scheduled delivery failed')), 6000);
    b.s.once('message', (m) => {
      clearTimeout(timer);
      resolve(m);
    });
  });
  assert.equal(received.text, 'Offline scheduled delivery');
  const restored = await reconnect(a);
  assert.equal(restored.scheduled[0].state, 'sent');
  await emit(a.s, 'chat_list', { action: 'create', name: 'Project work', chat: b.phone });
  await emit(a.s, 'focus_mode', { enabled: true });
  const updated = await reconnect(a);
  assert.ok(updated.preferences.focusUntil > Date.now());
  assert.ok(updated.preferences.lists[0].chats.includes(b.phone));
  await emit(b.s, 'mark_read', {});
  const history = await emit(a.s, 'get_history', { with: b.phone });
  assert.ok(history.messages.every((m) => m.from !== a.phone || m.readBy.includes(b.phone)));
  await emit(b.s, 'report_chat', { to: a.phone, reason: 'Please review this conversation' });
  const founder = await login('9880000099', 'Site founder');
  const ownerState = await reconnect(founder);
  assert.equal(ownerState.reports.length, 1);
  assert.equal((await emit(a.s, 'resolve_report', { id: ownerState.reports[0].id })).ok, false);
  assert.equal(
    (await emit(founder.s, 'resolve_report', { id: ownerState.reports[0].id })).ok,
    true
  );
});

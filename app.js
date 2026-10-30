import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes, createHash, randomInt } from 'node:crypto';
import { Server } from 'socket.io';
import cors from 'cors';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import webpush from 'web-push';
import { writeJsonAtomically } from './storage.js';
import { verifyGoogleCredential } from './google-auth.js';
import { installUploads, MAX_FILE_BYTES, CHUNK_BYTES } from './uploads.js';
import { attachmentHeaders, installDownloads } from './downloads.js';
import { structuredContent, installFeatures, startScheduler } from './features.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
const uploadsDir = path.join(dataDir, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });
const dataFile = path.join(dataDir, 'chat.json');
const empty = {
  accounts: {},
  sessions: {},
  history: {},
  groups: {},
  prefs: {},
  statuses: [],
  calls: [],
  subscriptions: {},
  googleLinks: {},
  scheduled: [],
  reports: [],
};
// Refuse to silently replace a corrupt database.
const db = fs.existsSync(dataFile)
  ? { ...empty, ...JSON.parse(fs.readFileSync(dataFile, 'utf8')) }
  : empty;
const save = () => writeJsonAtomically(dataFile, db);
const vapidFile = path.join(dataDir, 'vapid.json');
const vapid = fs.existsSync(vapidFile)
  ? JSON.parse(fs.readFileSync(vapidFile, 'utf8'))
  : webpush.generateVAPIDKeys();
if (!fs.existsSync(vapidFile)) fs.writeFileSync(vapidFile, JSON.stringify(vapid), { mode: 0o600 });
webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
  vapid.publicKey,
  vapid.privateKey
);
const phoneValid = (p) => /^\d{10}$/.test(p);
const trim = (v, max = 4000) =>
  String(v || '')
    .trim()
    .slice(0, max);
const hash = (s) => createHash('sha256').update(String(s)).digest('hex');
const roomId = (a, b) => (b?.startsWith('group:') ? b : [a, b].sort().join('::'));
const prefs = (p) =>
  (db.prefs[p] ||= {
    muted: [],
    favorites: [],
    pinned: [],
    archived: [],
    blocked: [],
    starred: [],
    hidden: [],
  });
const online = new Map(),
  otps = new Map(),
  activeCalls = new Map(),
  groupCalls = new Map(),
  pendingDeviceLinks = new Map();
const isOnline = (p) => !!online.get(p)?.size;
const authMode = process.env.AUTH_MODE || (process.env.NODE_ENV === 'production' ? 'sms' : 'demo');
const demoAuth = authMode === 'demo';
const googleClientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
if (!['sms', 'google', 'demo'].includes(authMode)) throw new Error('Unknown AUTH_MODE. Use google, sms or demo.');
if (process.env.NODE_ENV === 'production' && demoAuth)
  throw new Error('AUTH_MODE=demo is not allowed in production. Use google or sms.');
if (authMode === 'google' && !googleClientId)
  throw new Error('AUTH_MODE=google requires GOOGLE_CLIENT_ID on the server.');
const founderPhone = trim(process.env.FOUNDER_PHONE, 10);
if (phoneValid(founderPhone) && !db.accounts[founderPhone]) {
  db.accounts[founderPhone] = {
    phone: founderPhone,
    name: trim(process.env.FOUNDER_NAME, 30) || 'Site founder',
    about: 'Founder · Ask a question or send feedback',
    joinedAt: Date.now(),
    lastSeen: null,
  };
}
const app = express();
app.disable('x-powered-by');
const origin = (value, cb) => {
  const allowed = (process.env.CLIENT_URL || '*')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''));
  cb(
    null,
    !value ||
      allowed.includes('*') ||
      allowed.includes(value) ||
      /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(value)
  );
};
app.use(cors({ origin, credentials: true, exposedHeaders: ['Content-Disposition', 'Content-Length', 'Content-Range'] }));
app.use(express.json({ limit: '256kb' }));
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin, methods: ['GET', 'POST'] },
  maxHttpBufferSize: 256 * 1024,
});
const emitTo = (people, event, data) =>
  io.to([...new Set(people)].map((p) => `user:${p}`)).emit(event, data);
const usersPublic = () =>
  Object.values(db.accounts).map(({ phone, name, about, avatarUrl, avatarColor, avatarStyle, avatarFocus, joinedAt, lastSeen }) => ({
    phone,
    name,
    about,
    avatarUrl,
    avatarColor,
    avatarStyle,
    avatarFocus,
    joinedAt,
    lastSeen,
    online: isOnline(phone),
    isFounder: phone === founderPhone,
  }));
const broadcastUsers = () => emitTo([...online.keys()], 'users', usersPublic());
const membersOf = (rid) =>
  rid.startsWith('group:') ? db.groups[rid]?.members || [] : rid.split('::');
const canRead = (me, rid) => membersOf(rid).includes(me);
const blocked = (a, b) => prefs(a).blocked.includes(b) || prefs(b).blocked.includes(a);
const messageStatus = (m) => {
  const recipients = (m.members || membersOf(m.roomId)).filter((p) => p !== m.from);
  return recipients.every((p) => m.readBy?.includes(p))
    ? 'seen'
    : recipients.every((p) => m.deliveredTo?.includes(p))
      ? 'delivered'
      : 'sent';
};
const messagePublic = (m) => ({ ...m, status: messageStatus(m) });
const emitMessage = (m, event = 'message_updated') =>
  emitTo(membersOf(m.roomId), event, messagePublic(m));
const sessionUser = (token) => {
  const session = db.sessions[hash(token || '')];
  return session?.expires > Date.now() && db.accounts[session.phone] ? session.phone : null;
};
const requireAuth = (req, res, next) => {
  req.user = sessionUser(req.headers.authorization?.replace(/^Bearer /, ''));
  if (!req.user) return res.status(401).json({ error: 'Please sign in again' });
  next();
};
const visibleStatuses = (me) =>
  db.statuses.filter((s) => s.expiresAt > Date.now() && !blocked(me, s.from));
const syncPrefs = (me) => {
  save();
  emitTo([me], 'preferences', prefs(me));
};
const publicGroup = ({ inviteToken, ...g }) => g;
const syncGroups = () => {
  save();
  for (const me of online.keys())
    emitTo(
      [me],
      'groups',
      Object.values(db.groups)
        .filter((g) => g.members.includes(me))
        .map(publicGroup)
    );
};
const syncCalls = (people) => {
  save();
  for (const p of new Set(people))
    emitTo(
      [p],
      'calls',
      db.calls
        .filter((c) => c.from === p || c.to === p || c.members?.includes(p))
        .slice(-100)
        .reverse()
    );
};
const ackError = (ack, error) => ack?.({ ok: false, error });
const safeUrl = (value) => {
  try {
    const u = new URL(value);
    return ['http:', 'https:'].includes(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
};
const media = (f) =>
  f && safeUrl(f.url)
    ? {
        url: safeUrl(f.url),
        name: trim(f.name || 'Attachment', 160),
        mime: trim(f.mime, 100),
        size: Math.max(0, Number(f.size) || 0),
        duration: Math.min(3600, Number(f.duration) || 0),
      }
    : null;

app.get('/api/config', (_req, res) =>
  res.json({
    demoAuth,
    authMode,
    googleClientId,
    founderPhone: phoneValid(founderPhone) ? founderPhone : null,
    maxFileSize: MAX_FILE_BYTES,
    chunkSize: CHUNK_BYTES,
    maxFiles: 20,
  })
);
app.get('/api/health', (_req, res) => res.json({ ok: true, online: online.size }));
app.get('/api/push/key', requireAuth, (_req, res) => res.json({ publicKey: vapid.publicKey }));
app.post('/api/push/subscribe', requireAuth, (req, res) => {
  const s = req.body;
  let endpoint;
  try {
    endpoint = new URL(s.endpoint);
  } catch {
    return res.status(400).json({ error: 'Invalid push subscription' });
  }
  // Restrict requests to known browser push services; never fetch arbitrary subscription URLs.
  const host = endpoint.hostname;
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.port ||
    ![
      'fcm.googleapis.com',
      'updates.push.services.mozilla.com',
      'web.push.apple.com',
      'notify.windows.com',
    ].some((d) => host === d || host.endsWith(`.${d}`)) ||
    !/^[\w-]{80,100}$/.test(s.keys?.p256dh || '') ||
    !/^[\w-]{20,30}$/.test(s.keys?.auth || '')
  )
    return res.status(400).json({ error: 'Unsupported push subscription' });
  db.subscriptions[hash(s.endpoint)] = {
    phone: req.user,
    sessionKey: hash(req.headers.authorization.replace(/^Bearer /, '')),
    subscription: { endpoint: s.endpoint, keys: s.keys },
  };
  save();
  res.json({ ok: true });
});
const pushMessage = (m) => {
  const recipients = membersOf(m.roomId).filter((p) => p !== m.from);
  for (const [key, entry] of Object.entries(db.subscriptions)) {
    const p = entry.phone,
      chat = m.to.startsWith('group:') ? m.to : m.from;
    // A connected but backgrounded tab must still receive Web Push.
    if ([...io.sockets.sockets.values()].some((socket) =>
      socket.data.sessionKey === entry.sessionKey &&
      socket.data.foreground === true &&
      Date.now() - (socket.data.lastForeground || 0) < 60000
    )) continue;
    if (
      !recipients.includes(p) ||
      prefs(p).focusUntil > Date.now() ||
      prefs(p).muted.includes(chat) ||
      !db.sessions[entry.sessionKey] ||
      db.sessions[entry.sessionKey].expires <= Date.now()
    )
      continue;
    const payload = {
      title: db.groups[m.roomId]?.name || m.fromName,
      icon: db.accounts[m.from]?.avatarUrl || '/icon-192.png',
      body:
        m.text ||
        m.task?.title ||
        m.poll?.question ||
        m.event?.title ||
        m.decision?.title ||
        (m.voice ? 'Voice message' : m.gif ? 'GIF' : m.file?.name || 'New message'),
      tag: `chat-${m.roomId}`,
      url: `/?chat=${encodeURIComponent(chat)}`,
    };
    webpush
      .sendNotification(entry.subscription, JSON.stringify(payload), { TTL: 86400, timeout: 10000 })
      .catch((e) => {
        if ([404, 410].includes(e.statusCode)) {
          delete db.subscriptions[key];
          save();
        }
      });
  }
};
// Calls can ring through Web Push even when the recipient has no open tab.
// Push can wake the installed PWA, but browsers cannot answer WebRTC in the background.
const pushIncomingCall = (c) => {
  for (const [key, entry] of Object.entries(db.subscriptions)) {
    if (entry.phone !== c.to || !db.sessions[entry.sessionKey] ||
        db.sessions[entry.sessionKey].expires <= Date.now()) continue;
    const visible = [...io.sockets.sockets.values()].some((socket) =>
      socket.data.sessionKey === entry.sessionKey && socket.data.foreground === true &&
      Date.now() - (socket.data.lastForeground || 0) < 60000);
    if (visible) continue;
    webpush.sendNotification(entry.subscription, JSON.stringify({
      type: 'call',
      title: db.accounts[c.from]?.name || 'Incoming call',
      icon: db.accounts[c.from]?.avatarUrl || '/icon-192.png',
      body: `Incoming ${c.type === 'video' ? 'video' : 'voice'} call · Tap to open PulseChat`,
      tag: `call-${c.callId}`,
      url: `/?chat=${encodeURIComponent(c.groupId || c.from)}&call=${encodeURIComponent(c.callId)}`,
    }), { TTL: 45, urgency: 'high', timeout: 10000 }).catch((e) => {
      if ([404, 410].includes(e.statusCode)) { delete db.subscriptions[key]; save(); }
    });
  }
};
// One-time device link. An already authenticated device must explicitly approve the code.
// The polling secret is separate from the human-readable code; neither is a login token.
const deviceLinkTtlMs = 5 * 60 * 1000;
const deviceLinkLimits = new Map();
const deviceLinkRateLimit = (key, max = 10, windowMs = 60000) => {
  const now = Date.now();
  const previous = deviceLinkLimits.get(key);
  const record = previous && previous.until > now ? previous : { count: 0, until: now + windowMs };
  record.count++;
  deviceLinkLimits.set(key, record);
  return record.count <= max;
};
const newSession = (phone) => {
  const token = randomBytes(32).toString('hex');
  db.sessions[hash(token)] = { phone, expires: Date.now() + 30 * 86400000, profilePending: false };
  save();
  return token;
};
app.post('/api/device-link/start', (req, res) => {
  if (!deviceLinkRateLimit(`start:${req.ip}`, 8, 60000))
    return res.status(429).json({ error: 'Too many requests. Try again shortly.' });
  const code = String(randomInt(10000000, 100000000));
  const secret = randomBytes(32).toString('hex');
  const requestId = randomUUID();
  pendingDeviceLinks.set(requestId, { codeHash: hash(code), secretHash: hash(secret), created: Date.now(), expires: Date.now() + deviceLinkTtlMs, status: 'pending', phone: null, attempts: 0 });
  res.json({ ok: true, requestId, secret, code, expiresIn: deviceLinkTtlMs / 1000 });
});
app.post('/api/device-link/approve', requireAuth, (req, res) => {
  if (!deviceLinkRateLimit(`approve:${req.user}`, 8, 60000))
    return res.status(429).json({ error: 'Too many attempts. Please retry in a minute.' });
  const code = trim(req.body?.code, 8);
  if (!/^\d{8}$/.test(code)) return res.status(400).json({ error: 'Enter the 8-digit pairing code.' });
  const candidate = [...pendingDeviceLinks.values()].find((item) => item.codeHash === hash(code) && item.expires > Date.now() && item.status === 'pending');
  if (!candidate) return res.status(404).json({ error: 'Code was not found or has expired.' });
  candidate.phone = req.user;
  candidate.status = 'approved';
  res.json({ ok: true });
});
app.post('/api/device-link/status', (req, res) => {
  const { requestId, secret } = req.body || {};
  if (typeof requestId !== 'string' || typeof secret !== 'string')
    return res.status(400).json({ error: 'Invalid device-link request.' });
  const item = pendingDeviceLinks.get(requestId);
  if (!item || item.secretHash !== hash(secret))
    return res.status(404).json({ error: 'Link request was not found.' });
  if (item.expires <= Date.now()) {
    pendingDeviceLinks.delete(requestId);
    return res.status(410).json({ error: 'Code expired. Request a new one.' });
  }
  if (item.status === 'pending') return res.json({ ok: true, status: 'pending' });
  // One-time redemption. The signed-in device never exposes its existing token.
  pendingDeviceLinks.delete(requestId);
  const token = newSession(item.phone);
  res.json({ ok: true, status: 'approved', token, user: db.accounts[item.phone] });
});
app.post('/api/device-link/cancel', (req, res) => {
  const { requestId, secret } = req.body || {};
  const item = pendingDeviceLinks.get(requestId);
  if (item && typeof secret === 'string' && item.secretHash === hash(secret)) pendingDeviceLinks.delete(requestId);
  res.json({ ok: true });
});
// Free, production-safe login: verify the signed Google ID token cryptographically.
// Google identities are separate from phone identities; no automatic account takeover/merge.
app.post('/api/auth/google', async (req, res) => {
  if (!googleClientId) return res.status(503).json({ ok: false, error: 'Google Sign-In is not configured' });
  try {
    const identity = await verifyGoogleCredential(req.body?.credential, googleClientId);
    const accountId = db.googleLinks[identity.id] || identity.id;
    const previous = db.accounts[accountId];
    if (!previous) {
      db.accounts[accountId] = {
        phone: accountId, name: identity.name || 'PulseChat User', email: identity.email,
        about: 'Available', joinedAt: Date.now(), lastSeen: null,
      };
      save();
    } else if (previous.email !== identity.email) {
      // Google 'sub' is the immutable account identity. Email can change.
      previous.email = identity.email;
      save();
    }
    const token = newSession(accountId);
    res.json({ ok: true, token, user: db.accounts[accountId] });
  } catch (error) {
    const reason = /signing keys are unavailable/.test(error.message) ? 503 : 401;
    res.status(reason).json({ ok: false, error: reason === 503 ? 'Google Sign-In temporarily unavailable' : 'Google verification failed. Try again.' });
  }
});
// Explicitly link an existing, already-authenticated phone account to Google.
// Prevent hijacking another account or silently merging two accounts' histories.
app.post('/api/auth/google/link', requireAuth, async (req, res) => {
  if (!googleClientId) return res.status(503).json({ ok: false, error: 'Google Sign-In is not configured' });
  try {
    const identity = await verifyGoogleCredential(req.body?.credential, googleClientId);
    const existing = db.googleLinks[identity.id];
    if ((existing && existing !== req.user) || (db.accounts[identity.id] && req.user !== identity.id))
      return res.status(409).json({ ok: false, error: 'That Google account is already in use.' });
    if (req.user.startsWith('google:') && req.user !== identity.id)
      return res.status(409).json({ ok: false, error: 'You cannot link another Google identity.' });
    db.googleLinks[identity.id] = req.user;
    db.accounts[req.user].googleLinked = true;
    save();
    res.json({ ok: true });
  } catch {
    res.status(401).json({ ok: false, error: 'Google verification failed. Try again.' });
  }
});
app.post('/api/send-otp', async (req, res) => {
  if (authMode === 'google') return res.status(400).json({ ok: false, error: 'SMS is disabled. Please use free Google Sign-In.' });
  const phone = trim(req.body?.phone);
  if (!phoneValid(phone))
    return res.status(400).json({ ok: false, error: 'Enter a 10-digit mobile number' });
  const previous = otps.get(phone);
  if (previous && previous.sentAt > Date.now() - 30000)
    return res
      .status(429)
      .json({ ok: false, error: 'Wait 30 seconds before requesting another code' });
  const code = demoAuth ? '111111' : String(randomInt(100000, 1000000));
  otps.set(phone, {
    codeHash: hash(code),
    expires: Date.now() + 300000,
    sentAt: Date.now(),
    attempts: 0,
  });
  if (!demoAuth) {
    const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_FROM: from } = process.env;
    if (!sid || !token || !from) {
      otps.delete(phone);
      return res
        .status(503)
        .json({ ok: false, error: 'SMS delivery is not configured by the site owner' });
    }
    try {
      const response = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
        {
          method: 'POST',
          headers: {
            Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            To: `${process.env.PHONE_COUNTRY_CODE || '+91'}${phone}`,
            From: from,
            Body: `Your PulseChat code is ${code}. Valid for 5 minutes.`,
          }),
          signal: AbortSignal.timeout(15000),
        }
      );
      if (!response.ok) throw new Error('SMS delivery failed');
    } catch {
      otps.delete(phone);
      return res.status(502).json({ ok: false, error: 'Could not send SMS. Try again.' });
    }
  }
  res.json({ ok: true, demoAuth, hint: demoAuth ? 'Demo code: 111111' : undefined });
});
app.post('/api/verify-otp', (req, res) => {
  const phone = trim(req.body?.phone),
    record = otps.get(phone);
  if (!record || record.expires < Date.now())
    return res.status(400).json({ ok: false, error: 'Request a new code' });
  if (++record.attempts > 5) {
    otps.delete(phone);
    return res.status(429).json({ ok: false, error: 'Too many attempts. Request a new code.' });
  }
  if (hash(req.body?.otp) !== record.codeHash)
    return res.status(400).json({ ok: false, error: 'Incorrect code' });
  otps.delete(phone);
  db.accounts[phone] ||= {
    phone,
    name: `User ${phone.slice(-4)}`,
    about: 'Available',
    joinedAt: Date.now(),
    lastSeen: null,
  };
  const token = randomBytes(32).toString('hex');
  db.sessions[hash(token)] = { phone, expires: Date.now() + 30 * 86400000, profilePending: true };
  save();
  res.json({ ok: true, token, user: db.accounts[phone] });
});
app.post('/api/lock-reset', requireAuth, async (req, res) => {
  if (req.user.startsWith('google:') || req.body?.googleCredential) {
    try {
      const identity = await verifyGoogleCredential(req.body?.googleCredential, googleClientId);
      if (identity.id !== req.user && db.googleLinks[identity.id] !== req.user) return res.status(403).json({ error: 'Google account does not match the signed-in user.' });
      return res.json({ ok: true });
    } catch { return res.status(401).json({ error: 'Verify your Google account to reset the PIN.' }); }
  }
  const record = otps.get(req.user);
  if (!record || record.expires < Date.now())
    return res.status(400).json({ error: 'Request a new verification code' });
  if (++record.attempts > 5) {
    otps.delete(req.user);
    return res.status(429).json({ error: 'Too many attempts. Request a new code.' });
  }
  if (hash(req.body?.otp) !== record.codeHash)
    return res.status(400).json({ error: 'Incorrect verification code' });
  otps.delete(req.user);
  res.json({ ok: true });
});
app.post('/api/logout', requireAuth, (req, res) => {
  const key = hash(req.headers.authorization.replace(/^Bearer /, ''));
  delete db.sessions[key];
  for (const [id, s] of Object.entries(db.subscriptions))
    if (s.sessionKey === key) delete db.subscriptions[id];
  for (const socket of io.sockets.sockets.values())
    if (socket.data.sessionKey === key) socket.disconnect(true);
  save();
  res.json({ ok: true });
});
installUploads(app, { dataDir, uploadsDir, requireAuth });
installDownloads(app, { cloudName: process.env.CLOUDINARY_CLOUD_NAME });
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
app.post('/api/upload', requireAuth, upload.single('file'), async (req, res) => {
  try {
    const f = req.file;
    if (!f) return res.status(400).json({ error: 'No file selected' });
    let url;
    if (
      process.env.CLOUDINARY_CLOUD_NAME &&
      process.env.CLOUDINARY_API_KEY &&
      process.env.CLOUDINARY_API_SECRET
    ) {
      const result = await cloudinary.uploader.upload(
        `data:${f.mimetype};base64,${f.buffer.toString('base64')}`,
        { folder: 'pulsechat', resource_type: 'auto' }
      );
      url = result.secure_url;
    } else {
      const id = randomUUID();
      fs.writeFileSync(path.join(uploadsDir, id), f.buffer);
      fs.writeFileSync(
        path.join(uploadsDir, `${id}.json`),
        JSON.stringify({ name: f.originalname, mime: f.mimetype })
      );
      url = `${(process.env.PUBLIC_SERVER_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '')}/api/files/${id}`;
    }
    res.json({ url, name: f.originalname, size: f.size, mime: f.mimetype });
  } catch {
    res.status(500).json({ error: 'Upload failed. Check media storage configuration.' });
  }
});
// Optional AI avatar generation. The user explicitly chooses whether to send a selfie.
// Keep the API key on the server; never include it in the Vite client bundle.
const avatarRequests = new Map();
const avatarPhotoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
app.post('/api/ai-avatar', requireAuth, avatarPhotoUpload.single('selfie'), async (req, res) => {
  if (!process.env.OPENAI_API_KEY)
    return res.status(503).json({ error: 'AI avatars require an image API key configured by the site owner.' });
  if ((avatarRequests.get(req.user) || 0) > Date.now() - 60000)
    return res.status(429).json({ error: 'You can generate another avatar in one minute.' });
  const style = trim(req.body?.style, 32);
  const custom = trim(req.body?.prompt, 240);
  const styles = {
    cinematic: 'cinematic, premium photography, clean background',
    anime: 'modern illustrated anime, beautifully shaded',
    clay: '3D clay render, friendly editorial aesthetic',
    neon: 'neon cyberpunk, vibrant futuristic portrait',
    editorial: 'high-end fashion editorial, sophisticated studio lighting',
  };
  if (!styles[style]) return res.status(400).json({ error: 'Choose a supported avatar style.' });
  if (req.file && !['image/jpeg', 'image/png', 'image/webp'].includes(req.file.mimetype))
    return res.status(400).json({ error: 'Please use a JPEG, PNG or WebP selfie.' });
  avatarRequests.set(req.user, Date.now());
  const prompt = req.file
    ? `Transform the person in this reference photo into a tasteful, polished square profile avatar, retaining their recognizable facial appearance. Style: ${styles[style]}. Additional details: ${custom || 'Natural expression, excellent composition'}. Single person, head and shoulders, no text, square portrait.`
    : `Generate a beautiful original character avatar for a social chat profile: ${styles[style]}. User description: ${custom || 'friendly expressive adult character with an elegant color palette'}. Single character, head and shoulders, no text, square portrait.`;
  try {
    let body, headers = { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, endpoint;
    if (req.file) {
      const form = new FormData();
      form.append('model', process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1');
      form.append('prompt', prompt);
      form.append('size', '1024x1024');
      form.append('image', new Blob([req.file.buffer], { type: req.file.mimetype }), req.file.mimetype === 'image/jpeg' ? 'selfie.jpg' : req.file.mimetype === 'image/webp' ? 'selfie.webp' : 'selfie.png');
      body = form;
      endpoint = 'https://api.openai.com/v1/images/edits';
    } else {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify({ model: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1', prompt, size: '1024x1024', n: 1 });
      endpoint = 'https://api.openai.com/v1/images/generations';
    }
    const response = await fetch(endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(110000) });
    if (!response.ok) {
      console.error('Avatar image provider error:', response.status);
      return res.status(502).json({ error: 'Image service could not generate your avatar. Verify provider access and model configuration.' });
    }
    const data = await response.json();
    const b64 = data.data?.[0]?.b64_json;
    if (!b64 || b64.length > 12 * 1024 * 1024) throw new Error('Invalid image response');
    const bytes = Buffer.from(b64, 'base64');
    if (bytes.length < 512 || bytes.length > 9 * 1024 * 1024) throw new Error('Unexpected image size');
    const id = randomUUID();
    fs.writeFileSync(path.join(uploadsDir, id), bytes);
    fs.writeFileSync(path.join(uploadsDir, `${id}.json`), JSON.stringify({ name: 'ai-avatar.png', mime: 'image/png' }));
    const base = process.env.PUBLIC_SERVER_URL || `${req.protocol}://${req.get('host')}`;
    res.json({ ok: true, url: `${base.replace(/\/$/, '')}/api/files/${id}` });
  } catch (error) {
    console.error('Avatar generation failed:', error.message);
    res.status(502).json({ error: 'Could not create an avatar. Please try another photo or style.' });
  }
});
app.get('/api/files/:id', (req, res) => {
  if (!/^[0-9a-f-]{36}$/.test(req.params.id)) return res.sendStatus(404);
  const file = path.join(uploadsDir, req.params.id);
  if (!fs.existsSync(file)) return res.sendStatus(404);
  const meta = JSON.parse(fs.readFileSync(`${file}.json`, 'utf8'));
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Security-Policy', "default-src 'none'; sandbox allow-downloads");
  const mime = meta.mime.split(';')[0];
  const inline =
    /^(image\/(png|jpeg|gif|webp|avif)|video\/(mp4|webm|ogg)|audio\/(webm|ogg|mpeg|mp4|wav))$/.test(
      mime
    );
  res.type(inline ? mime : 'application/octet-stream');
  if (req.query.download === '1' || !inline) {
    attachmentHeaders(res, meta.name);
    res.type(inline ? mime : 'application/octet-stream');
  } else {
    res.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(meta.name)}`);
  }
  res.sendFile(file);
});
app.use((err, req, res, _next) =>
  res.status(err.status || (err instanceof multer.MulterError ? 400 : 500)).json({
    error:
      err.type === 'entity.too.large'
        ? `Maximum chunk size is ${CHUNK_BYTES / 1024 ** 2} MB`
        : err.code === 'LIMIT_FILE_SIZE'
          ? 'Use resumable uploads for files larger than 25 MB'
          : 'Request failed',
  })
);
const purgeExpired = () => {
  let changed = false;
  for (const [rid, list] of Object.entries(db.history)) {
    const remaining = list.filter((m) => !m.expiresAt || m.expiresAt > Date.now());
    if (remaining.length !== list.length) {
      db.history[rid] = remaining;
      changed = true;
      emitTo(membersOf(rid), 'messages_expired', {
        roomId: rid,
        ids: list.filter((m) => m.expiresAt && m.expiresAt <= Date.now()).map((m) => m.id),
      });
    }
  }
  const statuses = db.statuses.filter((s) => s.expiresAt > Date.now());
  if (statuses.length !== db.statuses.length) {
    db.statuses = statuses;
    changed = true;
    for (const p of online.keys()) emitTo([p], 'statuses', visibleStatuses(p));
  }
  for (const [key, s] of Object.entries(db.sessions))
    if (s.expires <= Date.now()) {
      delete db.sessions[key];
      changed = true;
    }
  for (const [p, o] of otps) if (o.expires <= Date.now()) otps.delete(p);
  for (const [id, link] of pendingDeviceLinks) if (link.expires <= Date.now()) pendingDeviceLinks.delete(id);
  for (const [key, limit] of deviceLinkLimits) if (limit.until <= Date.now()) deviceLinkLimits.delete(key);
  if (changed) save();
};
purgeExpired();
setInterval(purgeExpired, 30000).unref();
for (const c of db.calls)
  if (['ringing', 'connected'].includes(c.status)) {
    c.status = 'interrupted';
    c.endedAt = Date.now();
  }
save();
// Limited-size peer-mesh group calls. Membership is always checked at signaling time.
// This is intentionally capped: larger calls need a deployed SFU instead of mesh.
const GROUP_CALL_LIMIT = 4;
const closeGroupCall = (call) => {
  if (!call) return;
  groupCalls.delete(call.callId);
  const log = db.calls.find(c => c.callId === call.callId);
  if (log) {
    log.status = log.answeredAt ? 'completed' : 'cancelled';
    log.endedAt = Date.now();
    log.duration = log.answeredAt ? Math.floor((log.endedAt - log.answeredAt) / 1000) : 0;
    syncCalls(log.members || []);
  }
  emitTo(db.groups[call.groupId]?.members || [], 'group_call_ended', { callId: call.callId, groupId: call.groupId });
};
const leaveGroupCall = (call, phone) => {
  if (!call?.participants.has(phone)) return;
  call.participants.delete(phone);
  call.sockets.delete(phone);
  emitTo([...call.participants], 'group_call_peer_left', { callId: call.callId, phone });
  if (!call.participants.size) closeGroupCall(call);
};
const finishCall = (c, status, event = 'call_ended') => {
  clearTimeout(c.timer);
  activeCalls.delete(c.callId);
  const log = db.calls.find((x) => x.callId === c.callId);
  if (log) {
    log.status = status;
    log.endedAt = Date.now();
    log.duration = log.answeredAt ? Math.floor((log.endedAt - log.answeredAt) / 1000) : 0;
  }
  emitTo([c.from, c.to], event, { callId: c.callId, reason: status });
  syncCalls([c.from, c.to]);
};
const fail = (message) => {
  throw Object.assign(new Error(message), { publicMessage: message });
};
const deliverMessage = (me, payload) => {
  const to = trim(payload.to, 80),
    rid = roomId(me, to);
  if (!canRead(me, rid) || (!to.startsWith('group:') && !db.accounts[to]))
    fail('Contact or group is unavailable');
  if (!to.startsWith('group:') && blocked(me, to)) fail('Messages cannot be sent to this contact');
  if (db.groups[rid]?.settings?.adminsOnly && !db.groups[rid].admins.includes(me))
    fail('Only admins can send to this group');
  const list = (db.history[rid] ||= []),
    clientId = trim(payload.clientId, 100);
  const existing = clientId && list.find((m) => m.from === me && m.clientId === clientId);
  if (existing) return existing;
  const members = [...new Set(membersOf(rid))];
  let extra;
  try {
    extra = structuredContent(payload, me, members);
  } catch (error) {
    fail(error.message);
  }
  if (
    extra.task?.sourceId &&
    !list.some((m) => m.id === extra.task.sourceId && !m.deletedFor.includes(me))
  )
    extra.task.sourceId = null;
  if (extra.task) extra.task.assigneeName = db.accounts[extra.task.assignee]?.name || null;
  const text = trim(payload.text),
    file = media(payload.file),
    voice = media(payload.voice),
    gif = media(payload.gif);
  if (!text && !file && !voice && !gif && !Object.keys(extra).length)
    fail('Write a message or attach a file');
  const reply = list.find(
    (m) => m.id === payload.replyTo?.id && !m.deleted && !m.deletedFor?.includes(me)
  );
  const lifetime = db.groups[rid]?.disappearing || prefs(me).disappearing?.[to] || 0;
  const message = {
    id: randomUUID(),
    clientId,
    roomId: rid,
    from: me,
    fromName: db.accounts[me].name,
    to,
    text,
    file,
    voice,
    gif,
    ...extra,
    replyTo: reply
      ? {
          id: reply.id,
          fromName: reply.fromName,
          preview: reply.text || reply.task?.title || reply.poll?.question || 'Attachment',
        }
      : null,
    forwarded: !!payload.forwarded,
    time: new Date().toISOString(),
    reactions: {},
    deletedFor: [],
    members,
    deliveredTo: members.filter(isOnline),
    deliveredAt: Object.fromEntries(members.filter(isOnline).map(p => [p, Date.now()])),
    readBy: [me],
    readAt: { [me]: Date.now() },
    expiresAt: lifetime ? Date.now() + lifetime : null,
  };
  list.push(message);
  for (const p of members)
    prefs(p).hidden = prefs(p).hidden.filter(
      (x) => x !== (to.startsWith('group:') ? to : p === me ? to : me)
    );
  save();
  emitMessage(message, 'message');
  pushMessage(message);
  return message;
};
startScheduler({ db, save, deliverMessage, emitTo });
io.on('connection', (socket) => {
  let me = null;
  const on = (event, handler) =>
    socket.on(event, (payload = {}, ack) => {
      if (typeof ack !== 'function') ack = undefined;
      if (!me || !sessionUser(socket.handshake.auth?.token))
        return ackError(ack, 'Please sign in again');
      try {
        handler(payload || {}, ack);
      } catch (error) {
        console.error(`Socket ${event}:`, error.message);
        ackError(ack, error.publicMessage || 'Could not complete the action');
      }
    });
  socket.on('register', (payload, ack) => {
    if (typeof ack !== 'function') ack = undefined;
    const { token, name } = payload || {};
    const p = sessionUser(token);
    if (!p) return ackError(ack, 'Session expired. Sign in with your code again.');
    if (me) return ackError(ack, 'Already signed in');
    me = p;
    socket.handshake.auth = { token };
    socket.data.sessionKey = hash(token);
    socket.data.foreground = false;
    socket.data.lastForeground = 0;
    const authSession = db.sessions[hash(token)];
    if (authSession.profilePending && trim(name, 30)) {
      db.accounts[p].name = trim(name, 30);
      authSession.profilePending = false;
    }
    if (!online.has(p)) online.set(p, new Set());
    online.get(p).add(socket.id);
    socket.join(`user:${p}`);
    const conversations = {};
    for (const [rid, messages] of Object.entries(db.history)) {
      if (!canRead(me, rid)) continue;
      for (const m of messages)
        if (m.from !== me && !m.deliveredTo?.includes(me)) {
          (m.deliveredTo ||= []).push(me);
          (m.deliveredAt ||= {})[me] = Date.now();
          emitMessage(m);
        }
      conversations[rid] = messages.filter((m) => !m.deletedFor?.includes(me)).map(messagePublic);
    }
    save();
    ack?.({
      ok: true,
      user: db.accounts[me],
      users: usersPublic(),
      preferences: prefs(me),
      groups: Object.values(db.groups)
        .filter((g) => g.members.includes(me))
        .map(publicGroup),
      scheduled: db.scheduled
        .filter((s) => s.from === me)
        .slice(-200)
        .reverse(),
      reports: me === founderPhone ? db.reports : [],
      conversations,
      statuses: visibleStatuses(me),
      calls: db.calls
        .filter((c) => c.from === me || c.to === me || c.members?.includes(me))
        .slice(-100)
        .reverse(),
      founderPhone: phoneValid(founderPhone) ? founderPhone : null,
    });
    broadcastUsers();
    for (const groupCall of groupCalls.values()) {
      const group = db.groups[groupCall.groupId];
      if (group?.members.includes(me) && !groupCall.participants.has(me))
        socket.emit('group_call_invite', { callId: groupCall.callId,
          groupId: groupCall.groupId, groupName: group.name,
          from: groupCall.from, fromName: db.accounts[groupCall.from]?.name || 'Member',
          type: groupCall.type });
    }
    // When a PWA is opened from a call notification, redeliver the pending offer.
    for (const call of activeCalls.values()) {
      if (call.to === me && !call.answeredAt) socket.emit('incoming_call', {
        from: call.from, fromName: db.accounts[call.from]?.name || 'Contact',
        type: call.type, offer: call.offer, callId: call.callId,
      });
      if (call.pendingIce?.[me])
        for (const candidate of call.pendingIce[me]) socket.emit('call_ice', { callId: call.callId, from: call.from, candidate });
    }
  });
  on('client_visibility', ({ visible }) => {
    socket.data.foreground = visible === true;
    socket.data.lastForeground = visible === true ? Date.now() : 0;
  });
  on('get_history', ({ with: other }, ack) => {
    const rid = roomId(me, String(other || ''));
    if (!canRead(me, rid)) return ackError(ack, 'You cannot access this chat');
    ack?.({
      ok: true,
      roomId: rid,
      messages: (db.history[rid] || [])
        .filter((m) => !m.deletedFor?.includes(me))
        .map(messagePublic),
    });
  });
  on('send_message', (payload, ack) => {
    ack?.({ ok: true, message: messagePublic(deliverMessage(me, payload)) });
  });
  const getMessage = (rid, id) =>
    canRead(me, rid || '')
      ? db.history[rid]?.find((m) => m.id === id && !m.deletedFor?.includes(me))
      : null;
  on('edit_message', ({ roomId: rid, messageId, text }, ack) => {
    const m = getMessage(rid, messageId);
    if (!m || m.from !== me || m.deleted || !trim(text))
      return ackError(ack, 'This message cannot be edited');
    m.text = trim(text);
    m.editedAt = new Date().toISOString();
    save();
    emitMessage(m);
    ack?.({ ok: true });
  });
  on('delete_message', ({ roomId: rid, messageId, forEveryone }, ack) => {
    const m = getMessage(rid, messageId);
    if (!m) return ackError(ack, 'Message is unavailable');
    if (forEveryone) {
      if (m.from !== me) return ackError(ack, 'Only the sender can delete for everyone');
      Object.assign(m, {
        deleted: true,
        text: '',
        file: null,
        gif: null,
        voice: null,
        replyTo: null,
        poll: null,
        task: null,
        event: null,
        decision: null,
        contact: null,
        sticker: null,
        reactions: {},
      });
      emitMessage(m);
    } else {
      (m.deletedFor ||= []).push(me);
      emitTo([me], 'message_updated', messagePublic(m));
    }
    save();
    ack?.({ ok: true });
  });
  on('react_message', ({ roomId: rid, messageId, emoji }, ack) => {
    const m = getMessage(rid, messageId);
    const validEmoji = typeof emoji === 'string' && emoji.length <= 32 &&
      [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(emoji)].length === 1 &&
      /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Presentation}]/u.test(emoji);
    if (!m || m.deleted || !validEmoji)
      return ackError(ack, 'Reaction is unavailable');
    const previous = m.reactions[emoji]?.includes(me);
    for (const [key, people] of Object.entries(m.reactions)) {
      m.reactions[key] = people.filter((p) => p !== me);
      if (!m.reactions[key].length) delete m.reactions[key];
    }
    if (!previous) (m.reactions[emoji] ||= []).push(me);
    save();
    emitMessage(m);
    ack?.({ ok: true });
  });
  on('seen', ({ roomId: rid, ids }, ack) => {
    if (!canRead(me, rid || '') || !Array.isArray(ids))
      return ackError(ack, 'Invalid read receipt');
    const wanted = new Set(ids.slice(0, 5000));
    for (const m of db.history[rid] || [])
      if (
        wanted.has(m.id) &&
        m.from !== me &&
        !m.readBy?.includes(me) &&
        !m.deletedFor?.includes(me)
      ) {
        (m.readBy ||= []).push(me);
        (m.readAt ||= {})[me] = Date.now();
        if (!m.deliveredTo.includes(me)) {
          m.deliveredTo.push(me);
          (m.deliveredAt ||= {})[me] = Date.now();
        }
        emitMessage(m);
      }
    save();
    ack?.({ ok: true });
  });
  on('typing', ({ to, isTyping }) => {
    const rid = roomId(me, String(to || ''));
    if (!canRead(me, rid) || (!to?.startsWith('group:') && blocked(me, to))) return;
    emitTo(
      membersOf(rid).filter((p) => p !== me),
      'typing',
      { from: me, fromName: db.accounts[me].name, roomId: rid, isTyping: !!isTyping }
    );
  });
  on('preferences', ({ key, value, enabled }, ack) => {
    if (
      !['muted', 'favorites', 'pinned', 'archived', 'blocked', 'starred', 'hidden'].includes(key) ||
      typeof value !== 'string'
    )
      return ackError(ack, 'Invalid setting');
    const list = prefs(me)[key];
    prefs(me)[key] = enabled ? [...new Set([...list, value])] : list.filter((v) => v !== value);
    if (key === 'blocked') {
      emitTo([me], 'statuses', visibleStatuses(me));
      if (db.accounts[value]) emitTo([value], 'statuses', visibleStatuses(value));
    }
    syncPrefs(me);
    ack?.({ ok: true });
  });
  on('clear_chat', ({ with: to, hide }, ack) => {
    const rid = roomId(me, String(to || ''));
    if (!canRead(me, rid)) return ackError(ack, 'Chat is unavailable');
    for (const m of db.history[rid] || []) if (!m.deletedFor.includes(me)) m.deletedFor.push(me);
    if (hide && !prefs(me).hidden.includes(to)) prefs(me).hidden.push(to);
    syncPrefs(me);
    emitTo([me], 'chat_cleared', { roomId: rid });
    ack?.({ ok: true });
  });
  on('profile', ({ name, about, avatarUrl, avatarColor, avatarStyle, avatarFocus }, ack) => {
    if (trim(name, 30).length < 2) return ackError(ack, 'Name must contain at least 2 characters');
    if (avatarUrl !== undefined) {
      const avatar = safeUrl(avatarUrl);
      if (avatarUrl && (!avatar || !(
        /^https:\/\/res\.cloudinary\.com\//.test(avatar) ||
        ((() => {
          const u = new URL(avatar);
          return u.host === new URL(process.env.PUBLIC_SERVER_URL || `${socket.handshake.secure ? 'https' : 'http'}://${socket.handshake.headers.host}`).host &&
            /^\/api\/files\/[0-9a-f-]{36}$/.test(u.pathname);
        })())
      ))) return ackError(ack, 'Use an uploaded profile picture');
    }
    if (avatarColor !== undefined && !/^#[0-9a-fA-F]{6}$/.test(avatarColor))
      return ackError(ack, 'Choose a valid profile color');
    if (avatarStyle !== undefined && !['initials', 'orbit', 'sparkle', 'bloom'].includes(avatarStyle))
      return ackError(ack, 'Choose a valid avatar style');
    if (avatarFocus !== undefined && (!Number.isFinite(avatarFocus) || avatarFocus < 0 || avatarFocus > 100))
      return ackError(ack, 'Choose a valid photo alignment');
    Object.assign(db.accounts[me], { name: trim(name, 30), about: trim(about, 140),
      ...(avatarUrl !== undefined ? { avatarUrl } : {}),
      ...(avatarColor !== undefined ? { avatarColor } : {}),
      ...(avatarStyle !== undefined ? { avatarStyle } : {}),
      ...(avatarFocus !== undefined ? { avatarFocus } : {}), });
    save();
    broadcastUsers();
    emitTo([me], 'profile', db.accounts[me]);
    ack?.({ ok: true });
  });
  on('create_group', ({ name, description, members }, ack) => {
    const people = [...new Set([me, ...(Array.isArray(members) ? members : [])])];
    if (
      trim(name, 60).length < 2 ||
      people.length < 2 ||
      people.length > 100 ||
      people.some((p) => !db.accounts[p] || (p !== me && blocked(me, p)))
    )
      return ackError(ack, 'Choose a group name and 1–99 available members');
    const id = `group:${randomUUID()}`;
    const group = {
      id,
      phone: id,
      isGroup: true,
      name: trim(name, 60),
      description: trim(description, 240),
      members: people,
      admins: [me],
      createdBy: me,
      joinedAt: Date.now(),
      disappearing: 0,
      settings: { adminsOnly: false, memberInvites: false },
      tags: {},
      activity: [
        {
          id: randomUUID(),
          by: me,
          text: `${db.accounts[me].name} created the group`,
          at: Date.now(),
        },
      ],
    };
    db.groups[id] = group;
    syncGroups();
    ack?.({ ok: true, group });
  });
  on('update_group', ({ id, action, phone, name, description }, ack) => {
    const g = db.groups[id];
    if (!g?.members.includes(me)) return ackError(ack, 'You are not a member');
    if (action !== 'leave' && !g.admins.includes(me))
      return ackError(ack, 'Only group admins can make this change');
    if (action === 'details') {
      if (trim(name, 60).length < 2) return ackError(ack, 'Enter a group name');
      g.name = trim(name, 60);
      g.description = trim(description, 240);
    } else if (action === 'add') {
      if (!db.accounts[phone] || blocked(me, phone) || g.members.length >= 100)
        return ackError(ack, 'Member cannot be added');
      g.members = [...new Set([...g.members, phone])];
    } else if (action === 'admin') {
      if (!g.members.includes(phone)) return ackError(ack, 'Member is unavailable');
      g.admins = [...new Set([...g.admins, phone])];
    } else if (action === 'remove' || action === 'leave') {
      const target = action === 'leave' ? me : phone;
      if (!g.members.includes(target)) return ackError(ack, 'Member is unavailable');
      g.members = g.members.filter((p) => p !== target);
      for (const active of [...groupCalls.values()]) if (active.groupId === id && active.participants.has(target)) {
        emitTo([target], 'group_call_ended', { callId: active.callId, groupId: id });
        leaveGroupCall(active, target);
      }
      g.admins = g.admins.filter((p) => p !== target);
      if (g.members.length && !g.admins.length) g.admins = [g.members[0]];
      if (!g.members.length) {
        delete db.groups[id];
        delete db.history[id];
      }
    } else return ackError(ack, 'Unknown group action');
    (g.activity ||= []).push({
      id: randomUUID(),
      by: me,
      text: `${db.accounts[me].name}: ${action}${phone ? ` ? ${db.accounts[phone]?.name || phone}` : ''}`,
      at: Date.now(),
    });
    g.activity = g.activity.slice(-200);
    syncGroups();
    ack?.({ ok: true });
  });
  on('disappearing', ({ to, duration }, ack) => {
    if (![0, 86400000, 604800000, 7776000000].includes(duration))
      return ackError(ack, 'Choose a valid timer');
    const rid = roomId(me, String(to || ''));
    if (!canRead(me, rid)) return ackError(ack, 'Chat is unavailable');
    if (to.startsWith('group:')) {
      if (!db.groups[to].admins.includes(me))
        return ackError(ack, 'Only admins can change the timer');
      db.groups[to].disappearing = duration;
      syncGroups();
    } else {
      (prefs(me).disappearing ||= {})[to] = duration;
      syncPrefs(me);
    }
    ack?.({ ok: true });
  });
  on('post_status', ({ text, color }, ack) => {
    if (!trim(text, 700)) return ackError(ack, 'Write a status update');
    if (db.statuses.filter((s) => s.from === me).length >= 20)
      return ackError(ack, 'Maximum 20 active updates');
    db.statuses.push({
      id: randomUUID(),
      from: me,
      fromName: db.accounts[me].name,
      text: trim(text, 700),
      color: ['#047857', '#4338ca', '#9d174d', '#92400e'].includes(color) ? color : '#047857',
      time: Date.now(),
      expiresAt: Date.now() + 86400000,
      viewedBy: [],
    });
    save();
    for (const p of online.keys()) emitTo([p], 'statuses', visibleStatuses(p));
    ack?.({ ok: true });
  });
  on('delete_status', ({ id }, ack) => {
    if (!db.statuses.some((s) => s.id === id && s.from === me))
      return ackError(ack, 'You can delete your own updates');
    db.statuses = db.statuses.filter((s) => s.id !== id);
    save();
    for (const p of online.keys()) emitTo([p], 'statuses', visibleStatuses(p));
    ack?.({ ok: true });
  });
  on('view_status', ({ id }) => {
    const s = visibleStatuses(me).find((s) => s.id === id);
    if (s && s.from !== me && !s.viewedBy.includes(me)) {
      s.viewedBy.push(me);
      save();
      emitTo([s.from], 'statuses', visibleStatuses(s.from));
    }
  });
  on('group_call_start', ({ groupId, type }, ack) => {
    const group = db.groups[groupId];
    if (!group?.members.includes(me) || !['audio', 'video'].includes(type))
      return ackError(ack, 'Group call is unavailable');
    if ([...activeCalls.values()].some(c => c.from === me || c.to === me) ||
        [...groupCalls.values()].some(c => c.participants.has(me)))
      return ackError(ack, 'End your other call first');
    if ([...groupCalls.values()].some(c => c.groupId === groupId))
      return ackError(ack, 'This group already has a call. Join its invitation.');
    const call = { callId: randomUUID(), groupId, type, from: me,
      createdAt: Date.now(), participants: new Set([me]), sockets: new Map([[me, socket.id]]) };
    db.calls.push({ callId: call.callId, from: me, to: groupId, type, time: Date.now(),
      status: 'ringing', group: true, members: [...group.members] });
    syncCalls(group.members);
    groupCalls.set(call.callId, call);
    const invitees = group.members.filter(p => p !== me && !blocked(me, p));
    emitTo(invitees, 'group_call_invite', { callId: call.callId, groupId, groupName: group.name,
      from: me, fromName: db.accounts[me].name, type });
    for (const to of invitees) pushIncomingCall({ callId: call.callId, from: me, to, type, groupId });
    ack?.({ ok: true, callId: call.callId, groupId, type, participants: [] });
  });
  on('group_call_join', ({ callId }, ack) => {
    const call = groupCalls.get(callId), group = db.groups[call?.groupId];
    if (!call || !group?.members.includes(me) || blocked(me, call.from))
      return ackError(ack, 'Call has ended or you are not a member');
    if (call.participants.has(me)) return ackError(ack, 'Already in call');
    if (call.participants.size >= GROUP_CALL_LIMIT) return ackError(ack, 'Group calls support up to 4 participants');
    if ([...activeCalls.values()].some(c => c.from === me || c.to === me) ||
        [...groupCalls.values()].some(c => c.participants.has(me)))
      return ackError(ack, 'End your other call first');
    const participants = [...call.participants];
    call.participants.add(me);
    call.sockets.set(me, socket.id);
    const log = db.calls.find(c => c.callId === callId);
    if (log && !log.answeredAt) { log.answeredAt = Date.now(); log.status = 'connected'; syncCalls(group.members); }
    emitTo(participants, 'group_call_member_joined', { callId, phone: me, name: db.accounts[me].name });
    ack?.({ ok: true, groupId: call.groupId, type: call.type, participants,
      groupName: group.name });
  });
  on('group_call_signal', ({ callId, to, description, candidate }, ack) => {
    const call = groupCalls.get(callId);
    if (!call || call.sockets.get(me) !== socket.id || !call.participants.has(me) || !call.participants.has(to) || me === to ||
        !db.groups[call.groupId]?.members.includes(me) ||
        !db.groups[call.groupId]?.members.includes(to))
      return ackError(ack, 'Not a participant');
    const validDescription = description && ['offer','answer'].includes(description.type) &&
      typeof description.sdp === 'string' && description.sdp.length < 100000;
    const validIce = candidate && typeof candidate.candidate === 'string' && candidate.candidate.length < 4096;
    if (!validDescription && !validIce) return ackError(ack, 'Invalid signaling data');
    emitTo([to], 'group_call_signal', { callId, from: me,
      description: validDescription ? description : undefined,
      candidate: validIce ? candidate : undefined });
    ack?.({ ok: true });
  });
  on('group_call_leave', ({ callId }, ack) => {
    const active = groupCalls.get(callId);
    if (active?.sockets.get(me) === socket.id) leaveGroupCall(active, me);
    ack?.({ ok: true });
  });
  on('call_user', ({ to, type, offer, callId }, ack) => {
    if (
      !db.accounts[to] ||
      to === me ||
      !['audio', 'video'].includes(type) ||
      !offer?.sdp ||
      typeof callId !== 'string' ||
      callId.length > 100 ||
      blocked(me, to)
    )
      return ackError(ack, 'Cannot call this contact');
    if ([...groupCalls.values()].some(c => c.participants.has(me) || c.participants.has(to)) ||
        [...activeCalls.values()].some((c) => [c.from, c.to].some((p) => p === me || p === to)))
      return ackError(ack, 'This contact is already on a call');
    const log = {
      callId,
      from: me,
      to,
      type,
      time: Date.now(),
      status: 'ringing',
    };
    db.calls.push(log);
    syncCalls([me, to]);
    const c = { callId, from: me, to, type, offer, timer: null, pendingIce: { [me]: [], [to]: [] } };
    c.timer = setTimeout(() => finishCall(c, 'missed'), 45000);
    activeCalls.set(callId, c);
    emitTo([to], 'incoming_call', {
      from: me,
      fromName: db.accounts[me].name,
      type,
      offer,
      callId,
    });
    pushIncomingCall(c);
    ack?.({ ok: true });
  });
  for (const event of ['call_answer', 'call_ice', 'call_reject', 'call_end'])
    on(event, (payload, ack) => {
      const c = activeCalls.get(payload.callId);
      if (!c || ![c.from, c.to].includes(me)) return ackError(ack, 'Call is no longer active');
      const other = c.from === me ? c.to : c.from;
      if (event === 'call_answer') {
        const log = db.calls.find((x) => x.callId === c.callId);
        if (me !== c.to || log.status !== 'ringing' || !payload.answer?.sdp)
          return ackError(ack, 'Call is already answered');
        clearTimeout(c.timer);
        log.status = 'connected';
        log.answeredAt = Date.now();
        c.answeredAt = log.answeredAt;
        syncCalls([me, other]);
        emitTo([other], event, { from: me, answer: payload.answer, callId: c.callId });
        socket
          .to(`user:${me}`)
          .emit('call_ended', { callId: c.callId, reason: 'answered_elsewhere' });
      } else if (event === 'call_ice') {
        if (!payload.candidate || typeof payload.candidate.candidate !== 'string' ||
            payload.candidate.candidate.length > 4096) return ackError(ack, 'Invalid ICE candidate');
        // A recipient may open their device from a Web Push after initial trickle ICE.
        // Keep candidates until the call ends so their connection can be negotiated.
        const pending = (c.pendingIce[other] ||= []);
        if (pending.length < 96) pending.push(payload.candidate);
        emitTo([other], event, { from: me, candidate: payload.candidate, callId: c.callId });
      } else
        finishCall(
          c,
          event === 'call_reject'
            ? 'declined'
            : db.calls.find((x) => x.callId === c.callId)?.answeredAt
              ? 'completed'
              : 'cancelled',
          event === 'call_reject' ? 'call_rejected' : 'call_ended'
        );
      ack?.({ ok: true });
    });
  installFeatures({
    db,
    save,
    on,
    getMe: () => me,
    prefs,
    emitTo,
    emitMessage,
    membersOf,
    canRead,
    blocked,
    syncGroups,
    syncPrefs,
    deliverMessage,
    founderPhone,
  });
  socket.on('disconnect', () => {
    if (!me) return;
    for (const groupCall of [...groupCalls.values()])
      if (groupCall.sockets.get(me) === socket.id) leaveGroupCall(groupCall, me);
    online.get(me)?.delete(socket.id);
    if (!online.get(me)?.size) {
      online.delete(me);
      db.accounts[me].lastSeen = Date.now();
      for (const c of activeCalls.values())
        if ([c.from, c.to].includes(me) && !(c.to === me && !c.answeredAt)) finishCall(c, 'interrupted');
      save();
      broadcastUsers();
    }
  });
});
server.listen(process.env.PORT || 5000, () =>
  console.log(
    `PulseChat listening on ${process.env.PORT || 5000} (${demoAuth ? 'demo login' : 'SMS login'})`
  )
);

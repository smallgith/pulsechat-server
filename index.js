import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';

const PORT = process.env.PORT || 5000;
const CLIENT_URL = process.env.CLIENT_URL || '*';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const app = express();
const corsOptions = {
  origin: CLIENT_URL === '*' ? '*' : CLIENT_URL.split(',').map((s) => s.trim()),
  methods: ['GET', 'POST'],
  credentials: true,
};
app.use(cors(corsOptions));
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const users = new Map();     // phone -> { phone, name, socketId, joinedAt }
const history = new Map();   // roomId -> Message[]
const otps = new Map();      // phone -> { code, expires }
const mutedBy = new Map();   // phone -> Set<phone> (mute list)
const favoritesBy = new Map(); // phone -> Set<phone>

const roomId = (a, b) => [a, b].sort().join('::');
const ensureSet = (m, k) => {
  if (!m.has(k)) m.set(k, new Set());
  return m.get(k);
};

/* ---------------------- OTP (demo — default 111111) ---------------------- */
app.post('/api/send-otp', (req, res) => {
  const { phone } = req.body || {};
  if (!/^\d{10}$/.test(String(phone || ''))) {
    return res.status(400).json({ ok: false, error: 'Invalid phone (10 digits)' });
  }
  const code = '111111';
  otps.set(phone, { code, expires: Date.now() + 5 * 60 * 1000 });
  console.log(`[OTP] ${phone} => ${code}`);
  res.json({ ok: true, message: 'OTP sent', hint: 'Default OTP: 111111' });
});

app.post('/api/verify-otp', (req, res) => {
  const { phone, otp } = req.body || {};
  const rec = otps.get(phone);
  if (!rec) return res.status(400).json({ ok: false, error: 'OTP not requested' });
  if (rec.expires < Date.now()) return res.status(400).json({ ok: false, error: 'OTP expired' });
  if (String(otp) !== rec.code) return res.status(400).json({ ok: false, error: 'Wrong OTP' });
  otps.delete(phone);
  res.json({ ok: true });
});

/* ------------------------------- Upload ------------------------------- */
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const b64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    const result = await cloudinary.uploader.upload(b64, {
      folder: 'pulsechat',
      resource_type: 'auto',
      use_filename: true,
      unique_filename: true,
    });
    res.json({
      url: result.secure_url,
      name: req.file.originalname,
      size: req.file.size,
      mime: req.file.mimetype,
      publicId: result.public_id,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Upload failed' });
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true, online: users.size }));

/* ------------------------------ Socket.IO ------------------------------ */
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: corsOptions.origin, methods: ['GET', 'POST'] },
  maxHttpBufferSize: 1e8,
});

const publicUsers = () =>
  [...users.values()].map((u) => ({
    phone: u.phone,
    name: u.name,
    joinedAt: u.joinedAt,
  }));

io.on('connection', (socket) => {
  let me = null;

  socket.on('register', ({ phone, name } = {}, ack) => {
    const p = String(phone || '').trim();
    const n = String(name || '').trim().slice(0, 30) || `User ${p.slice(-4)}`;
    if (!/^\d{10}$/.test(p)) return ack?.({ ok: false, error: 'Invalid phone' });

    const existing = users.get(p);
    if (existing && io.sockets.sockets.get(existing.socketId)) {
      io.to(existing.socketId).emit('force_logout');
    }

    me = p;
    users.set(p, { phone: p, name: n, socketId: socket.id, joinedAt: Date.now() });
    socket.join(`user:${p}`);

    ack?.({
      ok: true,
      user: users.get(p),
      muted: [...(mutedBy.get(p) || [])],
      favorites: [...(favoritesBy.get(p) || [])],
    });
    io.emit('users', publicUsers());
  });

  socket.on('get_history', ({ with: other } = {}, ack) => {
    if (!me || !other) return;
    const rid = roomId(me, other);
    ack?.({ roomId: rid, messages: history.get(rid) || [] });
  });

  socket.on('send_message', (payload = {}, ack) => {
    if (!me) return;
    const { to, text = '', file = null, gif = null, voice = null, replyTo = null } = payload;
    if (!to) return;
    const rid = roomId(me, to);
    const myUser = users.get(me);
    const msg = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      roomId: rid,
      from: me,
      fromName: myUser?.name || me,
      to,
      text: String(text).slice(0, 4000),
      file,
      gif,
      voice,
      replyTo,
      reactions: {},
      time: new Date().toISOString(),
      status: users.has(to) ? 'delivered' : 'sent',
      deletedFor: [],
    };
    const list = history.get(rid) || [];
    list.push(msg);
    if (list.length > 2000) list.shift();
    history.set(rid, list);
    io.to(`user:${to}`).to(`user:${me}`).emit('message', msg);
    ack?.({ ok: true, message: msg });
  });

  socket.on('delete_message', ({ roomId: rid, messageId, forEveryone } = {}, ack) => {
    if (!me || !rid || !messageId) return;
    const list = history.get(rid);
    if (!list) return;
    const idx = list.findIndex((m) => m.id === messageId);
    if (idx === -1) return;
    const msg = list[idx];

    if (forEveryone) {
      if (msg.from !== me) return ack?.({ ok: false, error: 'Not your message' });
      msg.deleted = true;
      msg.text = '';
      msg.file = null;
      msg.gif = null;
      msg.voice = null;
      msg.reactions = {};
      io.to(`user:${msg.from}`).to(`user:${msg.to}`).emit('message_updated', msg);
    } else {
      if (!Array.isArray(msg.deletedFor)) msg.deletedFor = [];
      if (!msg.deletedFor.includes(me)) msg.deletedFor.push(me);
      io.to(`user:${me}`).emit('message_updated', msg);
    }
    ack?.({ ok: true });
  });

  socket.on('react_message', ({ roomId: rid, messageId, emoji } = {}) => {
    if (!me || !rid || !messageId || !emoji) return;
    const list = history.get(rid);
    if (!list) return;
    const msg = list.find((m) => m.id === messageId);
    if (!msg) return;
    if (!msg.reactions) msg.reactions = {};
    const set = new Set(msg.reactions[emoji] || []);
    if (set.has(me)) set.delete(me);
    else set.add(me);
    if (set.size === 0) delete msg.reactions[emoji];
    else msg.reactions[emoji] = [...set];
    io.to(`user:${msg.from}`).to(`user:${msg.to}`).emit('message_updated', msg);
  });

  socket.on('clear_chat', ({ with: other } = {}, ack) => {
    if (!me || !other) return;
    const rid = roomId(me, other);
    const list = history.get(rid) || [];
    list.forEach((m) => {
      if (!Array.isArray(m.deletedFor)) m.deletedFor = [];
      if (!m.deletedFor.includes(me)) m.deletedFor.push(me);
    });
    io.to(`user:${me}`).emit('chat_cleared', { roomId: rid });
    ack?.({ ok: true });
  });

  socket.on('toggle_mute', ({ with: other, muted } = {}) => {
    if (!me || !other) return;
    const set = ensureSet(mutedBy, me);
    if (muted) set.add(other);
    else set.delete(other);
    io.to(`user:${me}`).emit('mute_list', [...set]);
  });

  socket.on('toggle_favorite', ({ with: other, favorite } = {}) => {
    if (!me || !other) return;
    const set = ensureSet(favoritesBy, me);
    if (favorite) set.add(other);
    else set.delete(other);
    io.to(`user:${me}`).emit('favorite_list', [...set]);
  });

  socket.on('typing', ({ to, isTyping } = {}) => {
    if (!me || !to) return;
    io.to(`user:${to}`).emit('typing', { from: me, isTyping: !!isTyping });
  });

  socket.on('seen', ({ to, roomId: rid } = {}) => {
    if (!me || !to || !rid) return;
    const list = history.get(rid) || [];
    list.forEach((m) => {
      if (m.from === to && m.to === me) m.status = 'seen';
    });
    io.to(`user:${to}`).emit('seen', { roomId: rid, by: me });
  });

  /* ---------------- WebRTC signaling ---------------- */
  socket.on('call_user', ({ to, type, offer, callId } = {}) => {
    if (!me || !to) return;
    const u = users.get(me);
    io.to(`user:${to}`).emit('incoming_call', {
      from: me,
      fromName: u?.name || me,
      type,
      offer,
      callId,
    });
  });

  socket.on('call_answer', ({ to, answer, callId } = {}) => {
    if (!me || !to) return;
    io.to(`user:${to}`).emit('call_answer', { from: me, answer, callId });
  });

  socket.on('call_ice', ({ to, candidate, callId } = {}) => {
    if (!me || !to) return;
    io.to(`user:${to}`).emit('call_ice', { from: me, candidate, callId });
  });

  socket.on('call_reject', ({ to, callId } = {}) => {
    if (!me || !to) return;
    io.to(`user:${to}`).emit('call_rejected', { from: me, callId });
  });

  socket.on('call_end', ({ to, callId } = {}) => {
    if (!me || !to) return;
    io.to(`user:${to}`).emit('call_ended', { from: me, callId });
  });

  socket.on('disconnect', () => {
    if (me && users.get(me)?.socketId === socket.id) {
      users.delete(me);
      io.emit('users', publicUsers());
    }
  });
});

server.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
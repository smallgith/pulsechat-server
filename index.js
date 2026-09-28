import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';

/* ------------------------------- config ------------------------------- */
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

/* ------------------------------- multer ------------------------------- */
// memory storage — Cloudinary par stream karshu
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

/* --------------------------------- state ------------------------------- */
const users = new Map();   // username -> { username, socketId, joinedAt }
const history = new Map(); // roomId -> Message[]
const roomId = (a, b) => [a, b].sort().join('::');

/* -------------------------------- rest api ----------------------------- */
app.get('/', (_req, res) => res.json({ ok: true, app: 'PulseChat API' }));

app.get('/api/health', (_req, res) =>
  res.json({ ok: true, online: users.size })
);

app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    // Cloudinary par stream upload (base64 thi)
    const b64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;

    const result = await cloudinary.uploader.upload(b64, {
      folder: 'pulsechat',
      resource_type: 'auto', // image, video, raw (pdf, docx) sab handle kare
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
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

/* -------------------------------- socket ------------------------------- */
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: corsOptions.origin, methods: ['GET', 'POST'] },
  maxHttpBufferSize: 1e8,
});

const publicUsers = () =>
  [...users.values()].map((u) => ({ username: u.username, joinedAt: u.joinedAt }));

io.on('connection', (socket) => {
  let currentUser = null;

  socket.on('register', ({ username } = {}, ack) => {
    const name = String(username || '').trim().slice(0, 24);
    if (!name) return ack?.({ ok: false, error: 'Username required' });

    const existing = users.get(name);
    if (existing && io.sockets.sockets.get(existing.socketId)) {
      return ack?.({ ok: false, error: 'Username already online' });
    }

    currentUser = name;
    users.set(name, { username: name, socketId: socket.id, joinedAt: Date.now() });
    socket.join(`user:${name}`);

    ack?.({ ok: true, username: name });
    io.emit('users', publicUsers());
  });

  socket.on('get_history', ({ with: other } = {}, ack) => {
    if (!currentUser || !other) return;
    const rid = roomId(currentUser, other);
    ack?.({ roomId: rid, messages: history.get(rid) || [] });
  });

  socket.on('send_message', (payload = {}, ack) => {
    if (!currentUser) return;
    const { to, text = '', file = null } = payload;
    if (!to) return;

    const rid = roomId(currentUser, to);
    const msg = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      roomId: rid,
      from: currentUser,
      to,
      text: String(text).slice(0, 4000),
      file,
      time: new Date().toISOString(),
      status: users.has(to) ? 'delivered' : 'sent',
    };

    const list = history.get(rid) || [];
    list.push(msg);
    if (list.length > 1000) list.shift();
    history.set(rid, list);

    io.to(`user:${to}`).to(`user:${currentUser}`).emit('message', msg);
    ack?.({ ok: true, message: msg });
  });

  socket.on('typing', ({ to, isTyping } = {}) => {
    if (!currentUser || !to) return;
    io.to(`user:${to}`).emit('typing', { from: currentUser, isTyping: !!isTyping });
  });

  socket.on('seen', ({ to, roomId: rid } = {}) => {
    if (!currentUser || !to || !rid) return;
    const list = history.get(rid) || [];
    list.forEach((m) => {
      if (m.from === to && m.to === currentUser) m.status = 'seen';
    });
    io.to(`user:${to}`).emit('seen', { roomId: rid, by: currentUser });
  });

  socket.on('disconnect', () => {
    if (currentUser && users.get(currentUser)?.socketId === socket.id) {
      users.delete(currentUser);
      io.emit('users', publicUsers());
    }
  });
});

server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
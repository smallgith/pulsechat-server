import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import express from 'express';
import { writeJsonAtomically, renameWithRetry } from './storage.js';
import { localFileUrl } from './public-url.js';

export const CHUNK_BYTES = 4 * 1024 * 1024;
const configuredLimit = Number(process.env.MAX_UPLOAD_MB || 2048);
export const MAX_FILE_BYTES = Math.min(
  10 * 1024 ** 3,
  Math.max(CHUNK_BYTES, (Number.isFinite(configuredLimit) ? configuredLimit : 2048) * 1024 ** 2)
);

export function installUploads(app, { dataDir, uploadsDir, requireAuth }) {
  const pendingDir = path.join(dataDir, 'transfers');
  fs.mkdirSync(pendingDir, { recursive: true });
  const validId = (id) => /^[0-9a-f-]{36}$/.test(id);
  const metaPath = (id) => path.join(pendingDir, `${id}.json`);
  const partPath = (id) => path.join(pendingDir, `${id}.part`);
  const recoverCompleted = (meta) => {
    const file = path.join(uploadsDir, meta.id);
    // Recover the crash window between moving a completed file and recording completion.
    if (!meta.completed && fs.existsSync(file) && fs.statSync(file).size === meta.size) {
      writeJsonAtomically(`${file}.json`, {
        name: meta.name,
        mime: meta.mime,
        size: meta.size,
        owner: meta.owner,
      });
      meta.completed = true;
      writeJsonAtomically(metaPath(meta.id), meta);
    }
    return meta;
  };
  const read = (id, owner) => {
    if (!validId(id) || !fs.existsSync(metaPath(id))) return null;
    const meta = JSON.parse(fs.readFileSync(metaPath(id), 'utf8'));
    return meta.owner === owner ? recoverCompleted(meta) : null;
  };
  const offset = (id) => (fs.existsSync(partPath(id)) ? fs.statSync(partPath(id)).size : 0);
  const result = (req, meta) => ({
    id: meta.id,
    url: localFileUrl(req, meta.id),
    name: meta.name,
    mime: meta.mime,
    size: meta.size,
  });
  const cleanup = () => {
    for (const name of fs.readdirSync(pendingDir)) {
      if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(pendingDir, name), 'utf8'));
        if (meta.createdAt < Date.now() - 7 * 86400000) {
          // IDs and resolved filenames are constrained to this transfers directory.
          if (!validId(meta.id)) continue;
          for (const file of [metaPath(meta.id), partPath(meta.id)])
            if (fs.existsSync(file)) fs.unlinkSync(file);
        }
      } catch (error) {
        console.warn('Transfer cleanup:', error.message);
      }
    }
  };
  cleanup();
  setInterval(cleanup, 3600000).unref();
  app.post('/api/uploads', requireAuth, (req, res) => {
    const { name, mime, size, fingerprint } = req.body || {};
    if (
      typeof name !== 'string' ||
      !name.trim() ||
      name.length > 240 ||
      !Number.isSafeInteger(size) ||
      size < 1 ||
      size > MAX_FILE_BYTES ||
      typeof fingerprint !== 'string' ||
      fingerprint.length > 200
    )
      return res
        .status(400)
        .json({
          error: `Choose a file between 1 byte and ${Math.floor(MAX_FILE_BYTES / 1024 ** 2)} MB`,
        });
    // Resuming also works after a browser/server restart. Fingerprints include a content sample.
    let active = 0;
    for (const file of fs.readdirSync(pendingDir).filter((f) => /^[0-9a-f-]{36}\.json$/.test(f))) {
      const existing = JSON.parse(fs.readFileSync(path.join(pendingDir, file), 'utf8'));
      if (existing.owner !== req.user) continue;
      recoverCompleted(existing);
      if (!existing.completed) active++;
      if (existing.fingerprint === fingerprint && existing.size === size && existing.name === name)
        return res.json({
          ...existing,
          offset: existing.completed ? size : offset(existing.id),
          chunkSize: CHUNK_BYTES,
          file: existing.completed ? result(req, existing) : undefined,
        });
    }
    if (active >= 20)
      return res
        .status(429)
        .json({ error: 'Finish or cancel an existing transfer first (20 active files maximum)' });
    const meta = {
      id: randomUUID(),
      name,
      mime: String(mime || 'application/octet-stream').slice(0, 120),
      size,
      fingerprint,
      owner: req.user,
      createdAt: Date.now(),
      completed: false,
    };
    fs.writeFileSync(partPath(meta.id), '', { mode: 0o600 });
    writeJsonAtomically(metaPath(meta.id), meta);
    res.status(201).json({ ...meta, offset: 0, chunkSize: CHUNK_BYTES });
  });
  app.get('/api/uploads/:id', requireAuth, (req, res) => {
    const meta = read(req.params.id, req.user);
    if (!meta) return res.status(404).json({ error: 'Transfer not found' });
    res.json({
      id: meta.id,
      offset: meta.completed ? meta.size : offset(meta.id),
      size: meta.size,
      completed: meta.completed,
      file: meta.completed ? result(req, meta) : undefined,
    });
  });
  app.patch(
    '/api/uploads/:id',
    requireAuth,
    express.raw({ type: 'application/octet-stream', limit: CHUNK_BYTES }),
    (req, res) => {
      const meta = read(req.params.id, req.user);
      if (!meta) return res.status(404).json({ error: 'Transfer not found' });
      if (meta.completed)
        return res.status(409).json({ error: 'Transfer is already complete', offset: meta.size });
      const start = Number(req.headers['upload-offset']);
      const current = offset(meta.id);
      if (!Number.isSafeInteger(start) || start !== current)
        return res.status(409).json({ error: 'Resume from the confirmed offset', offset: current });
      if (!Buffer.isBuffer(req.body) || !req.body.length || current + req.body.length > meta.size)
        return res.status(400).json({ error: 'Invalid chunk length' });
      const checksum = req.headers['upload-checksum'];
      if (
        !/^[a-f0-9]{64}$/.test(checksum || '') ||
        createHash('sha256').update(req.body).digest('hex') !== checksum
      )
        return res.status(422).json({ error: 'Chunk checksum failed. Retry this chunk.' });
      const fd = fs.openSync(partPath(meta.id), 'r+');
      try {
        let written = 0;
        while (written < req.body.length)
          written += fs.writeSync(
            fd,
            req.body,
            written,
            req.body.length - written,
            current + written
          );
      } finally {
        fs.closeSync(fd);
      }
      res.json({ ok: true, offset: current + req.body.length });
    }
  );
  app.post('/api/uploads/:id/complete', requireAuth, (req, res) => {
    const meta = read(req.params.id, req.user);
    if (!meta) return res.status(404).json({ error: 'Transfer not found' });
    if (meta.completed) return res.json(result(req, meta));
    if (offset(meta.id) !== meta.size)
      return res.status(409).json({ error: 'Upload all chunks before completing' });
    const file = path.join(uploadsDir, meta.id);
    // Same-volume rename avoids copying a multi-gigabyte file into memory.
    renameWithRetry(partPath(meta.id), file);
    writeJsonAtomically(`${file}.json`, {
      name: meta.name,
      mime: meta.mime,
      size: meta.size,
      owner: req.user,
    });
    meta.completed = true;
    writeJsonAtomically(metaPath(meta.id), meta);
    res.json(result(req, meta));
  });
  app.delete('/api/uploads/:id', requireAuth, (req, res) => {
    const meta = read(req.params.id, req.user);
    if (!meta) return res.status(404).json({ error: 'Transfer not found' });
    if (meta.completed)
      return res.status(409).json({ error: 'The uploaded file is already complete' });
    for (const file of [partPath(meta.id), metaPath(meta.id)])
      if (fs.existsSync(file)) fs.unlinkSync(file);
    res.json({ ok: true });
  });
}

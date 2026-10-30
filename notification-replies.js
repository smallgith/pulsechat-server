import { createHash, randomBytes } from 'node:crypto';
import { publicServerUrl } from './public-url.js';

const hash = (value) =>
  createHash('sha256')
    .update(String(value || ''))
    .digest('hex');

export function installNotificationReplies(
  app,
  { db, save, requireAuth, canRead, roomId, deliver }
) {
  db.notificationReplies ||= {};
  const available = (owner, source) =>
    source &&
    source.from !== owner &&
    !source.deleted &&
    !source.deletedFor?.includes(owner) &&
    (!source.expiresAt || source.expiresAt > Date.now()) &&
    canRead(owner, source.roomId);
  const issue = ({ owner, sessionKey, source, apiUrl, privateMode = false }) => {
    if (privateMode || !apiUrl || !available(owner, source)) return null;
    const session = db.sessions[sessionKey];
    if (session?.phone !== owner || session.expires <= Date.now()) return null;
    const group = db.groups[source.roomId];
    if (group?.settings?.adminsOnly && !group.admins.includes(owner)) return null;
    const token = randomBytes(32).toString('base64url');
    db.notificationReplies[hash(token)] = {
      owner,
      sessionKey,
      roomId: source.roomId,
      sourceId: source.id,
      to: group ? group.id : source.from,
      expires: Math.min(session.expires, Date.now() + 86400000, source.expiresAt || Infinity),
    };
    try {
      save();
    } catch {
      delete db.notificationReplies[hash(token)];
      return null;
    }
    return {
      token,
      clientId: `notification:${hash(token)}`,
      endpoint: `${apiUrl.replace(/\/+$/, '')}/api/notifications/reply`,
    };
  };
  app.post('/api/notifications/context', requireAuth, (req, res) => {
    const rid = roomId(req.user, String(req.body?.chat || ''));
    const source = db.history[rid]?.find((message) => message.id === req.body?.messageId);
    if (!available(req.user, source))
      return res.status(404).json({ error: 'Message is unavailable' });
    res.json({
      ok: true,
      reply: issue({
        owner: req.user,
        sessionKey: hash(req.headers.authorization.replace(/^Bearer /, '')),
        source,
        apiUrl: publicServerUrl(req),
        privateMode: req.body.privateMode === true,
      }),
    });
  });
  app.post('/api/notifications/reply', (req, res) => {
    const id = hash(req.body?.token),
      scope = db.notificationReplies[id];
    if (
      !scope ||
      scope.expires <= Date.now() ||
      db.sessions[scope.sessionKey]?.phone !== scope.owner ||
      db.sessions[scope.sessionKey]?.expires <= Date.now()
    )
      return res.status(410).json({ error: 'This reply has expired. Open the app to reply.' });
    const text = String(req.body?.text || '').trim();
    if (!text || text.length > 4000)
      return res.status(400).json({ error: 'Write a reply of 1–4000 characters.' });
    const source = db.history[scope.roomId]?.find((message) => message.id === scope.sourceId);
    if (!available(scope.owner, source))
      return res.status(403).json({ error: 'You can no longer reply to this message.' });
    const existing = db.history[scope.roomId]?.find(
      (message) => message.clientId === `notification:${id}`
    );
    if (existing) {
      if (existing.text !== text)
        return res
          .status(409)
          .json({ error: 'Already replied. Open the chat to send another message.' });
      return res.json({ ok: true, messageId: existing.id });
    }
    try {
      const message = deliver(scope.owner, {
        to: scope.to,
        text,
        replyTo: { id: source.id },
        notificationReply: true,
        clientId: `notification:${id}`,
      });
      res.json({ ok: true, messageId: message.id });
    } catch (error) {
      res
        .status(403)
        .json({ error: error.publicMessage || 'Could not send this reply. Open the chat.' });
    }
  });
  return {
    issue,
    cleanup() {
      let changed = false;
      for (const [id, scope] of Object.entries(db.notificationReplies)) {
        if (scope.expires <= Date.now() || !db.sessions[scope.sessionKey]) {
          delete db.notificationReplies[id];
          changed = true;
        }
      }
      return changed;
    },
  };
}

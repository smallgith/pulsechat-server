import { createHash, randomBytes } from 'node:crypto';

const DAY = 24 * 60 * 60 * 1000;
export const SESSION_DAYS = Math.max(31, Math.min(365, Number(process.env.SESSION_DAYS) || 35));
export function sessionStore(db, save, { now = Date.now, days = SESSION_DAYS } = {}) {
  const lifetime = Math.max(31, days) * DAY;
  const key = (token) =>
    createHash('sha256')
      .update(String(token || ''))
      .digest('hex');
  return {
    create(phone) {
      const token = randomBytes(32).toString('hex');
      const id = key(token);
      db.sessions[id] = {
        phone,
        createdAt: now(),
        expires: now() + lifetime,
        profilePending: false,
      };
      try {
        save();
      } catch (error) {
        delete db.sessions[id];
        throw error;
      }
      return token;
    },
    user(token) {
      const session = db.sessions[key(token)];
      if (!session || session.expires <= now() || !db.accounts[session.phone]) return null;
      // Persist at most once a day, rather than on each socket event/chunk upload.
      if (session.expires < now() + lifetime - DAY) {
        const previous = session.expires;
        session.expires = now() + lifetime;
        try {
          save();
        } catch {
          session.expires = previous;
          console.warn(
            'Session renewal could not be persisted; the existing session remains valid.'
          );
        }
      }
      return session.phone;
    },
    expires(token) {
      return db.sessions[key(token)]?.expires;
    },
  };
}

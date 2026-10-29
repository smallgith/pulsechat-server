import { createPublicKey, verify as verifySignature } from 'node:crypto';

const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const MAX_JWT_LENGTH = 12000;
let jwksCache = { expires: 0, keys: [] };
const parseJwtPart = (part) => {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new Error('Invalid Google identity token');
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
};
const getGoogleKeys = async (getKeys) => {
  if (getKeys) return getKeys();
  if (jwksCache.keys.length && jwksCache.expires > Date.now()) return jwksCache.keys;
  const response = await fetch(JWKS_URL, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('Google signing keys are unavailable');
  const json = await response.json();
  if (!Array.isArray(json.keys) || json.keys.length === 0) throw new Error('Google signing keys are unavailable');
  jwksCache = { keys: json.keys, expires: Date.now() + 5 * 60 * 1000 };
  return jwksCache.keys;
};

// Google ID token MUST be verified on the backend. NEVER trust browser-supplied email/sub.
export async function verifyGoogleCredential(credential, audience, { getKeys } = {}) {
  if (!audience || typeof audience !== 'string') throw new Error('Google Sign-In is not configured');
  if (typeof credential !== 'string' || credential.length > MAX_JWT_LENGTH)
    throw new Error('Invalid Google identity token');
  const sections = credential.split('.');
  if (sections.length !== 3) throw new Error('Invalid Google identity token');
  let header, payload;
  try {
    header = parseJwtPart(sections[0]);
    payload = parseJwtPart(sections[1]);
  } catch {
    throw new Error('Invalid Google identity token');
  }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string')
    throw new Error('Unsupported Google identity token');
  let keys = await getGoogleKeys(getKeys);
  let key = keys.find((entry) => entry.kid === header.kid && entry.kty === 'RSA' && (!entry.alg || entry.alg === 'RS256'));
  if (!key && !getKeys) {
    // Google's signing keys rotate: re-fetch immediately on an unfamiliar key ID.
    jwksCache.expires = 0;
    keys = await getGoogleKeys();
    key = keys.find((entry) => entry.kid === header.kid && entry.kty === 'RSA' && (!entry.alg || entry.alg === 'RS256'));
  }
  if (!key) throw new Error('Google identity token signing key not found');
  let signatureOk = false;
  try {
    const publicKey = createPublicKey({ key, format: 'jwk' });
    signatureOk = verifySignature('RSA-SHA256', Buffer.from(`${sections[0]}.${sections[1]}`), publicKey, Buffer.from(sections[2], 'base64url'));
  } catch { /* Invalid key/signature */ }
  if (!signatureOk) throw new Error('Invalid Google identity token signature');
  const now = Math.floor(Date.now() / 1000);
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(payload.iss) ||
      payload.aud !== audience || !Number.isFinite(payload.exp) || payload.exp <= now ||
      !Number.isFinite(payload.iat) || payload.iat > now + 120 ||
      (payload.nbf != null && (!Number.isFinite(payload.nbf) || payload.nbf > now + 120)) ||
      (payload.azp != null && payload.azp !== audience) ||
      typeof payload.sub !== 'string' || !/^[A-Za-z0-9_-]{5,128}$/.test(payload.sub) ||
      payload.email_verified !== true || typeof payload.email !== 'string' ||
      payload.email.length > 254)
    throw new Error('Google identity token has invalid claims');
  return { id: `google:${payload.sub}`, name: String(payload.name || payload.given_name || 'PulseChat User').trim().slice(0, 60), email: payload.email.trim().toLowerCase() };
}

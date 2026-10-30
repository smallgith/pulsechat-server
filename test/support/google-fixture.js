import { readFileSync } from 'node:fs';
import { sign } from 'node:crypto';

const fixture = JSON.parse(readFileSync(new URL('./google-key.json', import.meta.url), 'utf8'));
export const testGoogleClientId = 'pulsechat-test.apps.googleusercontent.com';
export const googleTestKeys = [fixture.publicJwk];
export function googleCredential(subject, name = 'Test user', overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: fixture.publicJwk.kid })).toString(
    'base64url'
  );
  const payload = Buffer.from(
    JSON.stringify({
      iss: 'https://accounts.google.com',
      aud: testGoogleClientId,
      sub: String(subject),
      name,
      email: `${subject}@example.test`,
      email_verified: true,
      iat: now,
      exp: now + 3600,
      ...overrides,
    })
  ).toString('base64url');
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), fixture.privateKey).toString('base64url')}`;
}

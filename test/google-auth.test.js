import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyGoogleCredential } from '../google-auth.js';
import { googleCredential, googleTestKeys, testGoogleClientId } from './support/google-fixture.js';

test('Google signatures, audience, expiry and verified email are enforced', async () => {
  const options = { getKeys: async () => googleTestKeys };
  const token = googleCredential('alice-identity', 'Alice');
  assert.equal(
    (await verifyGoogleCredential(token, testGoogleClientId, options)).id,
    'google:alice-identity'
  );
  for (const overrides of [
    { aud: 'foreign-client' },
    { exp: 1 },
    { email_verified: false },
    { iss: 'https://evil.test' },
  ])
    await assert.rejects(
      verifyGoogleCredential(
        googleCredential('alice-identity', 'Alice', overrides),
        testGoogleClientId,
        options
      )
    );
  const parts = token.split('.');
  parts[1] = Buffer.from(JSON.stringify({ sub: 'attacker' })).toString('base64url');
  await assert.rejects(
    verifyGoogleCredential(parts.join('.'), testGoogleClientId, options),
    /signature/
  );
});

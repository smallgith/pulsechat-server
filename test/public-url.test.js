import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicServerUrl } from '../public-url.js';

test('Render HTTP forwarding and stale HTTP configuration always generate HTTPS public links', () => {
  const req = { protocol: 'http', secure: false, get: () => 'pulsechat-server.onrender.com' };
  assert.equal(
    publicServerUrl(req, 'http://pulsechat-server.onrender.com/'),
    'https://pulsechat-server.onrender.com'
  );
  assert.equal(publicServerUrl(req, ''), 'https://pulsechat-server.onrender.com');
  assert.equal(
    publicServerUrl({ ...req, secure: true }, 'http://chat.example.com'),
    'https://chat.example.com'
  );
  assert.equal(
    publicServerUrl({ ...req, get: () => 'localhost:5000' }, ''),
    'http://localhost:5000'
  );
});

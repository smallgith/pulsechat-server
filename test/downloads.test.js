import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { installDownloads } from '../downloads.js';

async function fixture(t, fetchRemote) {
  const app = express();
  installDownloads(app, { cloudName: 'pulsechat-test', fetchRemote });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      })
  );
  return (url, name = 'report.pdf') =>
    `http://127.0.0.1:${server.address().port}/api/download?${new URLSearchParams({ url, name })}`;
}

test('hosted image, video and raw attachments stream exact bytes with original Unicode filenames', async (t) => {
  const bytes = Buffer.alloc(7 * 1024 * 1024 + 17, 9);
  const requests = [];
  const endpoint = await fixture(t, async (url, options) => {
    requests.push({ url, options });
    return new Response(options.method === 'HEAD' ? null : bytes, {
      headers: {
        'Content-Type': 'image/png',
        'Content-Length': String(bytes.length),
        'Accept-Ranges': 'bytes',
      },
    });
  });
  for (const type of ['image', 'video', 'raw']) {
    const url = endpoint(
      `https://res.cloudinary.com/pulsechat-test/${type}/upload/v123/chat/asset`,
      'રિપોર્ટ 2026.pdf'
    );
    const head = await fetch(url, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), String(bytes.length));
    assert.match(head.headers.get('content-disposition'), /^attachment;.*filename\*=UTF-8''/);
    assert.ok(
      head.headers.get('content-disposition').includes(encodeURIComponent('રિપોર્ટ 2026.pdf'))
    );
    assert.match(head.headers.get('content-security-policy'), /allow-downloads/);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    const downloaded = await fetch(url);
    assert.equal(downloaded.headers.get('content-type'), 'application/octet-stream');
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
  }
  assert.deepEqual(
    requests.map((r) => r.options.method),
    ['HEAD', 'GET', 'HEAD', 'GET', 'HEAD', 'GET']
  );
  assert.ok(
    requests.every((r) => r.options.redirect === 'manual' && !r.options.headers.Authorization)
  );
});

test('download proxy rejects arbitrary origins, foreign clouds and fetch transformations before making a request', async (t) => {
  let calls = 0;
  const endpoint = await fixture(t, async () => {
    calls++;
    throw new Error('Must not fetch');
  });
  for (const url of [
    'http://127.0.0.1/private',
    'https://res.cloudinary.com.evil.test/pulsechat-test/raw/upload/file',
    'http://res.cloudinary.com/pulsechat-test/raw/upload/file',
    'https://res.cloudinary.com/another-cloud/raw/upload/file',
    'https://user:password@res.cloudinary.com/pulsechat-test/raw/upload/file',
    'https://res.cloudinary.com:8443/pulsechat-test/raw/upload/file',
    'https://res.cloudinary.com/pulsechat-test/image/fetch/https://127.0.0.1/private',
    'https://res.cloudinary.com/pulsechat-test/raw/upload/',
    'not-a-url',
  ])
    assert.equal((await fetch(endpoint(url))).status, 400, url);
  assert.equal(calls, 0);
});

test('download proxy rejects redirects/provider errors and preserves byte ranges', async (t) => {
  let mode = 'redirect';
  const endpoint = await fixture(t, async (_url, options) => {
    if (mode === 'redirect')
      return new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/private' } });
    if (mode === 'missing') return new Response('Missing', { status: 404 });
    if (mode === 'denied') return new Response('Denied', { status: 401 });
    if (mode === 'offline') throw new Error('Connection failed');
    assert.equal(options.headers.Range, 'bytes=0-3');
    return new Response(Buffer.from([1, 2, 3, 4]), {
      status: 206,
      headers: { 'Content-Length': '4', 'Content-Range': 'bytes 0-3/100' },
    });
  });
  const url = endpoint('https://res.cloudinary.com/pulsechat-test/raw/upload/file');
  for (const [value, status] of [
    ['redirect', 502],
    ['missing', 404],
    ['denied', 502],
    ['offline', 502],
  ]) {
    mode = value;
    assert.equal((await fetch(url)).status, status);
  }
  mode = 'range';
  const response = await fetch(url, { headers: { Range: 'bytes=0-3' } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 0-3/100');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from([1, 2, 3, 4]));
});

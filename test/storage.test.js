import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeJsonAtomically } from '../storage.js';

test('atomic writes survive transient file locks without damaging the last valid store', () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'pulsechat-storage-'));
  const file = path.join(dir, 'chat.json');
  const originalRename = fs.renameSync;
  try {
    writeJsonAtomically(file, { message: 'before' });
    let attempts = 0;
    fs.renameSync = (...args) => { if (++attempts < 3) throw Object.assign(new Error('Sharing violation'), { code: 'EPERM' }); return originalRename(...args); };
    writeJsonAtomically(file, { message: 'after' });
    assert.equal(attempts, 3); assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).message, 'after');
    fs.renameSync = () => { throw Object.assign(new Error('Disk failed'), { code: 'EIO' }); };
    assert.throws(() => writeJsonAtomically(file, { message: 'lost' }), /Disk failed/);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).message, 'after');
    assert.deepEqual(fs.readdirSync(dir), ['chat.json']);
  } finally {
    fs.renameSync = originalRename;
    if (!path.resolve(dir).startsWith(path.join(tmpdir(), 'pulsechat-storage-'))) throw new Error('Unsafe temporary directory');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

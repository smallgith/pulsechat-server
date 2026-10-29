import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

// Windows virus scanners/watchers can briefly lock the destination of a rename.
// Keep the old valid store intact and retry only transient sharing violations.
export function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 7) throw error;
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        Math.min(100, 10 * 2 ** attempt)
      );
    }
  }
}
export function writeJsonAtomically(file, data) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 });
    renameWithRetry(temporary, file);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      /* The rename may already have completed. */
    }
    throw error;
  }
}

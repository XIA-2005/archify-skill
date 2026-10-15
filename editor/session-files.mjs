import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { containedBy } from '../renderers/shared/path-semantics.mjs';
import {
  captureAtomicOutput, verifyAtomicOutput, captureRegularFileBinding,
  verifyRegularFileBinding, releaseRegularFileBinding,
} from '../renderers/shared/atomic-output.mjs';

function failure(code, message, status = 409) {
  return Object.assign(new Error(message), { code, status });
}

// Pin directory slots, not file contents: legitimate atomic file updates remain
// visible. No probe is created; the random absent name is only a slot capability.
export function createSessionFiles(root, files) {
  const directories = new Map();
  let invalid = false;
  function changed() {
    invalid = true;
    throw failure('EDITOR_SESSION_CHANGED', 'Project directories changed; create a new editor session.');
  }
  function bind(file) {
    if (containedBy(root, file).status !== 'match') {
      throw failure('EDITOR_PATH_OUTSIDE_PROJECT', 'File must remain inside the project.');
    }
    let directory = path.dirname(file);
    for (;;) {
      if (!directories.has(directory)) {
        const probe = path.join(directory, `.archify-editor-slot-${randomBytes(20).toString('hex')}`);
        const captured = captureAtomicOutput(probe, { requestedEntryPolicy: 'regular-or-absent' });
        if (captured.status !== 'captured') changed();
        directories.set(directory, captured);
      }
      if (directory === root) break;
      const parent = path.dirname(directory);
      if (parent === directory) throw failure('EDITOR_PATH_OUTSIDE_PROJECT', 'Invalid project directory.');
      directory = parent;
    }
  }
  function assert() {
    if (invalid) changed();
    for (const captured of directories.values()) {
      if (verifyAtomicOutput(captured.snapshot).status !== 'match') changed();
      const current = captureAtomicOutput(captured.snapshot.requestedPath);
      // path-contract-allow: lexical-capability -- Compare recaptured physical slot spellings as well as inode identity.
      if (current.status !== 'captured' || current.commitPath !== captured.commitPath) changed();
    }
  }
  function read(file, encoding) {
    assert();
    if (containedBy(root, file).status !== 'match') {
      throw failure('EDITOR_PATH_OUTSIDE_PROJECT', 'File must remain inside the project.');
    }
    const captured = captureRegularFileBinding(file, { subject: 'editor-read', includeContent: true });
    try {
      assert();
      if (captured.status !== 'captured') {
        const missing = captured.reason?.systemCode === 'ENOENT';
        throw failure(missing ? 'EDITOR_FILE_NOT_FOUND' : 'EDITOR_FILE_UNSAFE',
          missing ? 'Editor file not found.' : 'Editor file could not be read safely.', missing ? 404 : 409);
      }
      if (verifyRegularFileBinding(captured.binding).status !== 'match') {
        throw failure('EDITOR_FILE_CHANGED', 'Editor file changed while reading; retry the request.');
      }
      assert();
      return encoding ? captured.content.buffer.toString(encoding) : captured.content.buffer;
    } finally {
      if (captured.binding) releaseRegularFileBinding(captured.binding);
    }
  }
  for (const file of files) bind(file);
  assert();
  return { bind, assert, read };
}

export function sessionError(error, fallback = 500) {
  return { status: error.status || fallback,
    body: { ok: false, code: error.code || 'EDITOR_OPERATION_FAILED', message: error.message } };
}

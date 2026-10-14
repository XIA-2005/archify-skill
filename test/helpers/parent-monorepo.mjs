import fs from 'node:fs';
import path from 'node:path';

export function missingParentFile(repoRoot, files) {
  for (const file of files) {
    try {
      fs.statSync(path.join(repoRoot, file));
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return file;
      throw error;
    }
  }
  return null;
}

// Preserve every test name and callback, including existing platform skips.
export function parentMonorepoTest(test, repoRoot, files) {
  return (name, options, callback) => {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    const missing = missingParentFile(repoRoot, files);
    if (missing) {
      return test(name, (t) => { t.skip('parent monorepo absent: ' + missing); });
    }
    return test(name, options, callback);
  };
}

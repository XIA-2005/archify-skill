// Run real monorepo tooling when installed alongside the skill.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [name, ...args] = process.argv.slice(2);
if (!/^[a-z0-9-]+\.mjs$/.test(name || '')) throw new Error('Expected a monorepo script filename.');
let script = fileURLToPath(new URL('../../scripts/' + name, import.meta.url));
try {
  if (!fs.statSync(script).isFile()) throw new Error('Monorepo script is not a file: ' + script);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  if (name === 'run-tests.mjs') {
    console.log('[fallback] monorepo test runner absent; running standalone tests.');
    script = fileURLToPath(new URL('./run-standalone-tests.mjs', import.meta.url));
  } else {
    console.log('[skip] optional monorepo script absent: ' + script);
    process.exit(0);
  }
}
const result = spawnSync(process.execPath, [script, ...args], {
  stdio: 'inherit', windowsHide: true,
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);

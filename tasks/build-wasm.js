// Builds crates/core to wasm32 and copies the module to src/wasm/ol_gpu_core.wasm.
import {execFileSync} from 'node:child_process';
import {copyFileSync, mkdirSync, statSync} from 'node:fs';
import {homedir} from 'node:os';
import {delimiter, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = {
  ...process.env,
  PATH: join(homedir(), '.cargo', 'bin') + delimiter + process.env.PATH,
};

for (const name of ['core', 'shader']) {
  const crate = join(root, 'crates', name);
  execFileSync(
    'cargo',
    [
      'build',
      '--release',
      '--target',
      'wasm32-unknown-unknown',
      '--manifest-path',
      join(crate, 'Cargo.toml'),
    ],
    {stdio: 'inherit', env},
  );
  const file = `ol_gpu_${name}.wasm`;
  const built = join(crate, 'target', 'wasm32-unknown-unknown', 'release', file);
  const out = join(root, 'src', 'wasm', file);
  mkdirSync(dirname(out), {recursive: true});
  copyFileSync(built, out);
  console.log(`wasm: ${out} (${(statSync(out).size / 1024).toFixed(1)} KiB)`);
}

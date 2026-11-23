// Builds the package and puts it in the node_modules of an app on this
// machine, to try a change there before it is published. The files are
// copied, not linked: through a link the app's bundler would find this
// folder's own copy of ol, and the app would run with two of them.
//
// Usage: npm run sync-local -- <path to the app> [--wasm] [--no-build]
//   --wasm      also build the Rust crates (default: the .wasm files in src/wasm)
//   --no-build  copy the dist folder as it is
// Undo: delete node_modules/ol-webgpu in the app and run `npm install` there.
import {execSync} from 'node:child_process';
import {cpSync, existsSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const app = args.find((a) => !a.startsWith('--'));
if (!app || !existsSync(join(resolve(app), 'node_modules'))) {
  console.error('usage: npm run sync-local -- <path to an app with a node_modules folder> [--wasm] [--no-build]');
  process.exit(1);
}
const run = (command) => execSync(command, {cwd: root, stdio: 'inherit'});

if (!args.includes('--no-build')) {
  if (args.includes('--wasm')) {
    run('npm run build:wasm');
  } else if (!existsSync(join(root, 'src', 'wasm', 'ol_gpu_core.wasm'))) {
    console.error('src/wasm has no .wasm files: run with --wasm (needs the Rust toolchain)');
    process.exit(1);
  }
  rmSync(join(root, 'dist'), {recursive: true, force: true});
  run('npx vite build -c vite.lib.config.ts');
  run('npx tsc -p tsconfig.build.json');
}

const target = join(resolve(app), 'node_modules', 'ol-webgpu');
rmSync(target, {recursive: true, force: true});
mkdirSync(target, {recursive: true});
cpSync(join(root, 'dist'), join(target, 'dist'), {recursive: true});
for (const file of ['package.json', 'README.md', 'LICENSE']) {
  cpSync(join(root, file), join(target, file));
}
const git = (command) => execSync(command, {cwd: root, encoding: 'utf8'}).trim();
const dirty = git('git status --porcelain') ? ', with uncommitted changes' : '';
const note = `Local build, not from npm.\nFrom ${root}\nBranch ${git('git branch --show-current')}, commit ${git('git rev-parse --short HEAD')}${dirty}\nCopied ${new Date().toISOString()}\n`;
writeFileSync(join(target, 'LOCAL_BUILD.txt'), note);
console.log(`\n${note}to ${target}\nRestart the app's dev server to pick it up.`);

// Fetches OpenLayers' rendering tests and test data for the installed `ol`
// version into .upstream/openlayers (a shallow, sparse git clone of the
// matching tag). Used by the unit tests (countries.json) and by
// `npm run sync-upstream-tests`. Does nothing if the right version is there.
import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync, rmSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, '.upstream', 'openlayers');
const version = JSON.parse(readFileSync(join(root, 'node_modules', 'ol', 'package.json'), 'utf8')).version;

const packageFile = join(target, 'package.json');
if (existsSync(packageFile) && JSON.parse(readFileSync(packageFile, 'utf8')).version === version) {
  console.log(`.upstream/openlayers is already at ${version}`);
  process.exit(0);
}

rmSync(target, {recursive: true, force: true});
const git = (...args) => execFileSync('git', args, {stdio: 'inherit'});
git('clone', '--depth', '1', '--filter=blob:none', '--sparse', '--branch', `v${version}`, 'https://github.com/openlayers/openlayers.git', target);
git('-C', target, 'sparse-checkout', 'set', 'test/rendering');
console.log(`fetched openlayers v${version} test/rendering into .upstream/openlayers`);

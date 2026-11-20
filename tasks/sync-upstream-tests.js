// Copies OpenLayers' WebGLVector rendering cases (main.js + expected.png) and
// their test data from an ol checkout at the pinned version into
// test/rendering, rewriting imports so the cases run against `ol` from npm
// and the layer class can be swapped (see test/rendering/layer.ts).
//
// Usage: npm run sync-upstream-tests [-- path/to/openlayers]
// Default source: .upstream/openlayers (sparse clone of the tag matching the
// installed ol version).
import {cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const upstream = process.argv[2] ?? join(root, '.upstream', 'openlayers');
const src = join(upstream, 'test', 'rendering');
const dest = join(root, 'test', 'rendering');
if (!existsSync(join(src, 'cases'))) {
  console.error(`no rendering cases found in ${src}`);
  process.exit(1);
}

const olVersion = JSON.parse(readFileSync(join(root, 'node_modules', 'ol', 'package.json'), 'utf8')).version;
const upstreamVersion = JSON.parse(readFileSync(join(upstream, 'package.json'), 'utf8').toString()).version;
if (olVersion !== upstreamVersion) {
  console.warn(`warning: installed ol is ${olVersion} but the upstream checkout is ${upstreamVersion}`);
}

const LAYER_IMPORT = /import\s+(\w+)\s+from\s+'(?:(?:\.\.\/)+src\/)?ol\/layer\/WebGLVector\.js';/;
const cases = readdirSync(join(src, 'cases')).filter((name) => {
  const main = join(src, 'cases', name, 'main.js');
  return existsSync(main) && LAYER_IMPORT.test(readFileSync(main, 'utf8'));
});

rmSync(join(dest, 'cases'), {recursive: true, force: true});
for (const name of cases) {
  const from = join(src, 'cases', name);
  const to = join(dest, 'cases', name);
  mkdirSync(to, {recursive: true});
  let main = readFileSync(join(from, 'main.js'), 'utf8');
  main = main
    .replace(LAYER_IMPORT, "import $1 from '../../layer.ts';")
    .replace(/'(?:\.\.\/)+src\/ol\//g, "'ol/");
  writeFileSync(join(to, 'main.js'), `// synced from openlayers v${upstreamVersion} test/rendering/cases/${name}\n${main}`);
  cpSync(join(from, 'expected.png'), join(to, 'expected.png'));
}

rmSync(join(dest, 'data'), {recursive: true, force: true});
cpSync(join(src, 'data'), join(dest, 'data'), {recursive: true});
writeFileSync(join(dest, 'cases', 'UPSTREAM_VERSION'), `${upstreamVersion}\n`);
console.log(`synced ${cases.length} cases from openlayers ${upstreamVersion}:\n  ${cases.join('\n  ')}`);

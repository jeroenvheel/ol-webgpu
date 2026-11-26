// Runs the benchmark of one data set in several setups of the browser, to
// see what a slow frame on one GPU depends on: the backend of ANGLE, the
// browser, the shaders of the style, the number of features.
//
// Usage: node bench/gpu-matrix.js [--kind=points|lines|polygons] [--runs=2]
// Prints a table of the frame times (ms) per setup; the results of every run
// are written as usual (bench/results-*.json).
import {spawnSync} from 'node:child_process';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, v] = a.slice(2).split('=');
      return [k, v ?? 'true'];
    }),
);
const kind = args.kind ?? 'points';
const runs = Number(args.runs ?? 2);
const SIZES = {points: 1_000_000, lines: 200_000, polygons: 100_000};
const only = (n) => Object.keys(SIZES).map((k) => `--${k}=${k === kind ? n : 0}`);

const SETUPS = [
  ['as the benchmark (ANGLE on D3D11, bundled Chromium)', []],
  ['a quarter of the features', [], SIZES[kind] / 4],
  ['simple style (--style=simple)', ['--style=simple']],
  ['ANGLE on D3D11 over D3D12', ['--browser-args=--use-angle=d3d11on12']],
  ['ANGLE on OpenGL', ['--browser-args=--use-angle=gl']],
  ['ANGLE on Vulkan', ['--browser-args=--use-angle=vulkan,--enable-features=Vulkan']],
  ['installed Chrome (--channel=chrome)', ['--channel=chrome']],
  ['installed Chrome, with a window (--headed)', ['--channel=chrome', '--headed']],
];

const rows = [];
for (const [label, extra, count] of SETUPS) {
  const frames = {ol: [], webgl2: [], webgpu: []};
  let gpu = '';
  for (let run = 0; run < runs; run++) {
    const out = spawnSync(process.execPath, ['bench/run.js', '--layers=ol,webgl2,webgpu', ...only(count ?? SIZES[kind]), ...extra], {cwd: root, encoding: 'utf8'});
    const text = `${out.stdout}\n${out.stderr}`;
    gpu = /GPU: (.*?)\s+WebGPU:/.exec(text)?.[1] ?? gpu;
    for (const name of Object.keys(frames)) {
      const frame = new RegExp(`${name}: .*?frame=([\d.]+)`).exec(text)?.[1];
      frames[name].push(frame ? Number(frame).toFixed(1) : 'failed');
    }
  }
  rows.push({label, gpu, frames});
  console.log(`${label}\n  ${gpu}\n  ${Object.entries(frames).map(([name, f]) => `${name} ${f.join(' / ')}`).join('   ')}`);
}

console.log(`\n| Setup (${kind}) | ol WebGLVector | WebGL2 | WebGPU | WebGL renderer |\n|---|---|---|---|---|`);
for (const {label, gpu, frames} of rows) {
  console.log(`| ${label} | ${frames.ol.join(' / ')} | ${frames.webgl2.join(' / ')} | ${frames.webgpu.join(' / ')} | ${gpu} |`);
}

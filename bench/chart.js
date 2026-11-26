// Draws bench/first-render.svg from bench/history.json: the time to first
// render per release, for the three data sets of the benchmark.
// Usage: node bench/chart.js
import {readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const history = JSON.parse(readFileSync(join(dir, 'history.json'), 'utf8'));

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const mean = (values) => values.reduce((sum, v) => sum + v, 0) / values.length;

const PANELS = [
  ['points', '1M points'],
  ['lines', '200k lines'],
  ['polygons', '100k polygons'],
];
const SERIES = [
  ['webgl2', 'WebGL2', 's1'],
  ['webgpu', 'WebGPU', 's2'],
];
const W = 960;
const H = 372;
const TOP = 96;
const BOTTOM = 44;
const LEFT = 48;
const GAP = 22;
const END = 48; // room for the value at the end of a line
const panelW = (W - LEFT - 12 - GAP * (PANELS.length - 1)) / PANELS.length;
const plotW = panelW - END;
const plotH = H - TOP - BOTTOM;
const Y_MAX = 2000;
const TICKS = [0, 500, 1000, 1500, 2000];
const n = history.releases.length;

const x = (i) => (i / (n - 1)) * plotW;
const y = (ms) => TOP + plotH - (ms / Y_MAX) * plotH;
const r1 = (v) => Math.round(v * 10) / 10;

let out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d" font-family="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif">
<title id="t">Time to first render per release of ol-webgpu</title>
<desc id="d">Milliseconds from adding a layer to rendercomplete, for 1M points, 200k lines and 100k polygons, on WebGL2 and WebGPU, for releases 0.1.0-beta.0 to beta.${n - 1}, with ol's WebGLVector layer as a reference. The numbers are in bench/history.json.</desc>
<style>
  .surface { fill: #ffffff; }
  .primary { fill: #191919; }
  .secondary { fill: #666666; }
  .grid { stroke: #e8e8e8; stroke-width: 1; }
  .ref { stroke: #9c9c9c; stroke-width: 1; }
  .s1 { stroke: #257de0; } .s1f { fill: #257de0; }
  .s2 { stroke: #f47230; } .s2f { fill: #f47230; }
  .line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
  .dot { stroke: #ffffff; stroke-width: 2; }
  text { font-size: 12px; }
  .title { font-size: 16px; font-weight: 600; }
  .panel { font-size: 13px; font-weight: 600; }
  .num { font-variant-numeric: tabular-nums; }
  @media (prefers-color-scheme: dark) {
    .surface { fill: #191919; }
    .primary { fill: #efefef; }
    .secondary { fill: #9c9c9c; }
    .grid { stroke: #2e2e2e; }
    .ref { stroke: #6e6e6e; }
    .s1 { stroke: #338ced; } .s1f { fill: #338ced; }
    .s2 { stroke: #e76624; } .s2f { fill: #e76624; }
    .dot { stroke: #191919; }
  }
</style>
<rect class="surface" width="${W}" height="${H}" rx="8"/>
<text class="title primary" x="16" y="28">Time to first render, per release</text>
<text class="secondary" x="16" y="48">Milliseconds from adding the layer to rendercomplete; lower is better. Median of three runs.</text>
`;

// legend: a line key and a name per series, and the reference
let lx = W - 16;
const legend = [];
const key = (cls, label, width) => {
  lx -= width;
  legend.push(`<line class="${cls}" x1="${lx}" y1="24" x2="${lx + 18}" y2="24"/><text class="primary" x="${lx + 24}" y="28">${label}</text>`);
  lx -= 18;
};
key('ref', 'ol/layer/WebGLVector', 150);
key('line s2', 'WebGPU', 78);
key('line s1', 'WebGL2', 74);
out += legend.reverse().join('\n') + '\n';

PANELS.forEach(([kind, title], p) => {
  const ox = LEFT + p * (panelW + GAP);
  out += `<g transform="translate(${r1(ox)} 0)">\n`;
  out += `<text class="panel primary" x="0" y="${TOP - 14}">${title}</text>\n`;
  for (const tick of TICKS) {
    out += `<line class="grid" x1="0" y1="${r1(y(tick))}" x2="${r1(plotW)}" y2="${r1(y(tick))}"/>\n`;
    if (p === 0) {
      out += `<text class="secondary num" x="-8" y="${r1(y(tick) + 4)}" text-anchor="end">${tick}</text>\n`;
    }
  }
  // every third release, and the last one (without one right before it)
  const ticks = [];
  for (let i = 0; i < n - 2; i += 3) {
    ticks.push(i);
  }
  ticks.push(n - 1);
  for (const i of ticks) {
    out += `<text class="secondary num" x="${r1(x(i))}" y="${H - BOTTOM + 18}" text-anchor="middle">${i}</text>\n`;
  }
  if (p === 0) {
    out += `<text class="secondary" x="0" y="${H - 8}">release 0.1.0-beta.N</text>\n`;
  }
  // the reference: ol's own layer, which does not change with the releases
  const ol = mean(history.ol[kind].ready);
  out += `<line class="ref" x1="0" y1="${r1(y(ol))}" x2="${r1(plotW)}" y2="${r1(y(ol))}"/>\n`;
  out += `<text class="secondary num" x="${r1(plotW + 21)}" y="${r1(y(ol) + 4)}">${Math.round(ol)}</text>\n`;

  const ends = [];
  for (const [name, , cls] of SERIES) {
    const values = history.releases.map((release) => median(release[kind][name].ready));
    out += `<polyline class="line ${cls}" points="${values.map((v, i) => `${r1(x(i))},${r1(y(v))}`).join(' ')}"/>\n`;
    values.forEach((v, i) => {
      out += `<circle class="dot ${cls}f" cx="${r1(x(i))}" cy="${r1(y(v))}" r="3.5"/>\n`;
    });
    ends.push({value: values[n - 1], at: y(values[n - 1]), cls});
  }
  // the last values, kept apart where the lines end together
  ends.sort((a, b) => a.at - b.at);
  if (ends[1].at - ends[0].at < 14) {
    const middle = (ends[0].at + ends[1].at) / 2;
    ends[0].at = middle - 7;
    ends[1].at = middle + 7;
  }
  for (const end of ends) {
    // a short key in the colour of the line, not a dot: it is no measurement
    out += `<line class="line ${end.cls}" x1="${r1(plotW + 8)}" y1="${r1(end.at)}" x2="${r1(plotW + 16)}" y2="${r1(end.at)}"/>\n`;
    out += `<text class="primary num" x="${r1(plotW + 21)}" y="${r1(end.at + 4)}">${end.value}</text>\n`;
  }
  out += '</g>\n';
});
out += '</svg>\n';
writeFileSync(join(dir, 'first-render.svg'), out);
console.log(`bench/first-render.svg: ${n} releases`);

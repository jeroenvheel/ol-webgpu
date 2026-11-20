/**
 * Benchmark: CPU pipeline stages (ol JS vs Rust/WASM) and end-to-end layers.
 * Results are printed on the page and exposed as `window.__bench` for
 * `npm run bench` (bench/run.js).
 */
import Map from 'ol/Map.js';
import View from 'ol/View.js';
import type Feature from 'ol/Feature.js';
import type BaseLayer from 'ol/layer/Base.js';
import WebGLVectorLayer from 'ol/layer/WebGLVector.js';
import MixedGeometryBatch from 'ol/render/webgl/MixedGeometryBatch.js';
import {convertStyleToShaders} from 'ol/render/webgl/VectorStyleRenderer.js';
import {
  generateLineStringRenderInstructions,
  generatePointRenderInstructions,
  generatePolygonRenderInstructions,
  getCustomAttributesSize,
} from 'ol/render/webgl/renderinstructions.js';
import VectorSource from 'ol/source/Vector.js';
import {create as createTransform, makeInverse, scale, translate} from 'ol/transform.js';
import LabelsArray from 'ol/webgl/LabelsArray.js';
import {loadCore} from '../src/wasm/core.js';
import {buildLinesJs, buildPointsJs, buildPolygonsJs} from '../src/worker/fallback.js';
import {benchStyle, makeLines, makePoints, makePolygons} from './synthetic.js';
import {layerFactories} from './layers.js';

const params = new URLSearchParams(location.search);
const sizes = {
  points: Number(params.get('points') ?? 1_000_000),
  lines: Number(params.get('lines') ?? 200_000),
  polygons: Number(params.get('polygons') ?? 100_000),
};
const layerNames = (params.get('layers') ?? 'ol').split(',').filter(Boolean);
// style variants to isolate shader costs: full | fill | stroke | simple
const styleVariant = params.get('style') ?? 'full';
const style: any =
  styleVariant === 'fill'
    ? {'fill-color': benchStyle['fill-color']}
    : styleVariant === 'stroke'
      ? {'stroke-color': benchStyle['stroke-color'], 'stroke-width': benchStyle['stroke-width']}
      : styleVariant === 'simple'
        ? {'fill-color': '#1b9e77aa', 'stroke-color': '#d95f02', 'stroke-width': 1, 'circle-radius': 3, 'circle-fill-color': '#7570b3'}
        : benchStyle;
const logEl = document.getElementById('log')!;
const lines: string[] = [];
function log(s: string) {
  lines.push(s);
  logEl.textContent = lines.join('\n');
  console.log(s);
}

function time<T>(fn: () => T): [T, number] {
  const t0 = performance.now();
  const r = fn();
  return [r, performance.now() - t0];
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

function glInfo() {
  const gl = document.createElement('canvas').getContext('webgl2');
  if (!gl) {
    return 'no webgl2';
  }
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
}

/** Forces the GPU to finish by reading a pixel of the map's layer canvases. */
const syncCanvas = document.createElement('canvas');
syncCanvas.width = syncCanvas.height = 1;
const syncCtx = syncCanvas.getContext('2d', {willReadFrequently: true})!;
function gpuSync() {
  for (const c of document.querySelectorAll('#map canvas')) {
    syncCtx.drawImage(c as HTMLCanvasElement, 0, 0, 1, 1, 0, 0, 1, 1);
  }
  syncCtx.getImageData(0, 0, 1, 1);
}

async function stageBench(name: string, features: Feature[], kind: 'points' | 'lines' | 'polygons') {
  const out: Record<string, number> = {};
  const batch = new MixedGeometryBatch();
  out.batch = time(() => batch.addFeatures(features))[1];

  const shaders = convertStyleToShaders(style, {});
  const customAttributes: Record<string, any> = {
    hitColor: {size: 2, callback: () => [0, 0]},
  };
  for (const s of shaders) {
    Object.assign(customAttributes, s.attributes);
  }
  const customSize = getCustomAttributesSize(customAttributes);
  const transform = createTransform();
  scale(transform, 1 / 2e7, 1 / 2e7);
  translate(transform, 0, 0);
  const invert = makeInverse(createTransform(), transform);
  const labels = new LabelsArray();

  let instr: Float32Array;
  if (kind === 'points') {
    [instr, out.instructions] = time(() =>
      generatePointRenderInstructions(batch.pointBatch, new Float32Array(0), labels, customAttributes, transform),
    );
  } else if (kind === 'lines') {
    [instr, out.instructions] = time(() =>
      generateLineStringRenderInstructions(batch.lineStringBatch, new Float32Array(0), labels, customAttributes, transform),
    );
  } else {
    [instr, out.instructions] = time(() =>
      generatePolygonRenderInstructions(batch.polygonBatch, new Float32Array(0), labels, customAttributes, transform),
    );
  }

  const core = await loadCore();
  const js = {points: buildPointsJs, lines: buildLinesJs, polygons: buildPolygonsJs}[kind];
  const rs = {
    points: (i: Float32Array, c: number) => core.buildPoints(i, c),
    lines: (i: Float32Array, c: number) => core.buildLines(i, c, invert),
    polygons: (i: Float32Array, c: number) => core.buildPolygons(i, c),
  }[kind];
  // warm-up both, then take the best of 3
  js(instr, customSize, invert);
  rs(instr, customSize);
  out.tessellateJs = Infinity;
  out.tessellateWasm = Infinity;
  for (let k = 0; k < 3; k++) {
    out.tessellateJs = Math.min(out.tessellateJs, time(() => js(instr, customSize, invert))[1]);
    out.tessellateWasm = Math.min(out.tessellateWasm, time(() => rs(instr, customSize))[1]);
  }

  // hit index (Rust) build + queries
  const refOffset = 0;
  const [index, buildTime] = time(() =>
    core.buildIndex(
      kind === 'points' ? instr : null,
      kind === 'lines' ? instr : null,
      kind === 'polygons' ? instr : null,
      customSize,
      refOffset,
    ),
  );
  out.indexBuildWasm = buildTime;
  out.indexBytesMB = (index.byteLength / 1e6);
  const queries = 1000;
  const [, qt] = time(() => {
    for (let q = 0; q < queries; q++) {
      core.queryIndex(Math.random() * 1.8 - 0.9, Math.random() * 0.9 - 0.45, 1e-4);
    }
  });
  out.indexQueryWasm = qt / queries;

  log(`${name}: ${Object.entries(out).map(([k, v]) => `${k}=${v.toFixed(k === 'indexQueryWasm' ? 4 : 1)}`).join('  ')}`);
  return out;
}

async function layerBench(layerName: string, features: Feature[]) {
  const target = document.getElementById('map')!;
  const source = new VectorSource({useSpatialIndex: false});
  const [, addTime] = time(() => source.addFeatures(features));
  const layer: BaseLayer = layerFactories[layerName]({source, style});
  const view = new View({center: [0, 0], zoom: 1});
  const map = new Map({target, layers: [], view});
  await nextFrame();

  const t0 = performance.now();
  map.addLayer(layer);
  await new Promise<void>((resolve) => map.once('rendercomplete', () => resolve()));
  gpuSync();
  const ready = performance.now() - t0;

  // frame time while interacting (no buffer rebuild)
  view.beginInteraction();
  const frames = 30;
  let frameTotal = 0;
  for (let i = 0; i < frames; i++) {
    view.setCenter([i * 1000, 0]);
    const f0 = performance.now();
    map.renderSync();
    gpuSync();
    frameTotal += performance.now() - f0;
    await nextFrame();
  }
  view.endInteraction();

  // picking: first pick right away, then wait until the picker has measured
  // data-driven sizes (ol-webgpu layers only), then the steady state
  const size = map.getSize()!;
  const center = [size[0] / 2, size[1] / 2];
  const p0 = performance.now();
  map.forEachFeatureAtPixel(center, () => true);
  const pickFirst = performance.now() - p0;
  const renderer: any = (layer as any).getRenderer?.();
  const w0 = performance.now();
  while (renderer?.isPickingReady && !renderer.isPickingReady((map as any).frameState_) && performance.now() - w0 < 20_000) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const pickReady = renderer?.isPickingReady ? performance.now() - w0 : 0;

  let pickTotal = 0;
  let hits = 0;
  const picks = 200;
  for (let i = 0; i < picks; i++) {
    const pixel = [Math.random() * size[0], Math.random() * size[1]];
    const p0 = performance.now();
    map.forEachFeatureAtPixel(pixel, () => {
      hits++;
      return true;
    });
    pickTotal += performance.now() - p0;
  }

  map.setTarget(undefined);
  map.dispose();
  layer.dispose();
  (window as any).gc?.();
  await nextFrame();
  const out = {sourceAdd: addTime, ready, frame: frameTotal / frames, pickFirst, pickReady, pick: pickTotal / picks, pickHits: hits};
  log(`  ${layerName}: ${Object.entries(out).map(([k, v]) => `${k}=${v.toFixed(2)}`).join('  ')}`);
  return out;
}

async function main() {
  const results: any = {
    env: {userAgent: navigator.userAgent, gpu: glInfo(), webgpu: 'gpu' in navigator, cores: navigator.hardwareConcurrency},
    sizes,
    stages: {},
    layers: {},
  };
  (window as any).__benchPartial = results; // read by bench/run.js if the page dies
  log(`GPU: ${results.env.gpu}   WebGPU: ${results.env.webgpu}`);
  const datasets: Array<['points' | 'lines' | 'polygons', () => Feature[]]> = [
    ['points', () => makePoints(sizes.points)],
    ['lines', () => makeLines(sizes.lines)],
    ['polygons', () => makePolygons(sizes.polygons)],
  ];
  for (const [kind, make] of datasets) {
    if (!sizes[kind]) {
      continue;
    }
    let features: Feature[] | null = make();
    results.stages[kind] = await stageBench(`${kind} (${sizes[kind]})`, features, kind);
    results.layers[kind] = {};
    for (const name of layerNames) {
      console.log(`  ${name}: running`);
      results.layers[kind][name] = await layerBench(name, features);
    }
    features = null;
    (window as any).gc?.();
    await nextFrame();
  }
  (window as any).__bench = results;
  log('done');
}

main().catch((e) => {
  log(`ERROR ${e?.stack ?? e}`);
  (window as any).__bench = {error: String(e?.stack ?? e)};
});

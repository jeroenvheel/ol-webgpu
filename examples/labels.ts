/**
 * Labels: `?layer=gpu|webgpu|webgl2|canvas&text=gpu|canvas&declutter=1&points=20000`.
 * `layer=canvas` is ol's Canvas vector layer, for comparison. The page shows
 * the numbers of the last label layout; `window.__measure()` runs a scripted
 * pan and zoom and returns timings (used for the numbers in the README).
 */
import Feature from 'ol/Feature.js';
import Map from 'ol/Map.js';
import View from 'ol/View.js';
import GeoJSON from 'ol/format/GeoJSON.js';
import Point from 'ol/geom/Point.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import GpuVectorLayer from '../src/layer/GpuVectorLayer.js';
import {liveRenderers} from '../src/renderer/BaseGpuVectorRenderer.js';

const params = new URLSearchParams(location.search);
const kind = params.get('layer') ?? 'gpu';
const text = (params.get('text') ?? 'gpu') as 'gpu' | 'canvas';
const declutter = params.get('declutter') !== '0';
const count = Number(params.get('points') ?? 20000);

// deterministic pseudo-random points with a name each
let seed = 42;
const random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
const syllables = ['ka', 'lo', 'mi', 'ren', 'sta', 'vel', 'dor', 'an', 'be', 'ti', 'gro', 'hem', 'wijk', 'veen', 'burg', 'dam'];
const features: Feature[] = [];
for (let i = 0; i < count; i++) {
  let name = '';
  for (let k = 0, n = 2 + Math.floor(random() * 3); k < n; k++) {
    name += syllables[Math.floor(random() * syllables.length)];
  }
  features.push(
    new Feature({
      geometry: new Point([(random() - 0.5) * 3.6e7, (random() - 0.5) * 1.6e7]),
      name: name[0].toUpperCase() + name.slice(1),
      rank: Math.floor(random() * 4),
    }),
  );
}

const countries = new VectorSource<Feature>({url: '/countries.json', format: new GeoJSON<Feature>()});
const places = new VectorSource({features});

const countryStyle = {
  'fill-color': '#eef3e6',
  'stroke-color': '#9aa88c',
  'stroke-width': 1,
  'text-value': ['get', 'name'],
  'text-font': 'italic 13px Georgia, serif',
  'text-fill-color': '#5d6d4e',
  'text-stroke-color': '#ffffff',
  'text-stroke-width': 3,
};
const placeStyle = {
  'circle-radius': ['match', ['get', 'rank'], 0, 4, 2.5],
  'circle-fill-color': '#b03a2e',
  'circle-stroke-color': '#ffffff',
  'circle-stroke-width': 1,
  'text-value': ['get', 'name'],
  'text-font': ['match', ['get', 'rank'], 0, 'bold 13px sans-serif', '11px sans-serif'],
  'text-fill-color': '#1c2833',
  'text-stroke-color': '#ffffff',
  'text-stroke-width': 3,
  'text-offset-y': -12,
  'z-index': ['match', ['get', 'rank'], 0, 1, 0],
};

const make = (source: VectorSource<any>, style: any) =>
  kind === 'canvas'
    ? new VectorLayer({source, style, declutter})
    : new GpuVectorLayer({source, style, text, declutter, backend: kind === 'gpu' ? 'auto' : (kind as 'webgpu' | 'webgl2')});

const view = new View({center: [0, 2e6], zoom: 3});
const map = new Map({target: 'map', layers: [make(countries, countryStyle), make(places, placeStyle)], view});

const info = document.getElementById('info')!;
map.on('pointermove', (e) => {
  const hit = map.getFeaturesAtPixel(e.pixel, {hitTolerance: 2});
  map.getTargetElement()!.style.cursor = hit.length ? 'pointer' : '';
  info.textContent = hit.map((f) => f.get('name')).join(', ') || ' ';
});

const statsEl = document.getElementById('stats')!;
const labelStats = () => [...liveRenderers].flatMap((r) => (r.gpuText ? [r.gpuText.stats] : []));
map.on('rendercomplete', () => {
  const lines = labelStats().map(
    (s) => `${s.labels} labels (of ${s.measured} measured), ${s.glyphs} glyphs from ${s.features} features: layout ${s.layout.toFixed(1)} ms over ${s.frames} frames, declutter ${s.declutter.toFixed(2)} ms`,
  );
  statsEl.textContent = lines.length ? lines.join('\n') : kind === 'canvas' ? 'ol/layer/Vector (Canvas)' : `text: '${text}'`;
});

const complete = () => new Promise<void>((r) => map.once('rendercomplete', () => r()));

/** Scripted run: time to the first complete render, frames while panning, and a zoom until complete. */
(window as any).__measure = async () => {
  const frames: number[] = [];
  const pan = async (steps: number) => {
    view.beginInteraction();
    for (let i = 0; i < steps; i++) {
      const c = view.getCenter()!;
      view.setCenter([c[0] + view.getResolution()! * 12, c[1]]);
      const t0 = performance.now();
      map.renderSync();
      frames.push(performance.now() - t0);
      await new Promise((r) => requestAnimationFrame(r));
    }
    view.endInteraction();
  };
  await pan(60);
  await complete();
  const sorted = frames.slice().sort((a, b) => a - b);
  const t0 = performance.now();
  view.setZoom(view.getZoom()! + 1);
  await complete();
  const zoom = performance.now() - t0;
  return {
    panMedian: sorted[sorted.length >> 1],
    panWorst: sorted[sorted.length - 1],
    zoomToComplete: zoom,
    stats: labelStats(),
  };
};
const started = performance.now();
complete().then(() => {
  (window as any).__ready = performance.now() - started;
});

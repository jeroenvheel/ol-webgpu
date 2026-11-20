/**
 * Labels side by side: the same source and flat style in ol's Canvas vector
 * layer, ol's WebGLVector layer (text worker) and the ol-webgpu layers (GPU
 * text), with synchronized views.
 * `?points=5000&declutter=1&font=web|system&aa=0`
 */
import type Feature from 'ol/Feature.js';
import Map from 'ol/Map.js';
import View from 'ol/View.js';
import GeoJSON from 'ol/format/GeoJSON.js';
import VectorLayer from 'ol/layer/Vector.js';
import WebGLVectorLayer from 'ol/layer/WebGLVector.js';
import VectorSource from 'ol/source/Vector.js';
import WebGL2VectorLayer from '../src/layer/WebGL2VectorLayer.js';
import WebGPUVectorLayer from '../src/layer/WebGPUVectorLayer.js';
import {liveRenderers} from '../src/renderer/BaseGpuVectorRenderer.js';
import {isWebGPUAvailable} from '../src/webgpu/device.js';
import {makePlaces} from './synthetic.js';

const params = new URLSearchParams(location.search);
const input = (id: string) => document.getElementById(id) as HTMLInputElement;
const count = Number(params.get('points') ?? 3000);
const declutter = params.get('declutter') !== '0';
const webFont = params.get('font') !== 'system';
const textMode = params.get('text') === 'canvas' ? 'canvas' : 'gpu';
input('count').value = String(count);
input('declutter').checked = declutter;
input('webfont').checked = webFont;
input('worker').checked = textMode === 'canvas';

// "Ubuntu" comes from the page's @font-face: ol's text worker cannot see it
const family = webFont ? 'Ubuntu, sans-serif' : 'sans-serif';

const countryStyle = {
  'fill-color': '#eef3e6',
  'stroke-color': '#9aa88c',
  'stroke-width': 1,
  'text-value': ['get', 'name'],
  'text-font': `italic 13px ${webFont ? 'Ubuntu, serif' : 'serif'}`,
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
  'text-font': ['match', ['get', 'rank'], 0, `bold 13px ${family}`, `11px ${family}`],
  'text-fill-color': '#1c2833',
  'text-stroke-color': '#ffffff',
  'text-stroke-width': 3,
  'text-offset-y': -12,
  'z-index': ['match', ['get', 'rank'], 0, 1, 0],
};

// one pair of sources shared by all maps
const countries = new VectorSource<Feature>({url: '/countries.json', format: new GeoJSON<Feature>()});
const places = new VectorSource({features: makePlaces(count)});

type Kind = 'canvas' | 'ol' | 'webgl2' | 'webgpu';
function layers(kind: Kind): any[] {
  return [
    [countries, countryStyle],
    [places, placeStyle],
  ].map(([source, style]: any[]) => {
    switch (kind) {
      case 'canvas':
        return new VectorLayer({source, style, declutter});
      case 'ol':
        // no declutter option: labels of ol's WebGL layer always overlap
        return new WebGLVectorLayer({source, style});
      case 'webgl2':
        return new WebGL2VectorLayer({source, style, declutter, text: textMode});
      default:
        return new WebGPUVectorLayer({source, style, declutter, text: textMode});
    }
  });
}

const view = new View({center: [1.2e6, 6.2e6], zoom: 4});
const maps: Partial<Record<Kind, Map>> = {};
for (const kind of ['canvas', 'ol', 'webgl2', 'webgpu'] as Kind[]) {
  const out = document.getElementById(`pick-${kind}`)!;
  if (kind === 'webgpu' && !isWebGPUAvailable()) {
    out.textContent = 'WebGPU is not available in this browser';
    continue;
  }
  const map = new Map({target: `map-${kind}`, layers: layers(kind), view});
  maps[kind] = map;
  map.on('pointermove', (e) => {
    if (e.dragging) {
      return;
    }
    const t0 = performance.now();
    let names: string[];
    try {
      names = map.getFeaturesAtPixel(e.pixel, {hitTolerance: 2}).map((f) => String(f.get('name')));
    } catch (error) {
      names = [String(error)];
    }
    out.textContent = `${(performance.now() - t0).toFixed(2)} ms  ${names.slice(0, 3).join(' | ') || '–'}`;
  });
}

// what the last frame of each map cost, and the label numbers of the ol-webgpu layers
const stats = document.getElementById('stats')!;
const frames: Partial<Record<Kind, number>> = {};
for (const [kind, map] of Object.entries(maps) as Array<[Kind, Map]>) {
  let start = 0;
  map.on('precompose', () => (start = performance.now()));
  map.on('postcompose', () => (frames[kind] = performance.now() - start));
  map.on('rendercomplete', report);
}
function report() {
  const lines = (Object.entries(frames) as Array<[Kind, number]>).map(([kind, ms]) => `${kind.padEnd(7)} last frame ${ms.toFixed(1)} ms`);
  // the places layer of one of the ol-webgpu maps: the layer with the most labels
  const s = [...liveRenderers].flatMap((r) => (r.gpuText ? [r.gpuText.stats] : [])).sort((a, b) => b.measured - a.measured)[0];
  if (s) {
    lines.push(`GPU text: ${s.labels} labels with glyphs of ${s.measured} measured, layout ${s.layout.toFixed(1)} ms over ${s.frames} frames, declutter ${s.declutter.toFixed(2)} ms`);
  }
  stats.textContent = lines.join('\n');
}

function reload(name: string, value: string) {
  params.set(name, value);
  location.search = params.toString();
}
input('count').addEventListener('change', () => reload('points', input('count').value));
input('declutter').addEventListener('change', () => reload('declutter', input('declutter').checked ? '1' : '0'));
input('webfont').addEventListener('change', () => reload('font', input('webfont').checked ? 'web' : 'system'));
input('worker').addEventListener('change', () => reload('text', input('worker').checked ? 'canvas' : 'gpu'));

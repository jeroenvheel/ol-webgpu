import type Feature from 'ol/Feature.js';
import Map from 'ol/Map.js';
import View from 'ol/View.js';
import GeoJSON from 'ol/format/GeoJSON.js';
import WebGLVectorLayer from 'ol/layer/WebGLVector.js';
import VectorSource from 'ol/source/Vector.js';
import WebGL2VectorLayer from '../src/layer/WebGL2VectorLayer.js';
import WebGPUVectorLayer from '../src/layer/WebGPUVectorLayer.js';
import {makePoints} from './synthetic.js';

const params = new URLSearchParams(location.search);
const countInput = document.getElementById('count') as HTMLInputElement;
countInput.value = params.get('points') ?? countInput.value;
const antialias = params.get('aa') === '1';
(document.getElementById('aa') as HTMLInputElement).checked = antialias;

const style = [
  {
    filter: ['>=', ['get', 'size'], ['var', 'minSize']],
    style: {
      'circle-radius': ['get', 'size'],
      'circle-fill-color': ['match', ['get', 'kind'], 0, '#1b9e77', 1, '#d95f02', 2, '#7570b3', '#e7298a'],
      'circle-stroke-color': '#00000080',
      'circle-stroke-width': 1,
    },
  },
  {
    else: true,
    style: {'fill-color': '#4a90d955', 'stroke-color': '#2c5e91', 'stroke-width': 1.5},
  },
];
const variables = {minSize: 0};

// one source shared by all three layers
const source = new VectorSource<Feature>({url: '/countries.json', format: new GeoJSON<Feature>()});
source.addFeatures(makePoints(Number(countInput.value)));

const view = new View({center: [0, 2e6], zoom: 2});
const layers = {
  ol: new WebGLVectorLayer({source, style: style as any, variables}),
  webgl2: new WebGL2VectorLayer({source, style: style as any, variables, antialias}),
  webgpu: new WebGPUVectorLayer({source, style: style as any, variables, antialias}),
};

for (const [name, layer] of Object.entries(layers)) {
  const map = new Map({target: `map-${name}`, layers: [layer], view});
  const out = document.getElementById(`pick-${name}`)!;
  map.on('pointermove', (e) => {
    const t0 = performance.now();
    const ids: string[] = [];
    map.forEachFeatureAtPixel(e.pixel, (f) => {
      ids.push(String(f.get('name') ?? `point kind ${f.get('kind')} size ${f.get('size')}`));
      return ids.length >= 3;
    });
    out.textContent = `${(performance.now() - t0).toFixed(2)} ms  ${ids.join(' | ') || '–'}`;
  });
}

document.getElementById('min')!.addEventListener('input', (e) => {
  const minSize = Number((e.target as HTMLInputElement).value);
  Object.values(layers).forEach((l) => l.updateStyleVariables({minSize}));
});
document.getElementById('aa')!.addEventListener('change', (e) => {
  params.set('aa', (e.target as HTMLInputElement).checked ? '1' : '0');
  location.search = params.toString();
});
countInput.addEventListener('change', () => {
  params.set('points', countInput.value);
  location.search = params.toString();
});

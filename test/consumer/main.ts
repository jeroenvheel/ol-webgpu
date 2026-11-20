/**
 * Uses the built package (dist/, aliased as 'ol-gpu' by vite.config.ts here)
 * the way an app would. ?case=auto | webgl2 | fallback (WebGPU adapter
 * forced to fail, so GpuVectorLayer must switch to WebGL2 at runtime).
 * Result in window.__result: backend used, centre pixel colour, picked ids.
 */
import Feature from 'ol/Feature.js';
import Map from 'ol/Map.js';
import View from 'ol/View.js';
import Point from 'ol/geom/Point.js';
import VectorSource from 'ol/source/Vector.js';
import {GpuVectorLayer, WebGL2VectorLayer} from 'ol-gpu';

const testCase = new URLSearchParams(location.search).get('case') ?? 'auto';
if (testCase === 'fallback' && 'gpu' in navigator) {
  (navigator as any).gpu.requestAdapter = async () => null;
}

const feature = new Feature({geometry: new Point([0, 0]), name: 'dot'});
const source = new VectorSource({features: [feature]});
const style = {
  'circle-radius': 20,
  'circle-fill-color': '#ff0000',
  // label below the dot: checks that ol's text worker loads in a production build
  'text-value': ['get', 'name'],
  'text-font': 'bold 16px sans-serif',
  'text-fill-color': '#0000ff',
  'text-offset-y': 40,
};
const layer =
  testCase === 'webgl2' ? new WebGL2VectorLayer({source, style}) : new GpuVectorLayer({source, style, backend: 'auto'});
const map = new Map({target: 'map', layers: [layer], view: new View({center: [0, 0], resolution: 1})});

const probe = document.createElement('canvas').getContext('2d', {willReadFrequently: true})!;
const start = performance.now();
map.on('rendercomplete', () => {
  // same task as the render, so this also works for WebGPU canvases
  const canvas = document.querySelector('#map canvas') as HTMLCanvasElement | null;
  let pixel: number[] = [];
  let labelPixels = 0;
  if (canvas) {
    probe.canvas.width = canvas.width;
    probe.canvas.height = canvas.height;
    probe.clearRect(0, 0, canvas.width, canvas.height);
    probe.drawImage(canvas, 0, 0);
    pixel = [...probe.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data];
    // blue label pixels around y = 140
    const band = probe.getImageData(0, 125, canvas.width, 30).data;
    for (let i = 0; i < band.length; i += 4) {
      labelPixels += band[i + 2] > 150 && band[i] < 100 && band[i + 3] > 150 ? 1 : 0;
    }
  }
  const picked: string[] = [];
  map.forEachFeatureAtPixel([100, 100], (f) => {
    picked.push(f.get('name'));
  });
  const backend = 'getBackend' in layer ? (layer as GpuVectorLayer).getBackend() : 'webgl2';
  const done = pixel[0] > 200 && pixel[1] < 50 && picked.length > 0 && labelPixels > 0;
  if (done || performance.now() - start > 15_000) {
    (window as any).__result = {backend, pixel, picked, labelPixels};
  } else {
    setTimeout(() => map.render(), 50);
  }
});

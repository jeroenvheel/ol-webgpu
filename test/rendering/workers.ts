/**
 * Several layers that build at the same time
 * (`workers.html?layer=webgl2|webgpu&workers=1|2`): how long until the map
 * is complete, how long when all layers build once more (the workers are
 * there by then), and how many workers built. Result in window.__workers.
 */
import Feature from 'ol/Feature.js';
import Map from 'ol/Map.js';
import View from 'ol/View.js';
import LineString from 'ol/geom/LineString.js';
import VectorSource from 'ol/source/Vector.js';
import {frame, renderersSettled} from './settled.js';
import WebGL2VectorLayer from '../../src/layer/WebGL2VectorLayer.js';
import WebGPUVectorLayer from '../../src/layer/WebGPUVectorLayer.js';
import {WorkerClient} from '../../src/worker/client.js';

const params = new URLSearchParams(location.search);
const Layer = params.get('layer') === 'webgpu' ? WebGPUVectorLayer : WebGL2VectorLayer;
WorkerClient.maxWorkers = Number(params.get('workers') ?? 2);

const LAYERS = 5;
// fewer lines where drawing is slow (software rendering in CI), and then less work is worth a worker
const LINES = Number(params.get('lines') ?? 120_000);
if (params.has('worth')) {
  WorkerClient.worthAWorker = Number(params.get('worth'));
}
const sources: VectorSource[] = [];
for (let l = 0; l < LAYERS; l++) {
  const features: Feature[] = [];
  for (let i = 0; i < LINES; i++) {
    const x = ((i * 37) % 240) - 120;
    const y = ((i * 101 + l * 13) % 240) - 120;
    features.push(new Feature(new LineString([[x, y], [x + 4, y + 3], [x + 8, y], [x + 12, y + 3]])));
  }
  sources.push(new VectorSource({features, useSpatialIndex: false}));
}
const colors = ['#d7191c', '#fdae61', '#1a9641', '#2c7bb6', '#7b3294', '#404040'];
const map = new Map({target: 'map', pixelRatio: 1, controls: [], layers: [], view: new View({center: [0, 0], resolution: 1})});

requestAnimationFrame(() => {
  const start = performance.now();
  sources.forEach((source, l) => map.addLayer(new Layer({source, style: {'stroke-color': colors[l], 'stroke-width': 1}})));
  map.once('rendercomplete', () => {
    const ms = Math.round(performance.now() - start);
    // every layer is there: its colour shows somewhere
    const probe = document.createElement('canvas').getContext('2d', {willReadFrequently: true})!;
    probe.canvas.width = probe.canvas.height = 256;
    map.renderSync();
    for (const canvas of document.querySelectorAll('#map canvas')) {
      probe.drawImage(canvas as HTMLCanvasElement, 0, 0);
    }
    const data = probe.getImageData(0, 0, 256, 256).data;
    let drawn = 0;
    for (let i = 3; i < data.length; i += 4) {
      drawn += data[i] > 0 ? 1 : 0;
    }
    // once more, now that the workers are there: all layers build again
    const again = performance.now();
    sources.forEach((source) => source.changed());
    void (async () => {
      for (let i = 0; i < 3 || !(map.isRendered() && renderersSettled()); i++) {
        await frame();
      }
      (window as any).__workers = {
        ms,
        again: Math.round(performance.now() - again),
        workers: WorkerClient.shared().mostWorkers,
        drawn,
        layers: LAYERS,
        lines: LINES,
      };
    })();
  });
});

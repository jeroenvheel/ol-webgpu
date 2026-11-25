/**
 * When buffers are built (`?layer=webgl2|webgpu`): not for another extent,
 * as the buffers hold every feature, but for other features and for a view
 * far from where they were built. A view the buffers were not built for must
 * be drawn and hit like one they were built for.
 * Result in window.__rebuild: {name: {ok, detail}}.
 */
import Feature from 'ol/Feature.js';
import Map from 'ol/Map.js';
import View from 'ol/View.js';
import LineString from 'ol/geom/LineString.js';
import Point from 'ol/geom/Point.js';
import Polygon from 'ol/geom/Polygon.js';
import {getWidth} from 'ol/extent.js';
import VectorSource from 'ol/source/Vector.js';
import {frame, renderersSettled} from './settled.js';
import WebGL2VectorLayer from '../../src/layer/WebGL2VectorLayer.js';
import WebGPUVectorLayer from '../../src/layer/WebGPUVectorLayer.js';
import {liveRenderers} from '../../src/renderer/BaseGpuVectorRenderer.js';
import {WorkerClient} from '../../src/worker/client.js';

const params = new URLSearchParams(location.search);
const Layer = params.get('layer') === 'webgpu' ? WebGPUVectorLayer : WebGL2VectorLayer;

/**
 * `&worker=broken`: the worker fails while it has the first build, as when
 * its script cannot be loaded. Everything below must hold all the same.
 */
const brokenWorker = params.get('worker') === 'broken';
if (brokenWorker) {
  (window as any).Worker = class extends EventTarget {
    postMessage(message: {type: string}) {
      if (message.type === 'build') {
        setTimeout(() => this.dispatchEvent(new ErrorEvent('error', {message: 'broken for the test'})));
      }
    }
    terminate() {}
  };
}

/**
 * `&device=late`: the first request for a WebGPU adapter gives none, as
 * while the GPU process of the browser starts again. The layer tries again.
 */
/**
 * `&build=fails`: the worker answers the first build with an error, as when
 * memory is short. The layer makes the build again a second later.
 */
const failingBuild = params.get('build') === 'fails';
if (failingBuild) {
  const RealWorker = window.Worker;
  let failed = false;
  (window as any).Worker = class extends EventTarget {
    private readonly worker: Worker;
    constructor(url: URL, options: WorkerOptions) {
      super();
      this.worker = new RealWorker(url, options);
      this.worker.addEventListener('message', (e) => this.dispatchEvent(new MessageEvent('message', {data: e.data})));
    }
    postMessage(message: {type: string; id: number}, transfer: Transferable[]) {
      if (message.type === 'build' && !failed) {
        failed = true;
        const data = {type: 'build', id: message.id, points: null, lines: null, polygons: null, index: null, engine: 'wasm', timings: {}, error: 'failed for the test'};
        setTimeout(() => this.dispatchEvent(new MessageEvent('message', {data})));
        return;
      }
      this.worker.postMessage(message, transfer);
    }
    terminate() {
      this.worker.terminate();
    }
  };
}

const lateDevice = params.get('device') === 'late';
if (lateDevice) {
  const gpu = navigator.gpu;
  const request = gpu.requestAdapter.bind(gpu);
  let requests = 0;
  gpu.requestAdapter = (options) => (requests++ === 0 ? Promise.resolve(null) : request(options));
}

const named = (geometry: any, name: string, properties: Record<string, unknown> = {}) => new Feature({geometry, name, ...properties});
const square = (x: number, y: number, size: number) => new Polygon([[[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]]);

const style = {
  'fill-color': ['get', 'color'],
  'stroke-color': '#2c3e50',
  'stroke-width': ['get', 'width'],
  'circle-radius': ['get', 'radius'],
  'circle-fill-color': ['get', 'color'],
};
const source = new VectorSource({
  features: [
    named(new Point([40, 25]), 'point', {radius: 8, color: '#d7191c', width: 1}),
    named(new Point([-70, 60]), 'small', {radius: 4, color: '#1a9641', width: 1}),
    named(square(-60, -70, 50), 'poly', {color: '#2c7bb6', width: 2}),
    named(new LineString([[-90, 10], [10, 90], [90, 70]]), 'line', {width: 5, color: '#000000'}),
  ],
});
const layer = new Layer({source, style});
const view = new View({center: [0, 0], resolution: 1});
const map = new Map({target: 'map', pixelRatio: 1, controls: [], layers: [layer], view});

const renderer = () => [...liveRenderers].find((r) => r.getLayer() === (layer as any))!;

const probe = document.createElement('canvas').getContext('2d', {willReadFrequently: true})!;
/** The layer's canvas (read in the task that rendered it). */
function image(): Uint8ClampedArray {
  map.renderSync();
  const canvas = document.querySelector('#map canvas') as HTMLCanvasElement;
  probe.canvas.width = canvas.width;
  probe.canvas.height = canvas.height;
  probe.drawImage(canvas, 0, 0);
  return probe.getImageData(0, 0, canvas.width, canvas.height).data;
}

async function settle() {
  map.render();
  for (let i = 0; i < 3 || !(map.isRendered() && renderersSettled()); i++) {
    await frame();
    if (i > 600) {
      throw new Error('the layer did not settle');
    }
  }
}

const names = (coordinate: number[]) => map.getFeaturesAtPixel(map.getPixelFromCoordinate(coordinate)).map((f) => f.get('name'));

(async () => {
  const results: Record<string, {ok: boolean; detail: string}> = {};
  const check = (name: string, ok: boolean, detail: unknown) => (results[name] = {ok, detail: typeof detail === 'string' ? detail : JSON.stringify(detail)});
  try {
    const firstBuilds = brokenWorker || failingBuild ? 2 : 1;
    if (lateDevice || failingBuild) {
      // meanwhile the layer is ready (it does not hold back rendercomplete) and empty
      // (with a late device the build is made ahead and waits for the device with its buffers)
      for (let i = 0; lateDevice ? !(renderer() as any)?.getDevice?.() : (renderer()?.builds ?? 0) < firstBuilds; i++) {
        await frame();
        if (i > 600) {
          throw new Error('the layer did not try again');
        }
      }
    }
    await settle();
    const first = renderer().builds;
    // without the worker, the build it took with it is made again on the main thread
    check('the first view builds once', first === firstBuilds, {builds: first});
    check('the builds run where expected', WorkerClient.shared().onMainThread === brokenWorker, {onMainThread: WorkerClient.shared().onMainThread});

    view.setCenter([30, 20]);
    await settle();
    check('panning builds nothing', renderer().builds === first, {builds: renderer().builds});

    view.setResolution(0.5);
    await settle();
    check('zooming builds nothing', renderer().builds === first, {builds: renderer().builds});

    const hits = {point: names([40, 25]), beside: names([40, 45]), poly: names([-35, -45]), line: names([10, 90])};
    check(
      'features are hit in the moved view',
      hits.point.join() === 'point' && hits.beside.length === 0 && hits.poly.join() === 'poly' && hits.line.join() === 'line',
      hits,
    );

    // the same view with buffers built for it
    const moved = image();
    layer.setStyle({...style});
    await settle();
    const builtHere = image();
    let drawn = 0;
    let differ = 0;
    for (let i = 0; i < moved.length; i += 4) {
      drawn += builtHere[i + 3] > 0 ? 1 : 0;
      for (let c = 0; c < 4; c++) {
        if (Math.abs(moved[i + c] - builtHere[i + c]) > 8) {
          differ++;
          break;
        }
      }
    }
    check('the moved view is drawn like a new build', renderer().builds === first + 1 && drawn > 3000 && differ === 0, {builds: renderer().builds, drawn, differ});

    const before = renderer().builds;
    source.addFeature(named(new Point([0, -20]), 'added', {radius: 6, color: '#fdae61', width: 1}));
    await settle();
    check('an added feature builds once and is hit', renderer().builds === before + 1 && names([0, -20]).join() === 'added', {
      builds: renderer().builds - before,
      hit: names([0, -20]),
    });

    const feature = source.getFeatures().find((f) => f.get('name') === 'point')!;
    feature.set('radius', 2);
    await settle();
    // 6 px from the centre: inside the old radius of 8, outside the new one of 2 (resolution 0.5)
    check('a changed property is in the new buffers', renderer().builds === before + 2 && names([43, 25]).length === 0 && names([40, 25]).join() === 'point', {
      builds: renderer().builds - before,
      beside: names([43, 25]),
      on: names([40, 25]),
    });

    // a feature that arrives while the view moves does not wait for it to rest
    const moving = renderer().builds;
    view.animate({center: [40, 20], duration: 1500});
    await frame();
    await frame();
    source.addFeature(named(new Point([20, 40]), 'while moving', {radius: 6, color: '#7b3294', width: 1}));
    let builtMoving = false;
    while (view.getAnimating()) {
      await frame();
      builtMoving ||= renderer().builds > moving && renderer().ready && view.getAnimating();
    }
    await settle();
    check('a feature added while the view moves is built before it rests', builtMoving && renderer().builds === moving + 1 && names([20, 40]).join() === 'while moving', {
      builtMoving,
      builds: renderer().builds - moving,
      hit: names([20, 40]),
    });

    // another source: its features and nothing of the one before, and back
    const other = new VectorSource({features: [named(new Point([30, 5]), 'other', {radius: 8, color: '#008837', width: 1})]});
    layer.setSource(other);
    await settle();
    const swapped = {old: names([40, 25]), new: names([30, 5])};
    layer.setSource(null);
    await settle();
    let left = 0;
    const emptied = image();
    for (let i = 3; i < emptied.length; i += 4) {
      left += emptied[i] > 0 ? 1 : 0;
    }
    layer.setSource(source);
    await settle();
    const back = {old: names([40, 25]), new: names([30, 5])};
    check(
      'another source replaces the features',
      swapped.old.length === 0 && swapped.new.join() === 'other' && left === 0 && back.old.join() === 'point' && back.new.length === 0,
      {swapped, 'pixels without a source': left, back},
    );

    // 2^20 px away at this resolution: too far for the floats of this build
    const far = renderer().builds;
    view.setCenter([30 + 2 ** 19, 20]);
    await settle();
    check('a far view builds again', renderer().builds === far + 1, {builds: renderer().builds - far});

    // the same place five worlds to the east: drawn and hit as in the world of the features
    const worldWidth = getWidth(view.getProjection().getExtent());
    view.setCenter([30, 20]);
    await settle();
    const here = image();
    view.setCenter([30 + 5 * worldWidth, 20]);
    await settle();
    const there = image();
    let worldsDrawn = 0;
    let worldsDiffer = 0;
    for (let i = 0; i < here.length; i += 4) {
      worldsDrawn += here[i + 3] > 0 ? 1 : 0;
      for (let c = 0; c < 4; c++) {
        if (Math.abs(here[i + c] - there[i + c]) > 8) {
          worldsDiffer++;
          break;
        }
      }
    }
    const farHits = {point: names([40 + 5 * worldWidth, 25]), beside: names([40 + 5 * worldWidth, 45]), line: names([10 + 5 * worldWidth, 90])};
    check(
      'five worlds away is drawn and hit exactly',
      worldsDrawn > 1000 && worldsDiffer === 0 && farHits.point.join() === 'point' && farHits.beside.length === 0 && farHits.line.join() === 'line',
      {drawn: worldsDrawn, differ: worldsDiffer, farHits},
    );
    view.setCenter([30 + 2 ** 19, 20]);
    await settle();

    // the background of a layer is the colour of its canvas, with the layer's opacity
    const canvases = () => [...document.querySelectorAll('#map canvas')].map((c) => (c as HTMLCanvasElement).style.backgroundColor);
    layer.setBackground('#0000ff');
    await settle();
    const one = canvases();
    const above = new Layer({source: new VectorSource({features: [named(new Point([0, 0]), 'above', {radius: 4, color: '#000000', width: 1})]}), style});
    map.addLayer(above);
    await settle();
    const shared = canvases();
    above.setBackground('rgba(255, 0, 0, 0.5)');
    layer.setOpacity(0.5);
    await settle();
    const two = canvases();
    layer.setVisible(false);
    await settle();
    const hidden = canvases();
    check(
      'a background is the colour of the canvas',
      one.join('|') === 'rgb(0, 0, 255)' && shared.join('|') === 'rgb(0, 0, 255)' && two.join('|') === 'rgba(0, 0, 255, 0.5)|rgba(255, 0, 0, 0.5)' && hidden.join('|') === 'rgba(255, 0, 0, 0.5)',
      {one, shared, two, hidden},
    );
  } catch (e) {
    check('page finished', false, String((e as Error)?.stack ?? e));
  }
  (window as any).__rebuild = results;
})();

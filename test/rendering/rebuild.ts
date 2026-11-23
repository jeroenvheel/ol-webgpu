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
import VectorSource from 'ol/source/Vector.js';
import {frame, renderersSettled} from './settled.js';
import WebGL2VectorLayer from '../../src/layer/WebGL2VectorLayer.js';
import WebGPUVectorLayer from '../../src/layer/WebGPUVectorLayer.js';
import {liveRenderers} from '../../src/renderer/BaseGpuVectorRenderer.js';

const params = new URLSearchParams(location.search);
const Layer = params.get('layer') === 'webgpu' ? WebGPUVectorLayer : WebGL2VectorLayer;

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
    await settle();
    const first = renderer().builds;
    check('the first view builds once', first === 1, {builds: first});

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

    // 2^20 px away at this resolution: too far for the floats of this build
    const far = renderer().builds;
    view.setCenter([30 + 2 ** 19, 20]);
    await settle();
    check('a far view builds again', renderer().builds === far + 1, {builds: renderer().builds - far});
  } catch (e) {
    check('page finished', false, String((e as Error)?.stack ?? e));
  }
  (window as any).__rebuild = results;
})();

/**
 * GPU text when things change (`?layer=webgl2|webgpu`): hit detection of
 * labels, a new layout after panning, zooming, style and data changes, and
 * the layer opacity. Result in window.__labels: {name: {ok, detail}}.
 */
import Feature from 'ol/Feature.js';
import Map from 'ol/Map.js';
import View from 'ol/View.js';
import Point from 'ol/geom/Point.js';
import VectorSource from 'ol/source/Vector.js';
import {frame, renderersSettled} from './settled.js';
import WebGL2VectorLayer from '../../src/layer/WebGL2VectorLayer.js';
import WebGPUVectorLayer from '../../src/layer/WebGPUVectorLayer.js';

const params = new URLSearchParams(location.search);
const Layer = params.get('layer') === 'webgpu' ? WebGPUVectorLayer : WebGL2VectorLayer;

const point = (x: number, y: number, name: string) => new Feature({geometry: new Point([x, y]), name});
const style = (extra: Record<string, unknown> = {}) => ({
  'text-value': ['get', 'name'],
  'text-font': 'bold 14px sans-serif',
  'text-fill-color': '#1b4f72',
  'text-scale': ['var', 'scale'],
  ...extra,
});

const source = new VectorSource({features: [point(0, 0, 'centre'), point(600, 0, 'far east')]});
const layer = new Layer({source, style: style(), variables: {scale: 1}});
// two labels on one spot: the second gives way
const crowded = new Layer({
  source: new VectorSource({features: [point(0, -80, 'first'), point(0, -80, 'second')]}),
  style: {'text-value': ['get', 'name'], 'text-font': '14px sans-serif', 'text-fill-color': '#7b241c'},
  declutter: true,
});
const view = new View({center: [0, 0], resolution: 1});
const map = new Map({target: 'map', pixelRatio: 1, controls: [], layers: [layer, crowded], view});

const probe = document.createElement('canvas').getContext('2d', {willReadFrequently: true})!;
/** Drawn pixels and the highest alpha in a box of the layers' canvas (read in the task that rendered it). */
function drawn(x0 = 0, y0 = 0, x1 = 256, y1 = 256): {count: number; alpha: number; red: number} {
  map.renderSync();
  const canvas = document.querySelector('#map canvas') as HTMLCanvasElement;
  probe.canvas.width = canvas.width;
  probe.canvas.height = canvas.height;
  probe.drawImage(canvas, 0, 0);
  const data = probe.getImageData(x0, y0, x1 - x0, y1 - y0).data;
  let count = 0;
  let alpha = 0;
  let red = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 0) {
      count++;
      alpha = Math.max(alpha, data[i + 3]);
      // straight colours: mostly red
      red += data[i] > 2 * data[i + 2] && data[i + 3] > 128 ? 1 : 0;
    }
  }
  return {count, alpha, red};
}

const quiet = () => map.isRendered() && renderersSettled();
async function settle() {
  map.render();
  for (let i = 0; i < 3 || !quiet(); i++) {
    await frame();
    if (i > 600) {
      throw new Error('labels did not settle');
    }
  }
}

const names = (pixel: number[], hitTolerance = 0) => map.getFeaturesAtPixel(pixel, {hitTolerance}).map((f) => f.get('name'));

(async () => {
  const results: Record<string, {ok: boolean; detail: string}> = {};
  const check = (name: string, ok: boolean, detail: unknown) => {
    results[name] = {ok, detail: JSON.stringify(detail)};
  };
  try {
    await settle();
    const upper = [0, 0, 256, 180] as const; // without the crowded layer's labels
    const first = drawn(...upper);
    check('labels are drawn', first.count > 150 && first.alpha === 255, first);

    check('a label is hit', names([128, 128]).join() === 'centre', names([128, 128]));
    check('beside a label is not hit', names([128, 100]).length === 0, names([128, 100]));
    check('hit tolerance reaches a label', names([128, 142]).length === 0 && names([128, 142], 10).join() === 'centre', [names([128, 142]), names([128, 142], 10)]);
    check('a decluttered label is not hit', names([128, 208]).join() === 'first', names([128, 208]));

    // a feature outside what was laid out comes into view
    view.setCenter([600, 0]);
    await settle();
    const east = drawn(...upper);
    check('labels after panning', east.count > 150 && names([128, 128]).join() === 'far east', {east, hit: names([128, 128])});

    view.setCenter([0, 0]);
    view.setResolution(0.5);
    await settle();
    const zoomed = drawn(...upper);
    check('labels after zooming keep their size', Math.abs(zoomed.count - first.count) <= first.count * 0.05, {first: first.count, zoomed: zoomed.count});
    view.setResolution(1);
    await settle();

    layer.updateStyleVariables({scale: 2});
    await settle();
    const scaled = drawn(...upper);
    check('a style variable changes the labels', scaled.count > first.count * 2.5, {first: first.count, scaled: scaled.count});
    layer.updateStyleVariables({scale: 1});

    layer.setStyle(style({'text-fill-color': '#ff0000'}) as any);
    await settle();
    const red = drawn(...upper);
    check('a new style changes the labels', red.red > 150 && first.red === 0, {before: first.red, after: red.red});

    source.addFeature(point(0, 60, 'added'));
    await settle();
    const added = drawn(...upper);
    check('an added feature gets a label', added.count > red.count * 1.5 && names([128, 68]).join() === 'added', {before: red.count, after: added.count});

    layer.setOpacity(0.5);
    await settle();
    const faint = drawn(...upper);
    check('the layer opacity applies to labels', faint.alpha > 110 && faint.alpha < 145 && faint.count > 150, faint);
    layer.setOpacity(1);

    source.clear();
    await settle();
    const cleared = drawn(...upper);
    check('labels of removed features go away', cleared.count === 0 && names([128, 128]).length === 0, cleared);

    // one of the two crowded labels is shown, and stays the same one
    const crowd = drawn(0, 180, 256, 256);
    check('decluttering shows one of two labels', crowd.count > 40 && crowd.count < 400 && crowd.alpha === 255, crowd);
  } catch (e) {
    check('no error', false, String(e));
  }
  (window as any).__labels = results;
})();

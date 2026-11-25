/**
 * The order features are drawn in (`order.html?layer=webgl2|webgpu`):
 * `z-index` of the style and `renderOrder` of the layer. Result in
 * window.__order: {name: {ok, detail}}.
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

const RED = [215, 25, 28];
const GREEN = [26, 150, 65];
const BLUE = [44, 123, 182];
const css = (c: number[]) => `rgb(${c.join(',')})`;
// three circles on one spot, in this order in the source
const three = (x: number, y: number) =>
  [
    ['red', RED, 2, 30],
    ['green', GREEN, 3, 10],
    ['blue', BLUE, 1, 20],
  ].map(([name, color, z, rank]) => new Feature({geometry: new Point([x, y]), name, color: css(color as number[]), z, rank}));
const circle = {'circle-radius': 12, 'circle-fill-color': ['get', 'color']};

// resolution 1, centre 0,0: the pixel of (X, Y) is (128 + X, 128 - Y)
const asTheyCame = new Layer({source: new VectorSource({features: three(-80, 80)}), style: circle});
const byZIndex = new Layer({source: new VectorSource({features: three(0, 80)}), style: {...circle, 'z-index': ['get', 'z']}});
const byRenderOrder = new Layer({
  source: new VectorSource({features: three(80, 80)}),
  style: circle,
  // the highest rank last, so on top
  renderOrder: (a, b) => a.get('rank') - b.get('rank'),
});
// z-index goes before renderOrder; the two with the same z-index are in render order
const both = new Layer({
  source: new VectorSource({features: three(-80, 0).map((f) => (f.set('z', f.get('name') === 'green' ? 1 : 5), f))}),
  style: {...circle, 'z-index': ['get', 'z']},
  renderOrder: (a, b) => b.get('rank') - a.get('rank'),
});
// styles with a number: the style with the lower one is drawn first, whatever the order of the rules
const rules = new Layer({
  source: new VectorSource({features: three(0, 0)}),
  style: [
    {filter: ['==', ['get', 'name'], 'red'], style: {...circle, 'z-index': 3}},
    {filter: ['==', ['get', 'name'], 'green'], style: {...circle, 'z-index': 1}},
    {filter: ['==', ['get', 'name'], 'blue'], style: {...circle, 'z-index': 2}},
  ],
});
const later = new Layer({source: new VectorSource({features: three(80, 0)}), style: circle});
const map = new Map({target: 'map', pixelRatio: 1, controls: [], layers: [asTheyCame, byZIndex, byRenderOrder, both, rules, later], view: new View({center: [0, 0], resolution: 1})});

(async () => {
  const results: Record<string, {ok: boolean; detail: string}> = {};
  const check = (name: string, ok: boolean, detail: unknown) => (results[name] = {ok, detail: JSON.stringify(detail)});
  const settle = async () => {
    map.render();
    for (let i = 0; i < 5 || !(map.isRendered() && renderersSettled()); i++) {
      await frame();
      if (i > 600) {
        throw new Error('the layers did not settle');
      }
    }
  };
  const probe = document.createElement('canvas').getContext('2d', {willReadFrequently: true})!;
  probe.canvas.width = probe.canvas.height = 256;
  /** The name of the colour on top at a place, and the features there, topmost first. */
  const at = (x: number, y: number) => {
    map.renderSync();
    probe.clearRect(0, 0, 256, 256);
    for (const canvas of document.querySelectorAll('#map canvas')) {
      probe.drawImage(canvas as HTMLCanvasElement, 0, 0);
    }
    const [r, g, b] = probe.getImageData(128 + x, 128 - y, 1, 1).data;
    const near = (c: number[]) => Math.abs(c[0] - r) + Math.abs(c[1] - g) + Math.abs(c[2] - b) < 12;
    const top = near(RED) ? 'red' : near(GREEN) ? 'green' : near(BLUE) ? 'blue' : `${r},${g},${b}`;
    return {top, hits: map.getFeaturesAtPixel([128 + x, 128 - y]).map((f) => f.get('name'))};
  };
  const is = (got: {top: string; hits: string[]}, order: string[]) => got.top === order[0] && got.hits.join() === order.join();
  try {
    await settle();
    const came = at(-80, 80);
    check('features are drawn as they came into the source', is(came, ['blue', 'green', 'red']), came);
    const z = at(0, 80);
    check('a z-index of the style orders the features', is(z, ['green', 'red', 'blue']), z);
    const ranked = at(80, 80);
    check('renderOrder of the layer orders the features', is(ranked, ['red', 'blue', 'green']), ranked);
    const mixed = at(-80, 0);
    check('z-index goes before renderOrder', is(mixed, ['blue', 'red', 'green']), mixed);
    const ruled = at(0, 0);
    // hits are per feature kind in the order of the buffers; what is drawn is in the order of the styles
    check('styles with a number as z-index are drawn in that order', ruled.top === 'red', ruled);

    // another order, and none: the buffers are built again
    later.setRenderOrder((a, b) => b.get('rank') - a.get('rank'));
    await settle();
    const set = at(80, 0);
    later.setRenderOrder(null);
    await settle();
    const unset = at(80, 0);
    check('setRenderOrder orders the features again', is(set, ['green', 'blue', 'red']) && is(unset, ['blue', 'green', 'red']), {set, unset});

    // a feature whose z-index changes moves
    byZIndex.getSource()!.getFeatures().find((f) => f.get('name') === 'blue')!.set('z', 9);
    await settle();
    const moved = at(0, 80);
    check('a changed z-index moves the feature', is(moved, ['blue', 'green', 'red']), moved);
  } catch (e) {
    check('no error', false, String(e));
  }
  (window as any).__order = results;
})();

/**
 * The order features are drawn in (`order.html?layer=webgl2|webgpu`):
 * `z-index` of the style and `renderOrder` of the layer. Result in
 * window.__order: {name: {ok, detail}}.
 */
import Feature from 'ol/Feature.js';
import Map from 'ol/Map.js';
import View from 'ol/View.js';
import LineString from 'ol/geom/LineString.js';
import Point from 'ol/geom/Point.js';
import Polygon from 'ol/geom/Polygon.js';
import VectorSource from 'ol/source/Vector.js';
import {frame, renderersSettled} from './settled.js';
import {liveRenderers} from '../../src/renderer/BaseGpuVectorRenderer.js';
import WebGL2VectorLayer from '../../src/layer/WebGL2VectorLayer.js';
import WebGPUVectorLayer from '../../src/layer/WebGPUVectorLayer.js';

// the layer with more numbers than are drawn one by one says so
const warned: string[] = [];
const warn = console.warn;
console.warn = (...args: unknown[]) => {
  if (String(args[0]).includes('z-index')) {
    warned.push(String(args[0]));
  } else {
    warn(...args);
  }
};

const params = new URLSearchParams(location.search);
const Layer = params.get('layer') === 'webgpu' ? WebGPUVectorLayer : WebGL2VectorLayer;

// for the frame times; fewer where drawing is slow (software rendering in CI)
const POINTS = Number(params.get('points') ?? 300_000);
// how many frames are timed: fewer where a frame takes a quarter of a second
const FRAMES = Number(params.get('frames') ?? 60);
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
// A fill, a stroke and a symbol on one spot. Kind by kind the symbol is on top and the
// fill at the bottom; by z-index the fill (3) is over the stroke (2) over the symbol (1).
const kinds = (x: number, y: number, z: {fill: number; stroke: number; symbol: number}) => [
  new Feature({
    geometry: new Polygon([[[x - 20, y - 20], [x + 20, y - 20], [x + 20, y + 20], [x - 20, y + 20], [x - 20, y - 20]]]),
    name: 'fill',
    color: css(RED),
    z: z.fill,
  }),
  new Feature({geometry: new LineString([[x - 30, y], [x + 30, y]]), name: 'stroke', color: css(BLUE), z: z.stroke}),
  new Feature({geometry: new Point([x, y]), name: 'symbol', color: css(GREEN), z: z.symbol}),
];
const kindStyle = {
  'fill-color': ['get', 'color'],
  'stroke-color': ['get', 'color'],
  'stroke-width': 12,
  'circle-radius': 10,
  'circle-fill-color': ['get', 'color'],
};
const acrossKinds = new Layer({source: new VectorSource({features: kinds(-70, -80, {fill: 3, stroke: 2, symbol: 1})}), style: {...kindStyle, 'z-index': ['get', 'z']}});
const withoutZ = new Layer({source: new VectorSource({features: kinds(0, -80, {fill: 3, stroke: 2, symbol: 1})}), style: kindStyle});
// the same with a renderOrder and no z-index: the features are drawn one after the other, as on a Canvas
const byOrderAcross = new Layer({
  source: new VectorSource({features: kinds(0, -37, {fill: 3, stroke: 2, symbol: 1})}),
  style: kindStyle,
  renderOrder: (a, b) => a.get('z') - b.get('z'),
});
// more different numbers than are drawn one by one: kind by kind again, in the order of the numbers within a kind
const manyZ = new Layer({
  source: new VectorSource({
    features: [...kinds(70, -80, {fill: 300, stroke: 200, symbol: 100}), ...Array.from({length: 80}, (_v, i) => new Feature({geometry: new Point([400 + i, 400]), name: `far${i}`, color: css(RED), z: i}))],
  }),
  style: {...kindStyle, 'z-index': ['get', 'z']},
});
const map = new Map({target: 'map', pixelRatio: 1, controls: [], layers: [asTheyCame, byZIndex, byRenderOrder, both, rules, later, acrossKinds, withoutZ, byOrderAcross, manyZ], view: new View({center: [0, 0], resolution: 1})});

(async () => {
  const results: Record<string, any> = {};
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

    // a z-index orders fills, strokes and symbols among each other
    const across = {centre: at(-70, -80), onStroke: at(-70 + 28, -80), onFill: at(-70, -80 + 15)};
    const kindByKind = {centre: at(0, -80), onStroke: at(28, -80)};
    const many = {centre: at(70, -80), onStroke: at(70 + 28, -80)};
    check(
      'a z-index puts a fill over the stroke and the symbol of a lower one',
      across.centre.hits.join() === 'fill,stroke,symbol' && across.centre.top === 'red' && across.onStroke.top === 'blue' && across.onFill.top === 'red',
      {...across, levels: ([...liveRenderers].find((r) => r.getLayer() === (acrossKinds as any)) as any)?.buffers?.levels ?? null},
    );
    check('without a z-index symbols are over strokes over fills', kindByKind.centre.top === 'green' && kindByKind.centre.hits.join() === 'symbol,stroke,fill' && kindByKind.onStroke.top === 'blue', kindByKind);
    const ordered = {centre: at(0, -37), onStroke: at(28, -37), onFill: at(0, -37 + 15)};
    check(
      'a renderOrder puts a fill over the stroke and the symbol of an earlier feature',
      ordered.centre.hits.join() === 'fill,stroke,symbol' && ordered.centre.top === 'red' && ordered.onStroke.top === 'blue' && ordered.onFill.top === 'red',
      ordered,
    );
    check('with more than 64 different numbers the kinds are drawn one after the other', many.centre.top === 'green' && many.centre.hits.join() === 'symbol,stroke,fill', many);
    check('and the layer warns about it once, with the count', warned.length === 1 && warned[0].includes('83 different numbers'), warned);

    // a symbol that changes its z-index goes over the fill
    acrossKinds.getSource()!.getFeatures().find((f) => f.get('name') === 'symbol')!.set('z', 5);
    await settle();
    const lifted = at(-70, -80);
    check('a changed z-index moves a symbol over a fill', lifted.top === 'green' && lifted.hits.join() === 'symbol,fill,stroke', lifted);

    // with symbols that are placed: one that lost its place is left out of the buffer, and the parts move with it
    const placed = new Layer({
      source: new VectorSource({
        features: [
          new Feature({geometry: new Point([-70, -20]), name: 'first', color: css(GREEN), z: 1}),
          new Feature({geometry: new Point([-64, -20]), name: 'second', color: css(BLUE), z: 1}), // no room next to the first
          ...kinds(70, -20, {fill: 3, stroke: 2, symbol: 5}),
        ],
      }),
      style: {...kindStyle, 'circle-declutter-mode': 'declutter', 'z-index': ['get', 'z']},
      declutter: true,
    });
    map.addLayer(placed);
    await settle();
    const declutter = {first: at(-78, -20), second: at(-56, -20), symbol: at(70, -20), fill: at(70, -20 + 15)};
    check(
      'drawn by z-index with symbols that are placed',
      declutter.first.top === 'green' && declutter.second.hits.length === 0 && declutter.symbol.top === 'green' && declutter.symbol.hits.join() === 'symbol,fill,stroke' && declutter.fill.top === 'red',
      declutter,
    );
    map.removeLayer(placed);

    // what drawing by z-index costs: frames of a view that moves, with 300 000 points of 10 numbers and of one
    const frames = async (numbers: number) => {
      const many = new Layer({
        source: new VectorSource({
          features: Array.from({length: POINTS}, (_v, i) => new Feature({geometry: new Point([(i % 600) - 300, Math.floor(i / 600) - 250]), color: css(RED), z: i % numbers})),
          useSpatialIndex: false,
        }),
        style: {'circle-radius': 2, 'circle-fill-color': ['get', 'color'], 'z-index': ['get', 'z']},
        disableHitDetection: true,
      });
      map.addLayer(many);
      await settle();
      const levels = ([...liveRenderers].find((r) => r.getLayer() === (many as any)) as any)?.buffers?.levels?.length ?? 0;
      const view = map.getView();
      const times: number[] = [];
      let last = performance.now();
      for (let i = 0; i < FRAMES; i++) {
        view.setCenter([i % 2, 0]);
        await frame();
        const now = performance.now();
        times.push(now - last);
        last = now;
      }
      view.setCenter([0, 0]);
      map.removeLayer(many);
      many.dispose();
      await settle();
      times.sort((a, b) => a - b);
      return {levels, median: Math.round(times[times.length >> 1] * 10) / 10, slowest: Math.round(times[times.length - 1])};
    };
    results.times = {one: await frames(1), ten: await frames(10), sixty: await frames(60)};

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

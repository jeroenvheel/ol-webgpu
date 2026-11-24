/**
 * Hit-detection scenario (`picking.html?layer=ol|webgl2|webgpu`): known
 * features at known pixels; results exposed as `window.__pick`.
 */
import 'ol/ol.css';
import Feature from 'ol/Feature.js';
import Map from 'ol/Map.js';
import View from 'ol/View.js';
import LineString from 'ol/geom/LineString.js';
import Point from 'ol/geom/Point.js';
import Polygon from 'ol/geom/Polygon.js';
import VectorSource from 'ol/source/Vector.js';
import Layer from './layer.js';

const f = (id: string, geometry: any, props: Record<string, unknown> = {}) => {
  const feature = new Feature({geometry, ...props});
  feature.setId(id);
  return feature;
};

// view: resolution 1, center 0,0 → pixel (x, y) = (128 + X, 128 - Y)
const source = new VectorSource({
  features: [
    f('poly', new Polygon([[[0, 0], [60, 0], [60, -60], [0, -60], [0, 0]], [[20, -20], [40, -20], [40, -40], [20, -40], [20, -20]]]), {width: 2}),
    f('line', new LineString([[-100, -80], [100, -80]]), {width: 6}),
    f('point', new Point([-50, 50]), {size: 10}),
    f('hidden', new Point([60, 60]), {size: 10, hidden: 1}),
    f('big', new Point([-50, -30]), {size: 20}),
  ],
});

const layer = new Layer({
  source,
  style: {
    filter: ['!=', ['get', 'hidden'], 1],
    'fill-color': '#ff000080',
    'stroke-color': '#0000ff',
    'stroke-width': ['get', 'width'],
    'circle-radius': ['get', 'size'],
    'circle-fill-color': '#00ff00',
  },
});

// a second layer: each layer has its own hit index
const other = new Layer({
  source: new VectorSource({features: [f('other', new Point([100, -110]), {})]}),
  style: {'circle-radius': 8, 'circle-fill-color': '#ff00ff'},
});

// Symbols and strokes that are not drawn on their geometry, around [5000, 0].
const displaced = new Layer({
  source: new VectorSource({
    features: [f('displaced', new Point([4940, 60]), {}), f('offset line', new LineString([[4900, -40], [5100, -40]]), {})],
  }),
  style: {
    'circle-radius': 6,
    'circle-fill-color': '#00ff00',
    'circle-displacement': [20, 10],
    'stroke-color': '#0000ff',
    'stroke-width': 4,
    'stroke-offset': 10,
  },
});
const pinImage = document.createElement('canvas');
pinImage.width = 20;
pinImage.height = 40;
const pinContext = pinImage.getContext('2d')!;
pinContext.fillStyle = '#ff0000';
pinContext.fillRect(0, 0, 20, 40);
const pins = new Layer({
  source: new VectorSource({features: [f('pin', new Point([5060, 20]), {})]}),
  // the point is at the middle of the bottom edge
  style: {'icon-src': pinImage.toDataURL(), 'icon-anchor': [0.5, 1]},
});
// A symbol that reaches further than 128 px, around [10000, 0].
const huge = new Layer({
  source: new VectorSource({features: [f('huge', new Point([10000, 0]), {size: 150})]}),
  style: {'circle-radius': ['get', 'size'], 'circle-fill-color': '#00ff0080'},
});

// A point with a label below it, for a view that shows the world more than once.
const wrapped = new Layer({
  source: new VectorSource({features: [f('wrapped', new Point([0, 0]), {})]}),
  style: {
    'circle-radius': 5,
    'circle-fill-color': '#ff00ff',
    'text-value': 'wrapped',
    'text-font': '12px sans-serif',
    'text-fill-color': '#000000',
    'text-offset-y': 30,
  },
});

const view = new View({center: [0, 0], resolution: 1, multiWorld: true, maxResolution: 40075016.68557849 / 100});
const map = new Map({target: 'map', layers: [layer, other, displaced, pins, huge, wrapped], view, pixelRatio: 1});

const settled = () => new Promise<void>((resolve) => {
  const check = () => {
    if ((window as any).__olgpuSettled() && map.isRendered()) {
      // one more frame so ol's own hit buffer is drawn as well
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    } else {
      setTimeout(check, 50);
    }
  };
  check();
});

const at = (x: number, y: number, hitTolerance = 0) => {
  const ids: string[] = [];
  map.forEachFeatureAtPixel([128 + x, 128 - y], (feature) => {
    ids.push(String(feature.getId()));
  }, {hitTolerance});
  return ids;
};

(async () => {
  await settled();
  const results: Record<string, string[]> = {
    'point center': at(-50, 50),
    'point inside radius (8px)': at(-42, 50),
    'point outside radius (13px)': at(-37, 50),
    'point outside, within hitTolerance 5': at(-37, 50, 5),
    'polygon fill': at(10, -10),
    'polygon hole': at(30, -30),
    'line on axis': at(-90, -80),
    'line within half width (2px)': at(-90, -78),
    'line outside half width (5px)': at(-90, -75),
    'filtered-out feature': at(60, 60),
    'empty space': at(100, 100),
    'big point overlapping polygon edge': at(-32, -30),
    'point of a second layer': at(100, -110),
  };
  view.setRotation(Math.PI / 4);
  await settled();
  const c = Math.SQRT1_2;
  // the view rotation turns world coordinates by -45° on screen: (-50, 50) lands at (0, 50√2)
  results['rotated view: point'] = at(0, Math.round(50 * 2 * c));
  view.setRotation(0);
  view.setCenter([-40, 0]);
  await settled();
  results['panned view: point'] = at(-10, 50);

  view.setCenter([5000, 0]);
  await settled();
  results['displaced circle: where it is drawn'] = at(-40, 70);
  results['displaced circle: at its point'] = at(-60, 60);
  results['stroke with an offset: where it is drawn'] = at(0, -50);
  results['stroke with an offset: on the line'] = at(0, -40);
  results['icon anchored at its bottom: in the icon'] = at(60, 50);
  results['icon anchored at its bottom: below the point'] = at(60, 8);
  view.setRotation(Math.PI / 2);
  await settled();
  // the point (-60, 60) lands at (60, 60) on screen; the displacement is in screen pixels
  results['displaced circle, rotated view'] = at(80, 70);
  results['displaced circle, rotated view: at its point'] = at(60, 60);
  view.setRotation(0);
  view.setCenter([10000, 0]);
  await settled();
  results['a symbol of 150 px, 140 px from its point'] = at(99, 99);
  results['a symbol of 150 px, 160 px from its point'] = at(113, 113);

  // the world is 100 px wide: the point is at the centre and 100 px to both sides
  view.setCenter([0, 0]);
  view.setResolution(40075016.68557849 / 100);
  await settled();
  const only = (x: number, y: number) => {
    const ids: string[] = [];
    map.forEachFeatureAtPixel(
      [128 + x, 128 - y],
      (feature) => {
        ids.push(String(feature.getId()));
      },
      {layerFilter: (l) => l === wrapped},
    );
    return ids;
  };
  results['several worlds: the point'] = only(0, 0);
  results['several worlds: the point in the next world'] = only(100, 0);
  results['several worlds: between the points'] = only(50, 0);
  results['several worlds: the label'] = only(0, -30);
  results['several worlds: the label in the next world'] = only(-100, -30);
  results['several worlds: layer.getFeatures() in the next world'] = await (async () => (await wrapped.getFeatures([228, 128])).map((feature: any) => String(feature.getId())))().catch(() => ['not implemented']);
  (window as any).__pick = results;
})();

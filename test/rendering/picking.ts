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

const view = new View({center: [0, 0], resolution: 1});
const map = new Map({target: 'map', layers: [layer, other], view, pixelRatio: 1});

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
  (window as any).__pick = results;
})();

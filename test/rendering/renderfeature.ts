/**
 * The same scene built from `ol/Feature` or from `ol/render/Feature`
 * (RenderFeature, what vector tile formats produce):
 * `?layer=webgl2|webgpu&kind=feature|render&text=gpu|canvas`.
 * The runner screenshots both kinds and compares them; `window.__renderFeature`
 * is set when the map has settled, with the ids picked at known pixels and
 * whether every picked feature is of the kind the scene was built from.
 *
 * The RenderFeatures are made as ol/format/MVT makes them (renderFeatures.ts).
 */
import Feature from 'ol/Feature.js';
import Map from 'ol/Map.js';
import View from 'ol/View.js';
import LineString from 'ol/geom/LineString.js';
import MultiLineString from 'ol/geom/MultiLineString.js';
import MultiPoint from 'ol/geom/MultiPoint.js';
import MultiPolygon from 'ol/geom/MultiPolygon.js';
import Point from 'ol/geom/Point.js';
import Polygon from 'ol/geom/Polygon.js';
import RenderFeature from 'ol/render/Feature.js';
import VectorSource from 'ol/source/Vector.js';
import Layer from './layer.js';
import {toRenderFeature} from './renderFeatures.js';
import {frame, renderersSettled} from './settled.js';

const params = new URLSearchParams(location.search);
const kind = params.get('kind') ?? 'feature';

type Ring = number[][];
const square = (x0: number, y0: number, x1: number, y1: number, clockwise = false): Ring =>
  clockwise
    ? [[x0, y0], [x0, y1], [x1, y1], [x1, y0], [x0, y0]]
    : [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];

interface Shape {
  id: string;
  type: 'Point' | 'MultiPoint' | 'LineString' | 'MultiLineString' | 'Polygon' | 'MultiPolygon';
  coordinates: any;
  properties?: Record<string, unknown>;
}

// view: resolution 1, center 0,0 → pixel (x, y) = (128 + X, 128 - Y)
const shapes: Shape[] = [
  {id: 'poly', type: 'Polygon', coordinates: [square(-115, 25, -25, 115), square(-105, 85, -85, 105, true)], properties: {name: 'Polygon', label: 1, below: 0}},
  {id: 'multi', type: 'MultiPolygon', coordinates: [[square(25, 25, 60, 60)], [square(75, 25, 115, 60), square(85, 35, 105, 50, true)]], properties: {label: 0, below: 0}},
  {id: 'line', type: 'LineString', coordinates: [[-115, -25], [-40, -5], [40, -25], [115, -5]], properties: {name: 'Along the line', label: 2, below: 0}},
  {id: 'mline', type: 'MultiLineString', coordinates: [[[-115, -60], [-15, -60]], [[15, -60], [115, -60]]], properties: {name: 'two', label: 1, below: 0}},
  {id: 'pt', type: 'Point', coordinates: [-80, -100], properties: {name: 'Point', label: 1, below: 1}},
  {id: 'mpt', type: 'MultiPoint', coordinates: [[20, -100], [60, -100], [100, -100]], properties: {label: 0, below: 0}},
];

function toFeature(s: Shape): Feature {
  const Geometry: any = {Point, MultiPoint, LineString, MultiLineString, Polygon, MultiPolygon}[s.type];
  const feature = new Feature({geometry: new Geometry(s.coordinates), ...s.properties});
  feature.setId(s.id);
  return feature;
}

const features: any[] = kind === 'render' ? shapes.map((s) => toRenderFeature(toFeature(s))) : shapes.map(toFeature);
const source = new VectorSource<any>({features});

const label = {
  'text-value': ['get', 'name'],
  'text-font': 'bold 12px sans-serif',
  'text-fill-color': '#1c2833',
  'text-stroke-color': '#ffffff',
  'text-stroke-width': 3,
  'text-offset-y': ['*', ['get', 'below'], 16],
};
const layer = new Layer({
  source,
  style: [
    {
      style: {
        'fill-color': '#ff000080',
        'stroke-color': '#1f618d',
        'stroke-width': 3,
        'circle-radius': 7,
        'circle-fill-color': '#27ae60',
        'circle-stroke-color': '#145a32',
        'circle-stroke-width': 1,
      },
    },
    // label: 0 none, 1 at a point, 2 along the line (ol's style compiler takes text-placement only as a literal)
    {filter: ['==', ['get', 'label'], 1], style: label},
    {filter: ['==', ['get', 'label'], 2], style: {...label, 'text-placement': 'line'}},
  ],
});
const map = new Map({target: 'map', layers: [layer], controls: [], pixelRatio: 1, view: new View({center: [0, 0], resolution: 1})});

const settled = () => map.isRendered() && renderersSettled();

const at = (x: number, y: number) => {
  const ids: string[] = [];
  const kinds: boolean[] = [];
  map.forEachFeatureAtPixel([128 + x, 128 - y], (feature) => {
    ids.push(String(feature.getId()));
    kinds.push(kind === 'render' ? feature instanceof RenderFeature : feature instanceof Feature);
  });
  return {ids, kinds};
};

(async () => {
  for (let i = 0; i < 6 || !settled(); i++) {
    await frame();
  }
  await new Promise((r) => setTimeout(r, 300)); // label fades
  for (let i = 0; i < 2 || !settled(); i++) {
    await frame();
  }
  const probes: Record<string, number[]> = {
    'polygon fill': [-110, 30],
    'polygon hole': [-95, 95],
    'multipolygon, first part': [30, 30],
    'multipolygon, second part': [110, 30],
    'multipolygon, hole': [95, 42],
    'line vertex': [-40, -5],
    'multilinestring, second part': [100, -60],
    'point': [-80, -100],
    'multipoint, third point': [100, -100],
    'label of the point': [-80, -116],
    'empty space': [0, 100],
  };
  const picks: Record<string, string[]> = {};
  let ofKind = true;
  for (const [name, [x, y]] of Object.entries(probes)) {
    const r = at(x, y);
    picks[name] = r.ids;
    ofKind &&= r.kinds.every(Boolean);
  }
  (window as any).__renderFeature = {picks, ofKind, count: source.getFeatures().length};
})();

/**
 * GPU text (`text: 'gpu'`) against ol's Canvas vector layer, which it is
 * meant to match: `?layer=canvas|webgl2|webgpu&scenario=<name>`.
 * The runner screenshots each and compares. `window.__gpuText` is set when
 * the map has settled, with {labels: feature names found at the probe pixels}.
 */
import Feature from 'ol/Feature.js';
import Map from 'ol/Map.js';
import View from 'ol/View.js';
import LineString from 'ol/geom/LineString.js';
import Point from 'ol/geom/Point.js';
import Polygon from 'ol/geom/Polygon.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import {frame, renderersSettled} from './settled.js';
import WebGL2VectorLayer from '../../src/layer/WebGL2VectorLayer.js';
import WebGPUVectorLayer from '../../src/layer/WebGPUVectorLayer.js';

const params = new URLSearchParams(location.search);
const kind = params.get('layer') ?? 'webgl2';
const scenario = params.get('scenario') ?? 'styles';

interface Scenario {
  features: Feature[];
  style: any;
  view?: {center?: number[]; resolution?: number; rotation?: number};
  declutter?: boolean;
  /** Pixels to probe with getFeaturesAtPixel. */
  probes?: number[][];
  fonts?: string[];
}

const point = (x: number, y: number, properties: Record<string, unknown> = {}) => new Feature({geometry: new Point([x, y]), ...properties});

const scenarios: Record<string, () => Scenario> = {
  // alignment, baseline, offsets, rotation, scale, background and padding
  styles: () => ({
    features: [
      point(-70, 80, {name: 'left', align: 'left', baseline: 'top'}),
      point(0, 80, {name: 'center', align: 'center', baseline: 'middle'}),
      point(70, 80, {name: 'right', align: 'right', baseline: 'bottom'}),
      point(-60, 20, {name: 'rotated', rotation: 0.6}),
      point(40, 20, {name: 'with view', rotateWithView: true}),
      point(-60, -50, {name: 'Scaled', scale: 1.8}),
      point(50, -50, {name: 'box', background: true}),
      point(0, -95, {name: 'offset', offsetX: 20, offsetY: -8}),
    ],
    style: {
      'text-value': ['get', 'name'],
      'text-font': 'bold 13px sans-serif',
      'text-fill-color': '#1b4f72',
      'text-stroke-color': '#ffffff',
      'text-stroke-width': 3,
      'text-align': ['coalesce', ['get', 'align'], 'center'],
      'text-baseline': ['coalesce', ['get', 'baseline'], 'middle'],
      'text-rotation': ['coalesce', ['get', 'rotation'], 0],
      'text-rotate-with-view': ['coalesce', ['get', 'rotateWithView'], false],
      'text-scale': ['coalesce', ['get', 'scale'], 1],
      'text-offset-x': ['coalesce', ['get', 'offsetX'], 0],
      'text-offset-y': ['coalesce', ['get', 'offsetY'], 0],
      'text-padding': [2, 4, 2, 4],
      'text-background-fill-color': ['case', ['coalesce', ['get', 'background'], false], '#f9e79f', 'rgba(0,0,0,0)'],
      'text-background-stroke-color': ['case', ['coalesce', ['get', 'background'], false], '#7d6608', 'rgba(0,0,0,0)'],
      'text-background-stroke-width': 1,
    },
    view: {rotation: 0.3},
  }),
  // several lines, justified, with a halo, and a second style per feature
  multiline: () => ({
    features: [point(-60, 50, {name: 'two\nlines here', justify: 'left'}), point(60, 50, {name: 'right\njustified text', justify: 'right'}), point(0, -40, {name: 'Centred\nover three\nlines', justify: 'center'})],
    style: [
      {
        'text-value': ['get', 'name'],
        'text-font': '14px sans-serif',
        'text-fill-color': '#7b241c',
        'text-stroke-color': 'rgba(255,255,255,0.9)',
        'text-stroke-width': 2,
        'text-justify': ['get', 'justify'],
      },
      {
        'text-value': 'second',
        'text-font': 'italic 10px serif',
        'text-fill-color': '#145a32',
        'text-offset-y': 44,
      },
    ],
    // on a label, beside it, and on the second style's label
    probes: [
      [68, 78],
      [128, 20],
      [128, 212],
    ],
  }),
  // text along lines: curved, reversed (kept upright), repeated, and too short for its text
  line: () => {
    const curve = (y: number, reverse = false) => {
      const coordinates = [];
      for (let x = -110; x <= 110; x += 10) {
        coordinates.push([x, y + 18 * Math.sin(x / 35)]);
      }
      return reverse ? coordinates.reverse() : coordinates;
    };
    return {
      features: [
        new Feature({geometry: new LineString(curve(80)), name: 'Along a curved line'}),
        new Feature({geometry: new LineString(curve(20, true)), name: 'Kept upright when reversed'}),
        new Feature({
          geometry: new LineString([
            [-110, -40],
            [110, -60],
          ]),
          name: 'again',
          repeat: 70,
        }),
        new Feature({
          geometry: new LineString([
            [-20, -100],
            [0, -100],
          ]),
          name: 'does not fit on this line',
        }),
      ],
      style: {
        'stroke-color': '#aab7b8',
        'stroke-width': 1,
        'text-value': ['get', 'name'],
        'text-font': '12px sans-serif',
        'text-placement': 'line',
        'text-fill-color': '#1a5276',
        'text-stroke-color': '#ffffff',
        'text-stroke-width': 3,
        'text-repeat': ['coalesce', ['get', 'repeat'], 0],
      },
    };
  },
  // rotated view: line labels turn with the map
  lineRotated: () => ({...scenarios.line(), view: {rotation: 2.2}}),
  // polygon labels: at the interior point, hidden when wider than the polygon unless overflowing
  polygon: () => {
    const box = (x: number, y: number, w: number, h: number) =>
      new Polygon([
        [
          [x, y],
          [x + w, y],
          [x + w, y + h],
          [x, y + h],
          [x, y],
        ],
      ]);
    return {
      features: [
        new Feature({geometry: box(-110, 20, 100, 70), name: 'fits', overflow: false}),
        new Feature({geometry: box(20, 20, 30, 70), name: 'too wide to fit', overflow: false}),
        new Feature({geometry: box(-110, -90, 30, 70), name: 'overflows', overflow: true}),
        new Feature({
          geometry: new Polygon([
            [
              [20, -90],
              [110, -90],
              [110, -20],
              [80, -20],
              [80, -70],
              [20, -70],
              [20, -90],
            ],
          ]),
          name: 'L',
          overflow: false,
        }),
      ],
      style: {
        'fill-color': '#d6eaf8',
        'stroke-color': '#2e86c1',
        'stroke-width': 1,
        'text-value': ['get', 'name'],
        'text-font': '12px sans-serif',
        'text-fill-color': '#17202a',
        'text-overflow': ['get', 'overflow'],
      },
    };
  },
  // labels that overlap: a later label, or one with a higher z-index, covers the text below it
  overlap: () => ({
    features: [
      point(-40, 60, {name: 'First label', box: true}),
      point(-10, 68, {name: 'Second label', box: true}),
      point(20, 76, {name: 'Third label', box: true}),
      point(-40, 0, {name: 'Halo below'}),
      point(-20, 6, {name: 'Halo on top'}),
      point(-30, -60, {name: 'Raised', box: true, z: 2}),
      point(-10, -52, {name: 'Lower, added later', box: true, z: 1}),
    ],
    style: {
      'text-value': ['get', 'name'],
      'text-font': 'bold 16px sans-serif',
      'text-fill-color': '#1c2833',
      'text-stroke-color': '#ffffff',
      'text-stroke-width': 4,
      'text-padding': [3, 5, 3, 5],
      'text-background-fill-color': ['case', ['coalesce', ['get', 'box'], false], '#ffffff', 'rgba(0,0,0,0)'],
      'text-background-stroke-color': ['case', ['coalesce', ['get', 'box'], false], '#333333', 'rgba(0,0,0,0)'],
      'z-index': ['coalesce', ['get', 'z'], 0],
    },
  }),
  // a grid of labels too dense to show all
  declutter: () => {
    const features: Feature[] = [];
    for (let i = 0; i < 400; i++) {
      features.push(point(((i % 20) - 9.5) * 12, (Math.floor(i / 20) - 9.5) * 12, {name: `n${i}`}));
    }
    return {
      features,
      style: {'text-value': ['get', 'name'], 'text-font': '11px sans-serif', 'text-fill-color': '#000000', 'text-stroke-color': '#ffffff', 'text-stroke-width': 2},
      declutter: true,
    };
  },
  // the same label in several world copies
  wrap: () => ({
    features: [point(0, 0, {name: 'origin'}), point(15e6, 3e6, {name: 'east'}), point(-15e6, -3e6, {name: 'west'})],
    style: {'text-value': ['get', 'name'], 'text-font': 'bold 12px sans-serif', 'text-fill-color': '#6c3483', 'text-stroke-color': '#ffffff', 'text-stroke-width': 2},
    view: {center: [15e6, 0], resolution: 400000},
  }),
  // a font from the @font-face of the page (the text worker of ol cannot use it)
  webfont: () => ({
    features: [point(0, 30, {name: 'Ubuntu web font'}), point(0, -30, {name: 'Æble, Zürich, Łódź'})],
    style: {'text-value': ['get', 'name'], 'text-font': '20px Ubuntu', 'text-fill-color': '#b03a2e', 'text-stroke-color': '#fdfefe', 'text-stroke-width': 3},
    fonts: ['20px Ubuntu'],
  }),
  // scripts that need shaping: right-to-left and combining marks
  scripts: () => ({
    features: [point(0, 60, {name: 'مرحبا بالعالم'}), point(0, 10, {name: 'שלום עולם'}), point(0, -40, {name: 'नमस्ते दुनिया'}), point(0, -90, {name: 'Latin fallback'})],
    style: {'text-value': ['get', 'name'], 'text-font': '18px sans-serif', 'text-fill-color': '#0b5345', 'text-stroke-color': '#ffffff', 'text-stroke-width': 2},
  }),
};

const s = scenarios[scenario]();
const source = new VectorSource({features: s.features});
const Layer: any = kind === 'canvas' ? VectorLayer : kind === 'webgpu' ? WebGPUVectorLayer : WebGL2VectorLayer;
const layer = new Layer({source, style: s.style, declutter: s.declutter, ...(kind === 'canvas' ? {} : {text: 'gpu'})});
const map = new Map({
  target: 'map',
  layers: [layer],
  controls: [],
  view: new View({center: s.view?.center ?? [0, 0], resolution: s.view?.resolution ?? 1, rotation: s.view?.rotation ?? 0}),
});
(window as any).map = map;

const settled = () => map.isRendered() && renderersSettled();

(async () => {
  await Promise.all((s.fonts ?? []).map((font) => document.fonts.load(font)));
  await document.fonts.ready;
  layer.changed();
  for (let i = 0; i < 6 || !settled(); i++) {
    await frame();
  }
  await new Promise((r) => setTimeout(r, 300)); // fades, and a layout after fonts loaded
  for (let i = 0; i < 2 || !settled(); i++) {
    await frame();
  }
  map.renderSync();
  const labels = (s.probes ?? []).map((pixel) => map.getFeaturesAtPixel(pixel).map((f) => f.get('name')));
  (window as any).__gpuText = {labels};
})();

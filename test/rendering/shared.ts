/**
 * Shared canvases (`?layer=ol|webgl2|webgpu`): layers 1 and 2 share a canvas,
 * the canvas layer 3 sits between them and layer 4, which gets its own. Layer
 * 2 has opacity 0.5 and two overlapping squares: the opacity applies to the
 * layer as a whole, so the overlap must look like the rest of the layer.
 * The runner compares the screenshot with ol's WebGLVector layers (`ol`);
 * `&antialias=1` covers the multisampled paths (edges then differ a little).
 * Result in window.__shared: {canvases, elements}.
 */
import Feature from 'ol/Feature.js';
import Map from 'ol/Map.js';
import View from 'ol/View.js';
import Polygon from 'ol/geom/Polygon.js';
import VectorLayer from 'ol/layer/Vector.js';
import WebGLVectorLayer from 'ol/layer/WebGLVector.js';
import VectorSource from 'ol/source/Vector.js';
import Fill from 'ol/style/Fill.js';
import Style from 'ol/style/Style.js';
import {frame, renderersSettled} from './settled.js';
import WebGL2VectorLayer from '../../src/layer/WebGL2VectorLayer.js';
import WebGPUVectorLayer from '../../src/layer/WebGPUVectorLayer.js';

const params = new URLSearchParams(location.search);
const kind = params.get('layer') ?? 'webgl2';
const antialias = params.get('antialias') === '1';
const Layer: any = kind === 'webgpu' ? WebGPUVectorLayer : kind === 'ol' ? WebGLVectorLayer : WebGL2VectorLayer;

const square = (x: number, y: number, size: number) =>
  new Feature(new Polygon([[[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]]));
const gpu = (features: Feature[], color: string, opacity = 1) =>
  new Layer({source: new VectorSource({features}), opacity, antialias, style: {'fill-color': color}});

const layers = [
  gpu([square(-100, -100, 120)], '#d7191c'),
  gpu([square(-60, -60, 100), square(-20, -20, 100)], '#2c7bb6', 0.5),
  new VectorLayer({source: new VectorSource({features: [square(10, -110, 60)]}), style: new Style({fill: new Fill({color: '#1a9641'})})}),
  gpu([square(30, -80, 70)], '#fdae61'),
];
const map = new Map({target: 'map', pixelRatio: 1, controls: [], layers, view: new View({center: [0, 0], resolution: 1})});

(async () => {
  // rendercomplete waits for every layer to be ready (renderers only exist after the first frame)
  await new Promise((r) => map.once('rendercomplete', r));
  while (kind !== 'ol' && !renderersSettled()) {
    await frame();
  }
  await frame();
  await frame();
  // one element per canvas in map order (ol's canvas layer is a div holding its canvas)
  const children = [...document.querySelector('#map .ol-layers')!.children] as HTMLElement[];
  (window as any).__shared = {canvases: children.length, elements: children.map((c) => c.tagName.toLowerCase())};
})();

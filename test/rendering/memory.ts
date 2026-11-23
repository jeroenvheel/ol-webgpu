/**
 * Memory test page (`?layer=webgl2|webgpu&features=feature|render`):
 * scenarios that repeat one thing a layer does, so the runner can see
 * whether memory or GPU objects grow with the repetitions. With
 * `features=render` every scenario uses RenderFeatures (`ol/render/Feature`,
 * as vector tile formats read them) instead of `ol/Feature`s. `window.__memory.run(name)` runs one cycle of
 * a scenario; `window.__memory.live()` counts what the library keeps.
 */
import Feature from 'ol/Feature.js';
import Map from 'ol/Map.js';
import View from 'ol/View.js';
import Point from 'ol/geom/Point.js';
import RenderFeature from 'ol/render/Feature.js';
import WebGLVectorLayer from 'ol/layer/WebGLVector.js';
import VectorSource from 'ol/source/Vector.js';
import {makeLines, makePlaces, makePoints, makePolygons} from '../../examples/synthetic.js';
import WebGL2VectorLayer from '../../src/layer/WebGL2VectorLayer.js';
import WebGPUVectorLayer from '../../src/layer/WebGPUVectorLayer.js';
import {liveRenderers} from '../../src/renderer/BaseGpuVectorRenderer.js';
import {toRenderFeatures} from './renderFeatures.js';
import {frame, renderersSettled} from './settled.js';

const params = new URLSearchParams(location.search);
const which = params.get('layer');
const Layer: any = which === 'webgpu' ? WebGPUVectorLayer : which === 'ol' ? WebGLVectorLayer : WebGL2VectorLayer;
const render = params.get('features') === 'render';
/** The features of a scenario, as RenderFeatures with `features=render`. */
const as = (list: Feature[]): any[] => (render ? toRenderFeatures(list) : list);

const shapes = {
  'fill-color': ['match', ['get', 'kind'], 0, '#a6cee3', 1, '#b2df8a', '#fdbf6f'],
  'stroke-color': '#33558b',
  'stroke-width': ['get', 'width'],
  'circle-radius': ['get', 'size'],
  'circle-fill-color': '#e31a1c',
};
const labels = {
  'circle-radius': 3,
  'circle-fill-color': '#1f78b4',
  'text-value': ['get', 'name'],
  'text-font': '13px sans-serif',
  'text-fill-color': '#222',
  'text-stroke-color': '#fff',
  'text-stroke-width': 3,
};

const features = () => as([...makePoints(8000), ...makeLines(3000), ...makePolygons(2000)]);

async function settle(map: Map) {
  map.render();
  for (let i = 0; i < 3 || !(map.isRendered() && renderersSettled()); i++) {
    await frame();
  }
}

function makeMap(layers: any[]): Map {
  return new Map({target: 'map', pixelRatio: 1, controls: [], layers, view: new View({center: [0, 0], zoom: 2})});
}

function dispose(map: Map, layers: any[]) {
  map.setTarget(undefined);
  map.dispose();
  layers.forEach((l) => l.dispose());
}

/** A map that stays for the scenarios that change one thing about it. */
let kept: {map: Map; layers: any[]; sources: VectorSource[]; kind: string} | null = null;
async function keep(kind: string, make: () => any[]): Promise<NonNullable<typeof kept>> {
  if (kept?.kind !== kind) {
    if (kept) {
      dispose(kept.map, kept.layers);
    }
    const layers = make();
    kept = {map: makeMap(layers), layers, sources: layers.map((l) => l.getSource()), kind};
    await settle(kept.map);
  }
  return kept;
}

let step = 0;
const scenarios: Record<string, () => Promise<void>> = {
  /** A map with a layer of shapes is made, drawn and disposed. */
  async lifecycle() {
    const layers = [new Layer({source: new VectorSource({features: features()}), style: shapes})];
    const map = makeMap(layers);
    await settle(map);
    dispose(map, layers);
  },
  /** The same with labels drawn on the GPU, decluttered. */
  async lifecycleLabels() {
    const layers = [new Layer({source: new VectorSource({features: as(makePlaces(4000))}), style: labels, declutter: true})];
    const map = makeMap(layers);
    await settle(map);
    dispose(map, layers);
  },
  /** The same with ol's text worker. */
  async lifecycleCanvasText() {
    const layers = [new Layer({source: new VectorSource({features: as(makePlaces(1000))}), style: labels, text: 'canvas'})];
    const map = makeMap(layers);
    await settle(map);
    dispose(map, layers);
  },
  /** Only the layer is removed from a map that stays, and a new one added. */
  async swapLayer() {
    const k = await keep('swap', () => [new Layer({source: new VectorSource({features: features()}), style: shapes})]);
    const old = k.layers[0];
    const next = new Layer({source: old.getSource(), style: shapes});
    k.map.removeLayer(old);
    old.dispose();
    k.map.addLayer(next);
    k.layers[0] = next;
    await settle(k.map);
  },
  /** The view moves and the source reports a change, so the buffers are built again. */
  async pan() {
    const k = await keep('shapes', () => [new Layer({source: new VectorSource({features: features()}), style: shapes})]);
    step++;
    k.map.getView().setCenter([(step % 7) * 4e5, (step % 5) * 3e5]);
    k.map.getView().setZoom(2 + (step % 3));
    k.sources[0].changed(); // moving the view alone builds nothing
    await settle(k.map);
  },
  /** The style is replaced. */
  async setStyle() {
    const k = await keep('shapes', () => [new Layer({source: new VectorSource({features: features()}), style: shapes})]);
    step++;
    k.layers[0].setStyle({...shapes, 'stroke-color': step % 2 ? '#33558b' : '#8b3355', 'circle-radius': step % 2 ? ['get', 'size'] : 4});
    await settle(k.map);
  },
  /** A style variable changes. */
  async variables() {
    const k = await keep('variables', () => [
      new Layer({source: new VectorSource({features: features()}), style: {...shapes, 'circle-radius': ['*', ['var', 'scale'], ['get', 'size']]}, variables: {scale: 1}}),
    ]);
    step++;
    k.layers[0].updateStyleVariables({scale: 1 + (step % 4) / 4});
    await settle(k.map);
  },
  /** Features are added to the source and removed again. */
  async features() {
    const k = await keep('shapes', () => [new Layer({source: new VectorSource({features: features()}), style: shapes})]);
    const extra = as(makePoints(3000, 100 + step++));
    k.sources[0].addFeatures(extra);
    await settle(k.map);
    extra.forEach((f) => k.sources[0].removeFeature(f));
    await settle(k.map);
  },
  /** Labels are laid out again after the view moves, with other texts each time. */
  async labelsPan() {
    const k = await keep('labels', () => [new Layer({source: new VectorSource({features: as(makePlaces(20000))}), style: labels, declutter: true})]);
    step++;
    k.map.getView().setCenter([(step % 7) * 6e5, (step % 5) * 4e5]);
    k.map.getView().setZoom(4 + (step % 3));
    await settle(k.map);
  },
  /** Labels with texts that were never drawn before: the atlas and the text caches grow. */
  async labelsNewText() {
    const k = await keep('newText', () => [new Layer({source: new VectorSource(), style: labels})]);
    const source = k.sources[0];
    source.clear();
    const batch = step++;
    const list: Feature[] = [];
    for (let i = 0; i < 400; i++) {
      list.push(new Feature({geometry: new Point([((i % 20) - 10) * 4e5, (Math.floor(i / 20) - 10) * 3e5]), name: `nr ${batch}-${i} é${String.fromCharCode(0x4e00 + ((batch * 400 + i) % 5000))}`}));
    }
    source.addFeatures(as(list));
    await settle(k.map);
  },
  /** Many picks. */
  async pick() {
    const k = await keep('shapes', () => [new Layer({source: new VectorSource({features: features()}), style: shapes})]);
    for (let i = 0; i < 300; i++) {
      k.map.forEachFeatureAtPixel([(i * 37) % 512, (i * 53) % 384], () => false);
    }
  },
};

(window as any).__memory = {
  names: Object.keys(scenarios),
  run: (name: string) => scenarios[name](),
  /** Ends the scenarios: nothing of the library should be left after this. */
  end() {
    if (kept) {
      dispose(kept.map, kept.layers);
      kept = null;
    }
  },
  /** One big layer, step by step, for the runner to read the memory at each step. */
  async big(stepName: 'features' | 'map' | 'pan' | 'dispose' | 'drop') {
    const w = window as any;
    if (stepName === 'features') {
      w.__big = {features: as([...makePoints(300000), ...makeLines(200000), ...makePolygons(50000)])};
    } else if (stepName === 'map') {
      const layers = [new Layer({source: new VectorSource({features: w.__big.features, useSpatialIndex: false}), style: shapes})];
      w.__big.layers = layers;
      w.__big.map = makeMap(layers);
      await settle(w.__big.map);
    } else if (stepName === 'pan') {
      step++;
      w.__big.map.getView().setCenter([(step % 7) * 4e5, (step % 5) * 3e5]);
      w.__big.layers[0].getSource().changed(); // moving the view alone builds nothing
      await settle(w.__big.map);
    } else if (stepName === 'dispose') {
      dispose(w.__big.map, w.__big.layers);
      w.__big = {features: w.__big.features};
    } else {
      w.__big = null;
    }
  },
  /** Classes whose instances the runner counts after everything is disposed. */
  classes: {Feature, RenderFeature, Map, Layer},
  live: () => ({renderers: liveRenderers.size, canvases: document.querySelectorAll('canvas').length}),
};

/**
 * A change in a big layer (`slices.html?layer=webgl2|webgpu`): the
 * instructions of the build are made in slices, so the page keeps getting
 * frames meanwhile. Result in window.__slices: the checks as
 * {name: {ok, detail}} and the times under `times`.
 */
import Feature from 'ol/Feature.js';
import Map from 'ol/Map.js';
import View from 'ol/View.js';
import Point from 'ol/geom/Point.js';
import VectorSource from 'ol/source/Vector.js';
import {frame, renderersSettled} from './settled.js';
import WebGL2VectorLayer from '../../src/layer/WebGL2VectorLayer.js';
import WebGPUVectorLayer from '../../src/layer/WebGPUVectorLayer.js';
import {liveRenderers} from '../../src/renderer/BaseGpuVectorRenderer.js';

const params = new URLSearchParams(location.search);
const Layer = params.get('layer') === 'webgpu' ? WebGPUVectorLayer : WebGL2VectorLayer;

// fewer where drawing is slow (software rendering in CI draws all of them in every frame)
const COUNT = Number(params.get('count') ?? 1_000_000);
const features: Feature[] = [];
for (let i = 0; i < COUNT; i++) {
  // all but the first two far outside the view: they only have to be built
  const x = i < 2 ? (i ? 60 : -60) : 1000 + (i % 1000) * 3;
  const y = i < 2 ? 0 : 1000 + Math.floor(i / 1000) * 3;
  features.push(new Feature({geometry: new Point([x, y]), size: 3, name: `n${i}`}));
}
const source = new VectorSource({features, useSpatialIndex: false});
const layer = new Layer({source, style: {'circle-radius': ['get', 'size'], 'circle-fill-color': '#d7191c'}});
const map = new Map({target: 'map', pixelRatio: 1, controls: [], layers: [layer], view: new View({center: [0, 0], resolution: 1})});

const renderer = () => [...liveRenderers].find((r) => r.getLayer() === (layer as any)) as any;
const settle = async () => {
  map.render();
  for (let i = 0; i < 3 || !(map.isRendered() && renderersSettled()); i++) {
    await frame();
    if (i > 2000) {
      throw new Error('the layer did not settle');
    }
  }
};
const names = (x: number, y: number) => map.getFeaturesAtPixel([128 + x, 128 - y]).map((f) => f.get('name'));

(async () => {
  const results: Record<string, unknown> = {};
  const check = (name: string, ok: boolean, detail: unknown) => (results[name] = {ok, detail: JSON.stringify(detail)});
  try {
    await settle();
    /** What the page went through while `change` was built: the longest time between two frames, and the long tasks. */
    const measure = async (change: () => void) => {
      let longest = 0;
      let last = performance.now();
      let watching = true;
      const watch = (t: number) => {
        longest = Math.max(longest, t - last);
        last = t;
        if (watching) {
          requestAnimationFrame(watch);
        }
      };
      const tasks: number[] = [];
      const observer = new PerformanceObserver((list) => tasks.push(...list.getEntries().map((e) => e.duration)));
      observer.observe({entryTypes: ['longtask']});
      await frame();
      last = performance.now();
      requestAnimationFrame(watch);
      const start = performance.now();
      change();
      await settle();
      const ms = Math.round(performance.now() - start);
      watching = false;
      await frame();
      await frame();
      observer.disconnect();
      return {
        ms,
        longestFrame: Math.round(longest),
        longTasks: tasks.length,
        longTaskMs: Math.round(tasks.reduce((a, b) => a + b, 0)),
        slices: (renderer().instructionSlices as number) ?? null,
      };
    };
    const builds = renderer().builds;
    const one = await measure(() => features[0].set('size', 12));
    const slices = renderer().instructionSlices;
    const hit = {changed: names(-60 + 10, 0), other: names(60 + 10, 0)};
    check('a change in a big layer is built in slices', slices > 3 && renderer().builds === builds + 1 && hit.changed.join() === 'n0' && hit.other.length === 0, {
      slices,
      builds: renderer().builds - builds,
      hit,
    });
    // another style: the attributes of all features are computed again
    const restyled = await measure(() =>
      layer.setStyle({'circle-radius': ['get', 'size'], 'circle-fill-color': '#2c7bb6', 'circle-stroke-width': ['*', ['get', 'size'], 0.1], 'circle-stroke-color': '#000000'}),
    );
    results.times = {one, restyled};

    // a change that comes while the instructions are being made is in the result
    features[0].set('size', 3);
    await frame(); // the build has started and is between two slices
    features[1].set('size', 12);
    await settle();
    const both = {first: names(-60 + 10, 0), second: names(60 + 10, 0)};
    check('a change that comes during the slices is built too', both.first.length === 0 && both.second.join() === 'n1', both);
  } catch (e) {
    check('no error', false, String(e));
  }
  (window as any).__slices = results;
})();

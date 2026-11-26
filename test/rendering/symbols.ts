/**
 * Symbols that take part in decluttering
 * (`symbols.html?layer=webgl2|webgpu`). Result in window.__symbols:
 * {name: {ok, detail}}.
 */
import Feature from 'ol/Feature.js';
import Map from 'ol/Map.js';
import View from 'ol/View.js';
import Point from 'ol/geom/Point.js';
import VectorSource from 'ol/source/Vector.js';
import {frame, renderersSettled} from './settled.js';
import {liveRenderers} from '../../src/renderer/BaseGpuVectorRenderer.js';
import WebGL2VectorLayer from '../../src/layer/WebGL2VectorLayer.js';
import WebGPUVectorLayer from '../../src/layer/WebGPUVectorLayer.js';

const params = new URLSearchParams(location.search);
const Layer = params.get('layer') === 'webgpu' ? WebGPUVectorLayer : WebGL2VectorLayer;

const point = (x: number, y: number, name: string, extra: Record<string, unknown> = {}) => new Feature({geometry: new Point([x, y]), name, ...extra});
const circle = {'circle-radius': 10, 'circle-fill-color': '#d7191c'};

// resolution 1, centre 0,0: the pixel of (X, Y) is (128 + X, 128 - Y)
// two circles that overlap (the first one came first and stays) and one on its own
const placed = new Layer({
  source: new VectorSource({features: [point(-80, 80, 'a'), point(-68, 80, 'b'), point(-20, 80, 'c')]}),
  style: {...circle, 'circle-declutter-mode': 'declutter'},
  declutter: 'placed',
});
// without a mode, symbols are not placed: both are drawn
const unplaced = new Layer({
  source: new VectorSource({features: [point(40, 80, 'd'), point(52, 80, 'e')]}),
  style: circle,
  declutter: 'unplaced',
});
// obstacles are always drawn, and are in the way of the labels of the layer below
const obstacles = new Layer({
  source: new VectorSource({features: [point(-80, 0, 'f'), point(-68, 0, 'g')]}),
  style: {...circle, 'circle-declutter-mode': 'obstacle'},
  declutter: 'shared',
});
const under = new Layer({
  source: new VectorSource({features: [point(-74, 0, 'under'), point(-20, 0, 'free')]}),
  style: {'text-value': ['get', 'name'], 'text-font': 'bold 14px sans-serif', 'text-fill-color': '#000000'},
  declutter: 'shared',
});
// symbol and label are one: the symbols are apart, the labels (to the right of them) overlap
const pairs = new Layer({
  source: new VectorSource({features: [point(20, -70, 'first label'), point(50, -62, 'second label')]}),
  style: {
    ...circle,
    'circle-declutter-mode': 'declutter',
    'text-value': ['get', 'name'],
    'text-font': 'bold 14px sans-serif',
    'text-fill-color': '#000000',
    'text-offset-x': 16,
    'text-align': 'left',
  },
  declutter: 'pairs',
});
// Icons of 40 by 10 pixels, 16 pixels apart: as they are they overlap; turned a quarter
// they are 10 wide and stand next to each other.
const bar = document.createElement('canvas');
bar.width = 40;
bar.height = 10;
const barContext = bar.getContext('2d')!;
barContext.fillStyle = '#d7191c';
barContext.fillRect(0, 0, 40, 10);
const icon = {'icon-src': bar.toDataURL(), 'icon-width': 40, 'icon-height': 10, 'icon-declutter-mode': 'declutter' as const};
const flat = new Layer({
  source: new VectorSource({features: [point(30, 30, 'flat a'), point(46, 30, 'flat b')]}),
  style: icon,
  declutter: 'flat',
});
const turned = new Layer({
  source: new VectorSource({features: [point(-40, 30, 'turned a'), point(-24, 30, 'turned b')]}),
  style: {...icon, 'icon-rotation': Math.PI / 2},
  declutter: 'turned',
});
const view = new View({center: [0, 0], resolution: 1});
const map = new Map({target: 'map', pixelRatio: 1, controls: [], layers: [placed, unplaced, under, obstacles, pairs, flat, turned], view});

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
    // fades of labels
    await new Promise((resolve) => setTimeout(resolve, 400));
    await frame();
  };
  const probe = document.createElement('canvas').getContext('2d', {willReadFrequently: true})!;
  probe.canvas.width = probe.canvas.height = 256;
  /** Whether something red is drawn at a map position, and the features hit there. */
  const at = (x: number, y: number) => {
    map.renderSync();
    probe.clearRect(0, 0, 256, 256);
    for (const canvas of document.querySelectorAll('#map canvas')) {
      probe.drawImage(canvas as HTMLCanvasElement, 0, 0);
    }
    const centre = map.getPixelFromCoordinate([x, y]).map(Math.round);
    const [r, g, , a] = probe.getImageData(centre[0], centre[1], 1, 1).data;
    return {drawn: a > 200 && r > 150 && g < 80, hits: map.getFeaturesAtPixel(centre).map((f) => f.get('name'))};
  };
  /** Dark pixels (text) in a box of the canvas around a map position. */
  const ink = (x: number, y: number, w: number, h: number) => {
    map.renderSync();
    probe.clearRect(0, 0, 256, 256);
    for (const canvas of document.querySelectorAll('#map canvas')) {
      probe.drawImage(canvas as HTMLCanvasElement, 0, 0);
    }
    const data = probe.getImageData(128 + x, 128 - y - h / 2, w, h).data;
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) {
      dark += data[i + 3] > 128 && data[i] < 80 ? 1 : 0;
    }
    return dark;
  };
  try {
    await settle();
    // away from where the two overlap
    const a = at(-86, 80);
    const b = at(-60, 80);
    const c = at(-20, 80);
    check('a symbol that overlaps an earlier one is not drawn, and not hit', a.drawn && a.hits.join() === 'a' && !b.drawn && b.hits.length === 0 && c.drawn && c.hits.join() === 'c', {a, b, c});

    const d = at(34, 80);
    const e = at(60, 80);
    check('symbols without a declutter mode are all drawn', d.drawn && e.drawn && e.hits.join() === 'e', {d, e});

    const f = at(-86, 0);
    const g = at(-60, 0);
    const hiddenLabel = ink(-100, 0, 60, 30);
    const freeLabel = ink(-40, 0, 40, 30);
    check('obstacles are all drawn and keep labels away', f.drawn && g.drawn && hiddenLabel === 0 && freeLabel > 30, {f, g, hiddenLabel, freeLabel});

    const first = at(20, -70);
    const second = at(50, -62);
    check('a symbol goes with its label: neither is drawn when the label has no place', first.drawn && !second.drawn && !second.hits.includes('second label'), {first, second});

    // an icon takes the space it has as it is turned, not the square around it
    const icons = {flatA: at(14, 30), flatB: at(62, 30), turnedA: at(-40, 46), turnedB: at(-24, 46)};
    check(
      'icons that overlap as they lie do not when they are turned a quarter',
      icons.flatA.drawn && !icons.flatB.drawn && icons.turnedA.drawn && icons.turnedB.drawn && icons.turnedB.hits.join() === 'turned b',
      icons,
    );

    // closer, the two circles no longer overlap: both are drawn
    view.setCenter([-74, 80]);
    view.setResolution(0.25);
    await settle();
    const near = {a: at(-80, 80), b: at(-68, 80)};
    check('a symbol comes back when there is room', near.a.drawn && near.b.drawn && near.b.hits.join() === 'b', near);
    const fadeEnd = () => ([...liveRenderers].find((r) => r.getLayer() === (placed as any)) as any)?.symbolFadeEnd ?? 0;
    const before = fadeEnd();
    view.setCenter([0, 0]);
    view.setResolution(1);
    await settle();
    const back = at(-60, 80);
    check('and goes again when there is none', !back.drawn && back.hits.length === 0, back);
    // not at once: it fades out, as a label does
    check('a symbol that loses its place fades out', fadeEnd() > before, {before, after: fadeEnd()});

    // the first one leaves: the second takes its place
    placed.getSource()!.removeFeature(placed.getSource()!.getFeatures().find((feature) => feature.get('name') === 'a')!);
    await settle();
    const left = {a: at(-86, 80), b: at(-60, 80)};
    check('a symbol takes the place of one that is removed', !left.a.drawn && left.b.drawn && left.b.hits.join() === 'b', left);

    // how long 40 000 symbols take, placed and not, for the report
    const many = (mode: 'declutter' | undefined) => {
      const features: Feature[] = [];
      for (let i = 0; i < 40_000; i++) {
        features.push(point(-120 + ((i * 37) % 240), -120 + ((i * 101) % 240), String(i)));
      }
      return new Layer({
        source: new VectorSource({features}),
        style: mode ? {'circle-radius': 3, 'circle-fill-color': '#2c7bb6', 'circle-declutter-mode': mode} : {'circle-radius': 3, 'circle-fill-color': '#2c7bb6'},
        declutter: 'many',
      });
    };
    const timed = async (mode: 'declutter' | undefined) => {
      const layer = many(mode);
      const start = performance.now();
      map.addLayer(layer);
      map.render();
      for (let i = 0; i < 5 || !(map.isRendered() && renderersSettled()); i++) {
        await frame();
      }
      const ms = Math.round(performance.now() - start);
      const hidden = ((layer.getRenderer() as any).gpuText?.hiddenSymbols.size as number) ?? 0;
      map.removeLayer(layer);
      await frame();
      return {ms, hidden};
    };
    (results as any).times = {plain: await timed(undefined), placed: await timed('declutter')};
  } catch (e) {
    check('no error', false, String(e));
  }
  (window as any).__symbols = results;
})();

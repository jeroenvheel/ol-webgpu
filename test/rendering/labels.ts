/**
 * GPU text when things change (`?layer=webgl2|webgpu`): hit detection of
 * labels, a new layout after panning, zooming, style and data changes, and
 * the layer opacity. Result in window.__labels: {name: {ok, detail}}.
 */
import Feature from 'ol/Feature.js';
import Map from 'ol/Map.js';
import View from 'ol/View.js';
import LineString from 'ol/geom/LineString.js';
import {getWidth} from 'ol/extent.js';
import Point from 'ol/geom/Point.js';
import VectorSource from 'ol/source/Vector.js';
import {frame, renderersSettled} from './settled.js';
import WebGL2VectorLayer from '../../src/layer/WebGL2VectorLayer.js';
import WebGPUVectorLayer from '../../src/layer/WebGPUVectorLayer.js';
import {sharedAtlas} from '../../src/text/atlas.js';
import {fadeUploads} from '../../src/text/shaders.js';

const params = new URLSearchParams(location.search);
const Layer = params.get('layer') === 'webgpu' ? WebGPUVectorLayer : WebGL2VectorLayer;

const point = (x: number, y: number, name: string) => new Feature({geometry: new Point([x, y]), name});
const style = (extra: Record<string, unknown> = {}) => ({
  'text-value': ['get', 'name'],
  'text-font': 'bold 14px sans-serif',
  'text-fill-color': '#1b4f72',
  'text-scale': ['var', 'scale'],
  ...extra,
});

const source = new VectorSource({features: [point(0, 0, 'centre'), point(600, 0, 'far east')]});
const layer = new Layer({source, style: style(), variables: {scale: 1}});
// two labels on one spot: the second gives way
const crowded = new Layer({
  source: new VectorSource({features: [point(0, -80, 'first'), point(0, -80, 'second')]}),
  style: {'text-value': ['get', 'name'], 'text-font': '14px "Label Font", sans-serif', 'text-fill-color': '#7b241c'},
  declutter: true,
});
const view = new View({center: [0, 0], resolution: 1});
const map = new Map({target: 'map', pixelRatio: 1, controls: [], layers: [layer, crowded], view});

const probe = document.createElement('canvas').getContext('2d', {willReadFrequently: true})!;
/** Drawn pixels and the highest alpha in a box of the layers' canvas (read in the task that rendered it). */
function drawn(x0 = 0, y0 = 0, x1 = 256, y1 = 256): {count: number; alpha: number; red: number} {
  map.renderSync();
  const canvas = document.querySelector('#map canvas') as HTMLCanvasElement;
  probe.canvas.width = canvas.width;
  probe.canvas.height = canvas.height;
  probe.drawImage(canvas, 0, 0);
  const data = probe.getImageData(x0, y0, x1 - x0, y1 - y0).data;
  let count = 0;
  let alpha = 0;
  let red = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 0) {
      count++;
      alpha = Math.max(alpha, data[i + 3]);
      // straight colours: mostly red
      red += data[i] > 2 * data[i + 2] && data[i + 3] > 128 ? 1 : 0;
    }
  }
  return {count, alpha, red};
}

const quiet = () => map.isRendered() && renderersSettled();
async function settle() {
  map.render();
  for (let i = 0; i < 3 || !quiet(); i++) {
    await frame();
    if (i > 600) {
      throw new Error('labels did not settle');
    }
  }
}

const names = (pixel: number[], hitTolerance = 0) => map.getFeaturesAtPixel(pixel, {hitTolerance}).map((f) => f.get('name'));

(async () => {
  const results: Record<string, {ok: boolean; detail: string}> = {};
  const check = (name: string, ok: boolean, detail: unknown) => {
    results[name] = {ok, detail: JSON.stringify(detail)};
  };
  let lineLabelsMs = 0;
  try {
    await settle();
    const upper = [0, 0, 256, 180] as const; // without the crowded layer's labels
    const first = drawn(...upper);
    check('labels are drawn', first.count > 150 && first.alpha === 255, first);

    check('a label is hit', names([128, 128]).join() === 'centre', names([128, 128]));
    check('beside a label is not hit', names([128, 100]).length === 0, names([128, 100]));
    check('hit tolerance reaches a label', names([128, 142]).length === 0 && names([128, 142], 10).join() === 'centre', [names([128, 142]), names([128, 142], 10)]);
    check('a decluttered label is not hit', names([128, 208]).join() === 'first', names([128, 208]));

    // a feature outside what was laid out comes into view
    view.setCenter([600, 0]);
    await settle();
    const east = drawn(...upper);
    check('labels after panning', east.count > 150 && names([128, 128]).join() === 'far east', {east, hit: names([128, 128])});

    view.setCenter([0, 0]);
    view.setResolution(0.5);
    await settle();
    const zoomed = drawn(...upper);
    check('labels after zooming keep their size', Math.abs(zoomed.count - first.count) <= first.count * 0.05, {first: first.count, zoomed: zoomed.count});
    view.setResolution(1);
    await settle();

    layer.updateStyleVariables({scale: 2});
    await settle();
    const scaled = drawn(...upper);
    check('a style variable changes the labels', scaled.count > first.count * 2.5, {first: first.count, scaled: scaled.count});
    layer.updateStyleVariables({scale: 1});

    layer.setStyle(style({'text-fill-color': '#ff0000'}) as any);
    await settle();
    const red = drawn(...upper);
    check('a new style changes the labels', red.red > 150 && first.red === 0, {before: first.red, after: red.red});

    source.addFeature(point(0, 60, 'added'));
    await settle();
    const added = drawn(...upper);
    check('an added feature gets a label', added.count > red.count * 1.5 && names([128, 68]).join() === 'added', {before: red.count, after: added.count});

    layer.setOpacity(0.5);
    await settle();
    const faint = drawn(...upper);
    check('the layer opacity applies to labels', faint.alpha > 110 && faint.alpha < 145 && faint.count > 150, faint);
    layer.setOpacity(1);

    source.clear();
    await settle();
    const cleared = drawn(...upper);
    check('labels of removed features go away', cleared.count === 0 && names([128, 128]).length === 0, cleared);

    // one of the two crowded labels is shown, and stays the same one
    const crowd = drawn(0, 180, 256, 256);
    check('decluttering shows one of two labels', crowd.count > 40 && crowd.count < 400 && crowd.alpha === 255, crowd);

    // the same features as new objects, as a source that loads them again: the label stays
    const crowdedSource = crowded.getSource()!;
    crowdedSource.clear();
    crowdedSource.addFeatures([point(0, -80, 'first'), point(0, -80, 'second')]);
    let leastAlpha = 255;
    let leastCount = Infinity;
    let reloadFrames = 0;
    for (; reloadFrames < 5 || !quiet(); reloadFrames++) {
      const d = drawn(0, 180, 256, 256);
      leastAlpha = Math.min(leastAlpha, d.alpha);
      leastCount = Math.min(leastCount, d.count);
      await frame();
    }
    const reloaded = drawn(0, 180, 256, 256);
    check(
      'a label stays when its feature is loaded again',
      leastAlpha === 255 && leastCount > crowd.count * 0.9 && reloaded.count === crowd.count && names([128, 208]).join() === 'first',
      {before: crowd, leastAlpha, leastCount, frames: reloadFrames, after: reloaded},
    );

    // five worlds to the east the labels are where they are in the world of the features
    {
      const pixels = () => {
        map.renderSync();
        const canvas = document.querySelector('#map canvas') as HTMLCanvasElement;
        probe.canvas.width = canvas.width;
        probe.canvas.height = canvas.height;
        probe.drawImage(canvas, 0, 0);
        return probe.getImageData(0, 0, canvas.width, canvas.height).data;
      };
      const centre = view.getCenter()!;
      // away from the centre of the view, where the rounding of the anchor and of the origin do not cancel
      const offside = point(centre[0] + 37, centre[1] + 40, 'offside');
      crowded.getSource()!.addFeature(offside);
      await settle();
      const here = pixels();
      view.setCenter([centre[0] + 5 * getWidth(view.getProjection().getExtent()), centre[1]]);
      await settle();
      // laid out there, not only moved there
      crowded.getSource()!.changed();
      await settle();
      const there = pixels();
      let inked = 0;
      let differing = 0;
      for (let i = 3; i < here.length; i += 4) {
        inked += here[i] > 128 ? 1 : 0;
        differing += Math.abs(here[i] - there[i]) > 8 ? 1 : 0;
      }
      check('labels five worlds away are where they belong', inked > 40 && differing === 0, {inked, differing});
      view.setCenter(centre);
      crowded.getSource()!.removeFeature(offside);
      await settle();
    }

    // text-max-width: a label that is wider is broken into lines
    {
      const [cx, cy] = view.getCenter()!;
      const r = view.getResolution()!;
      const words = 'one two three four five six';
      const wide = {'text-value': ['get', 'name'], 'text-font': '12px sans-serif', 'text-fill-color': '#000000'};
      const whole = new Layer({source: new VectorSource({features: [point(cx, cy + 60 * r, words)]}), style: wide});
      const broken = new Layer({
        source: new VectorSource({features: [point(cx, cy - 20 * r, words), point(cx, cy - 90 * r, 'one')]}),
        style: {...wide, 'text-max-width': ['case', ['==', ['get', 'name'], 'one'], 10, 60]} as any,
      });
      map.addLayer(whole);
      map.addLayer(broken);
      await settle();
      map.renderSync();
      const canvas = document.querySelector('#map canvas') as HTMLCanvasElement;
      probe.canvas.width = canvas.width;
      probe.canvas.height = canvas.height;
      probe.drawImage(canvas, 0, 0);
      /** The box of the dark pixels in rows y0 to y1 of the canvas. */
      const box = (y0: number, y1: number) => {
        const data = probe.getImageData(0, y0, 256, y1 - y0).data;
        let minX = 256;
        let maxX = -1;
        let minY = y1;
        let maxY = -1;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] > 128 && data[i] < 80) {
            const x = (i / 4) % 256;
            const y = Math.floor(i / 4 / 256);
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
          }
        }
        return {width: maxX - minX + 1, height: maxY - minY + 1};
      };
      const one = box(40, 96);
      const lines = box(100, 196);
      const word = box(200, 236);
      check('text-max-width breaks a label into lines', one.width > 100 && one.height < 16 && lines.width <= 62 && lines.width > 30 && lines.height > 2.5 * one.height && word.width > 10 && word.height < 16, {
        whole: one,
        broken: lines,
        word,
      });
      map.removeLayer(whole);
      map.removeLayer(broken);
      await settle();
    }

    // a label along a line stays upright while the view turns (it is laid out again when the view rests)
    {
      const [cx, cy] = view.getCenter()!;
      const r = view.getResolution()!;
      const road = new Feature({geometry: new LineString([[cx - 110 * r, cy + 60 * r], [cx + 110 * r, cy + 60 * r]]), name: 'Upright along the line'});
      const along = new Layer({
        source: new VectorSource({features: [road]}),
        style: {'text-value': ['get', 'name'], 'text-placement': 'line', 'text-font': 'bold 16px sans-serif', 'text-fill-color': '#000000'},
      });
      map.addLayer(along);
      await settle();
      const image = () => {
        map.renderSync();
        const canvas = document.querySelector('#map canvas') as HTMLCanvasElement;
        probe.canvas.width = canvas.width;
        probe.canvas.height = canvas.height;
        probe.drawImage(canvas, 0, 0);
        return probe.getImageData(0, 0, canvas.width, canvas.height).data;
      };
      const INTERACTING = 1; // ol/ViewHint.js
      view.setHint(INTERACTING, 1);
      view.setRotation(Math.PI);
      await frame();
      const turning = image();
      view.setHint(INTERACTING, -1);
      await settle();
      const rested = image();
      let inked = 0;
      let differing = 0;
      for (let i = 3; i < rested.length; i += 4) {
        inked += rested[i] > 128 ? 1 : 0;
        differing += Math.abs(rested[i] - turning[i]) > 128 ? 1 : 0;
      }
      check('a label along a line is upright while the view turns', inked > 300 && differing < inked * 0.1, {inked, differing});
      view.setRotation(0);
      map.removeLayer(along);
      await settle();

      // how long 3 000 labels along lines take, for the report
      const roads: Feature[] = [];
      for (let i = 0; i < 3000; i++) {
        const x = cx + (((i * 37) % 200) - 100) * r;
        const y = cy + (((i * 101) % 200) - 100) * r;
        roads.push(new Feature({geometry: new LineString([[x - 40 * r, y], [x, y + 10 * r], [x + 40 * r, y]]), name: `Road ${i}`}));
      }
      const many = new Layer({
        source: new VectorSource({features: roads}),
        style: {'text-value': ['get', 'name'], 'text-placement': 'line', 'text-font': '10px sans-serif', 'text-fill-color': '#000000'},
      });
      const start = performance.now();
      map.addLayer(many);
      await settle();
      lineLabelsMs = Math.round(performance.now() - start);
      map.removeLayer(many);
      await settle();
    }

    // web fonts that arrive: only those of the labels make the atlas start over
    const atlas = sharedAtlas();
    const loadFont = async (family: string) => {
      const face = new FontFace(family, "url('data/fonts/ubuntu-regular-webfont.woff2') format('woff2')");
      document.fonts.add(face);
      await face.load();
      await document.fonts.ready;
      await frame();
    };
    const generation = atlas.generation;
    await loadFont('Icons Of The Page');
    await settle();
    check('a font no label uses keeps the atlas', atlas.generation === generation, {before: generation, after: atlas.generation});
    // so many labels that laying them out takes several frames
    const many: Feature[] = [];
    for (let i = 0; i < 40_000; i++) {
      many.push(point(-120 + ((i * 37) % 240), -40 + ((i * 101) % 160), `n${i}`));
    }
    map.addLayer(
      new Layer({
        source: new VectorSource({features: many}),
        style: {'text-value': ['get', 'name'], 'text-font': '10px "Label Font", sans-serif', 'text-fill-color': '#1e8449'},
        declutter: 'many',
      }),
    );
    const manyStart = performance.now();
    await settle();
    const manyMs = performance.now() - manyStart;
    const before = drawn(...upper).count;

    // a pan: labels come into view and fade in, others give way; how much of the fades is uploaded
    const fadeStart = {...fadeUploads};
    const centreNow = view.getCenter()!;
    let fadeFrames = 0;
    view.setCenter([centreNow[0] + 30, centreNow[1] + 20]);
    for (; fadeFrames < 3 || !quiet(); fadeFrames++) {
      await frame();
    }
    const lastLayer = map.getLayers().item(map.getLayers().getLength() - 1) as any;
    const fades = {
      glyphs: fadeUploads.glyphs - fadeStart.glyphs,
      uploads: fadeUploads.uploads - fadeStart.uploads,
      frames: fadeFrames,
      // the glyphs the layer has: before, all of them were written and uploaded in every frame of a fade
      of: lastLayer.getRenderer().gpuText.stats.glyphs as number,
    };
    view.setCenter(centreNow);
    await settle();

    await loadFont('Label Font');
    const relayStart = performance.now();
    // until the labels are laid out with the new font, the ones on screen stay
    let fewest = Infinity;
    let frames = 0;
    for (; frames < 3 || !quiet(); frames++) {
      fewest = Math.min(fewest, drawn(...upper).count);
      await frame();
    }
    // how long 40 000 labels take, for the report
    (window as any).__labelTimes = {fades, lines: lineLabelsMs, first: Math.round(manyMs), again: Math.round(performance.now() - relayStart), frames};
    const relaid = drawn(0, 180, 256, 256);
    check('a font of the labels starts the atlas over', atlas.generation === generation + 1 && relaid.count > 40 && relaid.alpha === 255, {
      before: generation,
      after: atlas.generation,
      relaid,
    });
    check('labels stay on screen while the atlas starts over', before > 1000 && fewest > before * 0.5, {before, fewest, frames});
  } catch (e) {
    check('no error', false, String(e));
  }
  (window as any).__labels = results;
})();

/**
 * A layer that is taken from its map, and features that are loaded while the
 * view moves (`removed.html?layer=webgl2|webgpu`). Result in
 * window.__removed: {name: {ok, detail}}.
 */
import Feature from 'ol/Feature.js';
import Map from 'ol/Map.js';
import View from 'ol/View.js';
import Point from 'ol/geom/Point.js';
import VectorLayer from 'ol/layer/Vector.js';
import {bbox} from 'ol/loadingstrategy.js';
import VectorSource from 'ol/source/Vector.js';
import {frame, renderersSettled} from './settled.js';
import WebGL2VectorLayer from '../../src/layer/WebGL2VectorLayer.js';
import WebGPUVectorLayer from '../../src/layer/WebGPUVectorLayer.js';
import {liveRenderers} from '../../src/renderer/BaseGpuVectorRenderer.js';

const params = new URLSearchParams(location.search);
const Layer = params.get('layer') === 'webgpu' ? WebGPUVectorLayer : WebGL2VectorLayer;

const circle = (color: string) => ({'circle-radius': 12, 'circle-fill-color': color});
const point = (x: number, y: number, name: string) => new Feature({geometry: new Point([x, y]), name});
// resolution 1, centre 0,0: the pixel of (X, Y) is (128 + X, 128 - Y)
const below = new Layer({source: new VectorSource({features: [point(-60, 0, 'below')]}), style: circle('#d7191c')});
const layer = new Layer({source: new VectorSource({features: [point(0, 0, 'point')]}), style: circle('#2c7bb6')});
const map = new Map({target: 'map', pixelRatio: 1, controls: [], layers: [below, layer], view: new View({center: [0, 0], resolution: 1})});

const rendererOf = (l: unknown) => [...liveRenderers].find((r) => r.getLayer() === l) as any;
const task = () => new Promise((resolve) => setTimeout(resolve, 20));
const settle = async () => {
  map.render();
  for (let i = 0; i < 5 || !(map.isRendered() && renderersSettled()); i++) {
    await frame();
    if (i > 600) {
      throw new Error('the map did not settle');
    }
  }
};
/** The alpha at a pixel of the map, of all its canvases together. */
const alphaAt = (x: number, y: number) => {
  map.renderSync();
  const probe = document.createElement('canvas').getContext('2d', {willReadFrequently: true})!;
  probe.canvas.width = probe.canvas.height = 256;
  for (const canvas of document.querySelectorAll('#map canvas')) {
    probe.drawImage(canvas as HTMLCanvasElement, 0, 0);
  }
  return probe.getImageData(x, y, 1, 1).data[3];
};
const names = (x: number, y: number) => map.getFeaturesAtPixel([x, y]).map((f) => f.get('name'));

(async () => {
  const results: Record<string, {ok: boolean; detail: string}> = {};
  const check = (name: string, ok: boolean, detail: unknown) => (results[name] = {ok, detail: JSON.stringify(detail)});
  try {
    await settle();
    const first = rendererOf(layer);
    const before = {renderers: liveRenderers.size, drawn: alphaAt(128, 128), hit: names(128, 128)};

    // out and in again at once, as an app does to put a layer in another place: nothing is built again
    map.removeLayer(layer);
    map.getLayers().insertAt(0, layer);
    await task();
    await settle();
    const moved = {same: rendererOf(layer) === first, builds: first.builds, drawn: alphaAt(128, 128), other: alphaAt(68, 128)};
    check('a layer that is put back at once keeps what it built', moved.same && moved.builds === 1 && moved.drawn === 255 && moved.other === 255, moved);

    // taken from the map and not disposed: its renderer goes, and what it held with it
    map.removeLayer(layer);
    await task();
    await settle();
    const gone = {renderers: liveRenderers.size, has: layer.hasRenderer(), drawn: alphaAt(128, 128), other: alphaAt(68, 128), hit: names(128, 128)};
    check(
      'a layer that is taken from the map gives up its renderer',
      before.renderers === 2 && gone.renderers === 1 && !gone.has && before.drawn === 255 && gone.drawn === 0 && gone.other === 255 && gone.hit.length === 0,
      {before, gone},
    );

    // and is whole again when it comes back, with what changed in the meantime
    layer.getSource()!.addFeature(point(60, 0, 'later'));
    map.addLayer(layer);
    await settle();
    const back = {renderers: liveRenderers.size, drawn: alphaAt(128, 128), later: alphaAt(188, 128), hit: names(128, 128), hitLater: names(188, 128)};
    check('a layer that comes back is drawn and hit again', back.renderers === 2 && back.drawn === 255 && back.later === 255 && back.hit.join() === 'point' && back.hitLater.join() === 'later', back);

    // a layer of a map by `setMap`
    const loose = new Layer({source: new VectorSource({features: [point(0, 60, 'loose')]}), style: circle('#1a9641'), map});
    await settle();
    const on = {renderers: liveRenderers.size, drawn: alphaAt(128, 68)};
    loose.setMap(null);
    await task();
    await settle();
    const off = {renderers: liveRenderers.size, drawn: alphaAt(128, 68)};
    check('so does a layer of setMap', on.renderers === 3 && on.drawn === 255 && off.renderers === 2 && off.drawn === 0, {on, off});

    // A layer of setMap is not in the layers of the map, and the map is not a property
    // of it: `getFeatures` found nothing, as it looked for the frame of that property.
    // (The labels were drawn before too: the frame after the layout comes with the
    // layer being ready.)
    const labelled = new Layer({
      source: new VectorSource({features: [point(0, -70, 'labelled')]}),
      style: {'text-value': ['get', 'name'], 'text-font': 'bold 22px sans-serif', 'text-fill-color': '#000000'},
      declutter: true,
    });
    let frames = 0;
    labelled.on('postrender', () => frames++);
    labelled.setMap(map);
    await new Promise((resolve) => setTimeout(resolve, 1000)); // no render is asked for here
    const framesAlone = frames;
    const solid = () => {
      map.renderSync();
      const probe = document.createElement('canvas').getContext('2d', {willReadFrequently: true})!;
      probe.canvas.width = probe.canvas.height = 256;
      for (const canvas of document.querySelectorAll('#map canvas')) {
        probe.drawImage(canvas as HTMLCanvasElement, 0, 0);
      }
      const data = probe.getImageData(68, 178, 120, 40).data;
      let n = 0;
      for (let i = 3; i < data.length; i += 4) {
        n += data[i] > 200 ? 1 : 0;
      }
      return n;
    };
    const text = solid();
    const found = (await labelled.getFeatures([128, 198])).map((f) => f.get('name'));
    check('a layer of setMap draws its labels and finds its features', framesAlone >= 1 && text > 100 && found.join() === 'labelled', {
      frames: framesAlone,
      text,
      found,
    });
    labelled.setMap(null);
    labelled.dispose();
    await settle();

    // A layer that goes to another canvas (a layer of another kind comes before it). WebGL2
    // uploads its buffers again there: from its copy, or built again without one
    // (`keepBuffers: false`). To WebGPU the canvas does not matter.
    const canvases: Record<string, unknown> = {};
    let movedOk = true;
    for (const keepBuffers of [true, false]) {
      const mover = new Layer({source: new VectorSource({features: [point(60, 100, 'mover')]}), style: circle('#1a9641'), keepBuffers});
      map.addLayer(mover);
      await settle();
      const canvas = rendererOf(mover).canvas;
      const between = new VectorLayer({source: new VectorSource()});
      map.getLayers().insertAt(map.getLayers().getLength() - 1, between);
      await settle();
      const result = {
        builds: rendererOf(mover).builds,
        otherCanvas: rendererOf(mover).canvas !== canvas,
        drawn: alphaAt(188, 28),
        hit: names(188, 28),
      };
      canvases[`keepBuffers ${keepBuffers}`] = result;
      const builds = params.get('layer') === 'webgpu' || keepBuffers ? 1 : 2;
      movedOk &&= result.builds === builds && result.otherCanvas && result.drawn === 255 && result.hit.join() === 'mover';
      map.removeLayer(between);
      map.removeLayer(mover);
      mover.dispose();
      await settle();
    }
    check('a layer that goes to another canvas is drawn there, built again only without a copy of its buffers', movedOk, canvases);

    // a map that leaves the page: its layers give up their renderers, unless it is back at once
    const kept = rendererOf(layer);
    map.setTarget(undefined);
    map.setTarget('map');
    await task();
    await settle();
    const movedMap = {same: rendererOf(layer) === kept, builds: kept.builds, drawn: alphaAt(128, 128)};
    map.setTarget(undefined);
    await task();
    const without = {renderers: liveRenderers.size, has: layer.hasRenderer()};
    map.setTarget('map');
    await settle();
    const again = {renderers: liveRenderers.size, drawn: alphaAt(128, 128), other: alphaAt(68, 128), hit: names(128, 128)};
    check(
      'the layers of a map that leaves the page give up their renderers, and are drawn again when it is back',
      movedMap.same && movedMap.builds === 1 && movedMap.drawn === 255 && without.renderers === 0 && !without.has && again.renderers === 2 && again.drawn === 255 && again.other === 255 && again.hit.join() === 'point',
      {movedMap, without, again},
    );

    // the element of the map is taken from the page without telling the map, and put back
    const element = map.getTargetElement()!;
    const parent = element.parentNode!;
    const sibling = element.nextSibling;
    element.remove();
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 40)));
    const detached = {renderers: liveRenderers.size, has: layer.hasRenderer()};
    parent.insertBefore(element, sibling);
    map.updateSize();
    await settle();
    const attached = {renderers: liveRenderers.size, drawn: alphaAt(128, 128), other: alphaAt(68, 128), hit: names(128, 128)};
    // and once more: the layers watch the element again
    element.remove();
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 40)));
    const detachedAgain = liveRenderers.size;
    parent.insertBefore(element, sibling);
    map.updateSize();
    await settle();
    check(
      'the layers of a map whose element leaves the page give up their renderers, and are drawn again when it is back',
      detached.renderers === 0 && !detached.has && attached.renderers === 2 && attached.drawn === 255 && attached.other === 255 && attached.hit.join() === 'point' && detachedAgain === 0 && alphaAt(128, 128) === 255,
      {detached, attached, detachedAgain},
    );

    // features of the view are loaded while it moves only when the layer asks for it
    const loads = async (options: object) => {
      const calls: number[] = [];
      let moving = false;
      const source = new VectorSource({
        strategy: bbox,
        loader: (extent) => {
          if (moving) {
            calls.push(Math.round(extent[0]));
          }
        },
      });
      const loading = new Layer({source, style: circle('#404040'), ...options});
      map.addLayer(loading);
      await settle();
      moving = true;
      await new Promise<void>((resolve) => map.getView().animate({center: [400, 0], duration: 300}, () => resolve()));
      moving = false;
      const during = calls.length;
      await settle();
      map.removeLayer(loading);
      map.getView().setCenter([0, 0]);
      await settle();
      return during;
    };
    const waits = await loads({});
    const follows = await loads({updateWhileAnimating: true});
    check('features are loaded during an animation only with updateWhileAnimating', waits === 0 && follows >= 2, {without: waits, with: follows});
  } catch (e) {
    check('no error', false, String(e));
  }
  (window as any).__removed = results;
})();

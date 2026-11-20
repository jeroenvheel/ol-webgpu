/**
 * Map export (`?layer=webgl2|webgpu`): an app reads the layer canvases in a
 * `rendercomplete` listener (ol dispatches it from a timeout, after the frame
 * was presented). A second layer has no features and must read back empty.
 * Results in window.__export; `window.__clearExport()` then removes the
 * features, so the runner can check from a screenshot that the canvas was
 * cleared and does not keep showing the old frame.
 */
import Feature from 'ol/Feature.js';
import Map from 'ol/Map.js';
import View from 'ol/View.js';
import Polygon from 'ol/geom/Polygon.js';
import VectorSource from 'ol/source/Vector.js';
import {liveRenderers} from '../../src/renderer/BaseGpuVectorRenderer.js';
import WebGL2VectorLayer from '../../src/layer/WebGL2VectorLayer.js';
import WebGPUVectorLayer from '../../src/layer/WebGPUVectorLayer.js';

const params = new URLSearchParams(location.search);
const Layer = params.get('layer') === 'webgpu' ? WebGPUVectorLayer : WebGL2VectorLayer;

const source = new VectorSource({
  features: [new Feature(new Polygon([[[-60, -60], [60, -60], [60, 60], [-60, 60], [-60, -60]]]))],
});
const drawn = new Layer({source, className: 'drawn', style: {'fill-color': '#d7191c'}});
const empty = new Layer({source: new VectorSource(), className: 'empty', style: {'fill-color': '#2c7bb6'}});
const map = new Map({target: 'map', pixelRatio: 1, controls: [], layers: [drawn, empty], view: new View({center: [0, 0], resolution: 1})});

const probe = document.createElement('canvas').getContext('2d', {willReadFrequently: true})!;
function drawnPixels(className: string): number {
  const canvas = document.querySelector(`#map canvas.${className}`) as HTMLCanvasElement;
  probe.canvas.width = canvas.width;
  probe.canvas.height = canvas.height;
  probe.clearRect(0, 0, canvas.width, canvas.height);
  probe.drawImage(canvas, 0, 0);
  const data = probe.getImageData(0, 0, canvas.width, canvas.height).data;
  let n = 0;
  for (let i = 3; i < data.length; i += 4) {
    n += data[i] > 0 ? 1 : 0;
  }
  return n;
}

const settled = () => [...liveRenderers].every((r) => r.ready && r.framesSinceReady >= 1);
const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
const renderComplete = () => new Promise((r) => map.once('rendercomplete', () => r({drawn: drawnPixels('drawn'), empty: drawnPixels('empty')})));

(async () => {
  while (!settled()) {
    await frame();
  }
  const done = renderComplete();
  map.render();
  (window as any).__export = await done;
})();

(window as any).__clearExport = async () => {
  const done = renderComplete();
  source.clear();
  await done;
  await frame();
  await frame();
};

/**
 * Text overlay (`text: 'canvas'`) while the view moves (`?layer=webgl2|webgpu&rotation=0.5`).
 * Labels are drawn by ol's text worker for one frame state; until a new
 * image arrives, frames reproject the last one (ol's overlay matrix). The
 * check pans by whole pixels, reads the canvas in the same task as the
 * render (so the old image + matrix is what is shown) and compares it with
 * the frame before, shifted by the same amount.
 * Result in window.__textPan: {compared, differing} pixel counts.
 */
import Feature from 'ol/Feature.js';
import Map from 'ol/Map.js';
import View from 'ol/View.js';
import Point from 'ol/geom/Point.js';
import VectorSource from 'ol/source/Vector.js';
import {frame, renderersSettled} from './settled.js';
import WebGL2VectorLayer from '../../src/layer/WebGL2VectorLayer.js';
import WebGPUVectorLayer from '../../src/layer/WebGPUVectorLayer.js';

const params = new URLSearchParams(location.search);
const Layer = params.get('layer') === 'webgpu' ? WebGPUVectorLayer : WebGL2VectorLayer;
const rotation = Number(params.get('rotation') ?? 0);

const source = new VectorSource();
for (let i = 0; i < 12; i++) {
  source.addFeature(new Feature({geometry: new Point([((i % 4) - 1.5) * 55, (Math.floor(i / 4) - 1) * 60]), label: `label ${i}`}));
}
const layer = new Layer({
  source,
  text: 'canvas', // this checks the text worker's image; GPU text is checked in gputext.ts and labels.ts
  style: {
    'circle-radius': 3,
    'circle-fill-color': '#2c5e91',
    'text-value': ['get', 'label'],
    'text-font': 'bold 13px sans-serif',
    'text-fill-color': '#d95f02',
    'text-stroke-color': '#ffffff',
    'text-stroke-width': 2,
    'text-offset-y': -12,
  },
});
const map = new Map({target: 'map', pixelRatio: 1, layers: [layer], view: new View({center: [0, 0], resolution: 1, rotation})});

const probe = document.createElement('canvas').getContext('2d', {willReadFrequently: true})!;
function readLayer(): ImageData {
  const canvas = document.querySelector('#map canvas') as HTMLCanvasElement;
  probe.canvas.width = canvas.width;
  probe.canvas.height = canvas.height;
  probe.clearRect(0, 0, canvas.width, canvas.height);
  probe.drawImage(canvas, 0, 0);
  return probe.getImageData(0, 0, canvas.width, canvas.height);
}

const settled = () => renderersSettled(2);

(async () => {
  // First what an app waits for: the map is complete, with the first text image.
  // `settled()` alone is not enough before the first frame: the layer has no renderer
  // yet then, and no renderers are all settled. The first WebGPU page of a run takes
  // longer than the wait below to get its device, and was read before anything was drawn.
  // (Not a render in every frame while waiting: ol's text worker drops the image it is
  // making when the next one is asked for.)
  await new Promise((resolve) => map.once('rendercomplete', resolve));
  for (let i = 0; !settled(); i++) {
    if (i % 20 === 19) {
      map.render(); // `settled` counts frames, and a map that is complete draws no more
    }
    await frame();
  }
  await new Promise((r) => setTimeout(r, 200)); // let the text image settle
  map.renderSync();
  const before = readLayer();
  const [dx, dy] = [23, -17]; // content moves by (-dx, -dy) on screen
  const view = map.getView();
  view.beginInteraction(); // no buffer rebuild, as while dragging
  view.setCenter(map.getCoordinateFromPixel([128 + dx, 128 + dy]));
  map.renderSync();
  const after = readLayer(); // same task: the previous text image, reprojected
  view.endInteraction();

  let compared = 0;
  let differing = 0;
  let textPixels = 0;
  const {width, height} = after;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = x + dx;
      const sy = y + dy;
      if (sx < 0 || sy < 0 || sx >= width || sy >= height) {
        continue;
      }
      const a = (y * width + x) * 4;
      const b = (sy * width + sx) * 4;
      compared++;
      if (before.data[b + 3] > 0) {
        textPixels++;
      }
      if ([0, 1, 2, 3].some((c) => Math.abs(after.data[a + c] - before.data[b + c]) > 2)) {
        differing++;
      }
    }
  }
  (window as any).__textPan = {compared, differing, textPixels};
})();

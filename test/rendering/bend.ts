/**
 * Text of a script whose letters join, along a line with bends
 * (`bend.html?layer=webgl2|webgpu`): the word has to stay in one piece and
 * as long as on a straight line. Result in window.__bend.
 */
import Feature from 'ol/Feature.js';
import Map from 'ol/Map.js';
import View from 'ol/View.js';
import LineString from 'ol/geom/LineString.js';
import VectorSource from 'ol/source/Vector.js';
import {frame, renderersSettled} from './settled.js';
import WebGL2VectorLayer from '../../src/layer/WebGL2VectorLayer.js';
import WebGPUVectorLayer from '../../src/layer/WebGPUVectorLayer.js';

const params = new URLSearchParams(location.search);
const Layer = params.get('layer') === 'webgpu' ? WebGPUVectorLayer : WebGL2VectorLayer;

// One word of seven letters that all join (seen and beh): drawn whole, every column of it has ink.
const word = 'سبسبسبس';
const line = (y: number, points: number[][]) => new Feature({geometry: new LineString(points.map(([x, dy]) => [x, y + dy])), name: word});
const source = new VectorSource({
  features: [
    // straight, then with a bend under the word, then with two
    line(70, [[-110, 0], [110, 0]]),
    line(0, [[-110, -12], [0, 12], [110, -12]]),
    line(-70, [[-110, 0], [-28, 14], [28, 14], [110, 0]]),
  ],
});
const layer = new Layer({
  source,
  style: {
    'stroke-color': '#d0d0d0',
    'stroke-width': 1,
    'text-value': ['get', 'name'],
    'text-placement': 'line',
    'text-font': '40px sans-serif',
    'text-fill-color': '#000000',
    'text-max-angle': 1.5,
  },
});
const map = new Map({target: 'map', pixelRatio: 1, controls: [], layers: [layer], view: new View({center: [0, 0], resolution: 1})});

/**
 * The text in a band of the canvas: from its first to its last column with
 * dark pixels, how wide that is and how many columns in between have none
 * (a word whose letters join has none).
 */
function ink(data: Uint8ClampedArray, width: number, y0: number, y1: number): {width: number; gaps: number} {
  const columns: boolean[] = [];
  for (let x = 0; x < width; x++) {
    let dark = false;
    for (let y = y0; y < y1 && !dark; y++) {
      dark = data[(y * width + x) * 4 + 3] > 128 && data[(y * width + x) * 4] < 100;
    }
    columns.push(dark);
  }
  const first = columns.indexOf(true);
  const last = columns.lastIndexOf(true);
  return {width: last - first + 1, gaps: columns.slice(first, last + 1).filter((c) => !c).length};
}

(async () => {
  map.render();
  for (let i = 0; i < 5 || !(map.isRendered() && renderersSettled()); i++) {
    await frame();
  }
  map.renderSync();
  const canvas = document.querySelector('#map canvas') as HTMLCanvasElement;
  const probe = document.createElement('canvas').getContext('2d', {willReadFrequently: true})!;
  probe.canvas.width = canvas.width;
  probe.canvas.height = canvas.height;
  probe.drawImage(canvas, 0, 0);
  const data = probe.getImageData(0, 0, canvas.width, canvas.height).data;
  // the three lines are at y = 58, 128 and 198 on screen
  (window as any).__bend = {
    straight: ink(data, canvas.width, 20, 93),
    oneBend: ink(data, canvas.width, 93, 163),
    twoBends: ink(data, canvas.width, 163, 236),
  };
})();

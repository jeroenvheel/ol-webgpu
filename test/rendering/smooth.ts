/**
 * `smoothFill` (`smooth.html?layer=webgl2|webgpu`): a fill without a stroke
 * fades out over one pixel outside the polygon. Result in window.__smooth:
 * {name: {ok, detail}}.
 */
import Feature from 'ol/Feature.js';
import Map from 'ol/Map.js';
import View from 'ol/View.js';
import Polygon from 'ol/geom/Polygon.js';
import VectorSource from 'ol/source/Vector.js';
import {frame, renderersSettled} from './settled.js';
import WebGL2VectorLayer from '../../src/layer/WebGL2VectorLayer.js';
import WebGPUVectorLayer from '../../src/layer/WebGPUVectorLayer.js';

const params = new URLSearchParams(location.search);
const Layer = params.get('layer') === 'webgpu' ? WebGPUVectorLayer : WebGL2VectorLayer;

// resolution 1, centre 0,0: the pixel of (X, Y) is (128 + X, 128 - Y)
const triangle = (dx: number) => new Feature(new Polygon([[[-110 + dx, 20], [-10 + dx, 40], [-70 + dx, 110], [-110 + dx, 20]]]));
const AREA = 4100;
const PERIMETER = Math.hypot(100, 20) + Math.hypot(60, 70) + Math.hypot(40, 90);
// A ring with a hole; both rings go the same way round, as data may have them. Not on whole
// coordinates: an edge that runs exactly through pixel centres is a tie between fill and band.
const ring = new Feature(
  new Polygon([
    [[-100.37, -110.21], [-10.43, -100.29], [-20.31, -20.47], [-110.23, -30.13], [-100.37, -110.21]],
    [[-75.37, -80.21], [-40.43, -76.29], [-44.31, -45.47], [-79.23, -50.13], [-75.37, -80.21]],
  ]),
);

const smooth = new Layer({source: new VectorSource({features: [triangle(0)]}), style: {'fill-color': '#d7191c'}, smoothFill: true});
const plain = new Layer({source: new VectorSource({features: [triangle(120)]}), style: {'fill-color': '#d7191c'}});
const translucent = new Layer({source: new VectorSource({features: [ring]}), style: {'fill-color': 'rgba(44, 123, 182, 0.5)'}, smoothFill: true});
// with a stroke there is nothing to smooth: the stroke is the edge
const stroked = new Layer({
  source: new VectorSource({features: [new Feature(new Polygon([[[30, -100], [110, -90], [80, -30], [30, -100]]]))]}),
  style: {'fill-color': '#1a9641', 'stroke-color': '#000000', 'stroke-width': 2},
  smoothFill: true,
});
const map = new Map({target: 'map', pixelRatio: 1, controls: [], layers: [smooth, plain, translucent, stroked], view: new View({center: [0, 0], resolution: 1})});

(async () => {
  const results: Record<string, {ok: boolean; detail: string}> = {};
  const check = (name: string, ok: boolean, detail: unknown) => (results[name] = {ok, detail: JSON.stringify(detail)});
  try {
    map.render();
    for (let i = 0; i < 5 || !(map.isRendered() && renderersSettled()); i++) {
      await frame();
      if (i > 600) {
        throw new Error('the layers did not settle');
      }
    }
    map.renderSync();
    const probe = document.createElement('canvas').getContext('2d', {willReadFrequently: true})!;
    probe.canvas.width = 256;
    probe.canvas.height = 256;
    for (const canvas of document.querySelectorAll('#map canvas')) {
      probe.drawImage(canvas as HTMLCanvasElement, 0, 0);
    }
    const data = probe.getImageData(0, 0, 256, 256).data;
    /** Of a box of the canvas: the alpha of all pixels added up (in pixels), how many are partly covered, and the highest alpha. */
    const box = (x0: number, y0: number, x1: number, y1: number, full = 255) => {
      let sum = 0;
      let partial = 0;
      let highest = 0;
      let over = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const a = data[(y * 256 + x) * 4 + 3];
          sum += a / full;
          partial += a > 8 && a < full - 8 ? 1 : 0;
          highest = Math.max(highest, a);
          over += a > full + 2 ? 1 : 0;
        }
      }
      return {sum: Math.round(sum), partial, highest, over};
    };
    const alphaAt = (x: number, y: number) => data[((128 - y) * 256 + 128 + x) * 4 + 3];

    const a = box(0, 0, 128, 128);
    const b = box(128, 0, 256, 128);
    check('without smoothFill a fill has hard edges', b.partial === 0 && Math.abs(b.sum - AREA) < 0.25 * PERIMETER, {...b, area: AREA});
    // half a pixel more all around: the band is one pixel, from full to nothing
    const more = a.sum - b.sum;
    check('with smoothFill the fill fades out outside the polygon', a.partial > 200 && a.highest === 255 && more > 0.3 * PERIMETER && more < 0.8 * PERIMETER, {
      ...a,
      more,
      perimeter: Math.round(PERIMETER),
    });

    const c = box(0, 128, 128, 256, 128);
    const places = {inside: alphaAt(-25, -60), hole: alphaAt(-60, -63), outside: alphaAt(-120, -120)};
    check(
      'a translucent fill is not darker at its edge, and a hole stays open',
      // The rasterizer puts the corners of a triangle on a grid (1/256 of a pixel with D3D,
      // 1/16 with SwiftShader in CI) and the band works with them as they are: a pixel whose
      // centre is between the two edges gets the fill and the band. A few of them at most.
      c.partial > 150 && c.over <= 0.1 * c.partial && Math.abs(places.inside - 128) <= 2 && places.hole === 0 && places.outside === 0,
      {...c, places},
    );

    // green and black only: no band of the fill outside the stroke
    let outside = 0;
    for (let y = 128; y < 256; y++) {
      for (let x = 128; x < 256; x++) {
        const i = (y * 256 + x) * 4;
        // partly covered pixels are the stroke's own edge: dark, not green
        outside += data[i + 3] > 8 && data[i + 3] < 200 && data[i + 1] > 2 * data[i] + 40 ? 1 : 0;
      }
    }
    check('a fill with a stroke gets no band', outside === 0, {outside});
  } catch (e) {
    check('no error', false, String(e));
  }
  (window as any).__smooth = results;
})();

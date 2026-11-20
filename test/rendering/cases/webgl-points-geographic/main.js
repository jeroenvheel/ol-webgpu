// synced from openlayers v10.11.0 test/rendering/cases/webgl-points-geographic
import Feature from 'ol/Feature.js';
import Map from 'ol/Map.js';
import View from 'ol/View.js';
import Point from 'ol/geom/Point.js';
import TileLayer from 'ol/layer/Tile.js';
import WebGLVector from '../../layer.ts';
import {useGeographic} from 'ol/proj.js';
import VectorSource from 'ol/source/Vector.js';
import XYZ from 'ol/source/XYZ.js';

useGeographic();

const center = [8.6, 50.1];

const point = new Point(center);

new Map({
  layers: [
    new TileLayer({
      source: new XYZ({
        url: '/data/tiles/satellite/{z}/{x}/{y}.jpg',
        transition: 0,
      }),
    }),
    new WebGLVector({
      source: new VectorSource({
        features: [new Feature(point)],
      }),
      style: {
        'icon-src': '/data/icon.png',
      },
    }),
  ],
  target: 'map',
  view: new View({
    center: center,
    zoom: 3,
  }),
});

render();

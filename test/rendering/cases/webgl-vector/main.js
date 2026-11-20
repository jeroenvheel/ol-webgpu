// synced from openlayers v10.11.0 test/rendering/cases/webgl-vector
import Map from 'ol/Map.js';
import View from 'ol/View.js';
import GeoJSON from 'ol/format/GeoJSON.js';
import TileLayer from 'ol/layer/Tile.js';
import WebGLVectorLayer from '../../layer.ts';
import VectorSource from 'ol/source/Vector.js';
import XYZ from 'ol/source/XYZ.js';

const vector = new WebGLVectorLayer({
  source: new VectorSource({
    url: '/data/countries.json',
    format: new GeoJSON(),
  }),
  style: {
    'fill-color': '#ddd',
    'stroke-color': '#eee',
    'stroke-width': 2,
  },
});

const raster = new TileLayer({
  source: new XYZ({
    url: '/data/tiles/satellite/{z}/{x}/{y}.jpg',
    transition: 0,
  }),
});

new Map({
  layers: [raster, vector],
  target: 'map',
  view: new View({
    center: [0, 0],
    zoom: 1,
  }),
});

render({
  message:
    'Countries are rendered as grey polygons using webgl and default shaders',
});

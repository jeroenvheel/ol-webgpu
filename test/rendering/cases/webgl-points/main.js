// synced from openlayers v10.11.0 test/rendering/cases/webgl-points
import Map from 'ol/Map.js';
import View from 'ol/View.js';
import KML from 'ol/format/KML.js';
import TileLayer from 'ol/layer/Tile.js';
import WebGLVectorLayer from '../../layer.ts';
import VectorSource from 'ol/source/Vector.js';
import XYZ from 'ol/source/XYZ.js';
import {createDefaultStyle} from 'ol/style/flat.js';

const vector = new WebGLVectorLayer({
  source: new VectorSource({
    url: '/data/2012_Earthquakes_Mag5.kml',
    format: new KML({
      extractStyles: false,
    }),
  }),
  style: createDefaultStyle(),
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
    center: [15180597.9736, 2700366.3807],
    zoom: 2,
  }),
});

render({
  message: 'Points are rendered using webgl with the default style',
});

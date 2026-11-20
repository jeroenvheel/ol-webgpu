import Feature from 'ol/Feature.js';
import LineString from 'ol/geom/LineString.js';
import Point from 'ol/geom/Point.js';
import Polygon from 'ol/geom/Polygon.js';

export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const EXTENT = 1.8e7;

export function makePoints(count: number, seed = 1): Feature[] {
  const r = rng(seed);
  const out = new Array<Feature>(count);
  for (let i = 0; i < count; i++) {
    const f = new Feature(new Point([(r() - 0.5) * 2 * EXTENT, (r() - 0.5) * EXTENT]));
    f.set('size', 2 + Math.floor(r() * 6));
    f.set('kind', i % 4);
    out[i] = f;
  }
  return out;
}

export function makeLines(count: number, vertices = 10, seed = 2): Feature[] {
  const r = rng(seed);
  const out = new Array<Feature>(count);
  for (let i = 0; i < count; i++) {
    let x = (r() - 0.5) * 2 * EXTENT;
    let y = (r() - 0.5) * EXTENT;
    const coords: number[][] = [];
    for (let k = 0; k < vertices; k++) {
      coords.push([x, y]);
      x += (r() - 0.5) * 2e5;
      y += (r() - 0.5) * 2e5;
    }
    const f = new Feature(new LineString(coords));
    f.set('width', 1 + Math.floor(r() * 3));
    f.set('kind', i % 4);
    out[i] = f;
  }
  return out;
}

export function makePolygons(count: number, vertices = 12, seed = 3): Feature[] {
  const r = rng(seed);
  const out = new Array<Feature>(count);
  for (let i = 0; i < count; i++) {
    const cx = (r() - 0.5) * 2 * EXTENT;
    const cy = (r() - 0.5) * EXTENT;
    const radius = 2e4 + r() * 8e4;
    const ring: number[][] = [];
    for (let k = 0; k < vertices; k++) {
      const a = (k * 2 * Math.PI) / vertices;
      const rr = radius * (0.5 + 0.5 * r());
      ring.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
    }
    ring.push(ring[0].slice());
    const f = new Feature(new Polygon([ring]));
    f.set('kind', i % 4);
    f.set('width', 1);
    out[i] = f;
  }
  return out;
}

/** A representative data-driven flat style used by benchmarks and examples. */
export const benchStyle = {
  'fill-color': ['match', ['get', 'kind'], 0, '#1b9e77aa', 1, '#d95f02aa', 2, '#7570b3aa', '#e7298aaa'],
  'stroke-color': ['match', ['get', 'kind'], 0, '#1b9e77', 1, '#d95f02', 2, '#7570b3', '#e7298a'],
  'stroke-width': ['get', 'width'],
  'circle-radius': ['get', 'size'],
  'circle-fill-color': ['match', ['get', 'kind'], 0, '#1b9e77', 1, '#d95f02', 2, '#7570b3', '#e7298a'],
} as const;

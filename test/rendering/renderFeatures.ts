/**
 * Turns `ol/Feature`s into the RenderFeatures (`ol/render/Feature`) a
 * vector tile format would read for the same shapes, as `ol/format/MVT`
 * makes them: Multi* only for points and lines; a polygon, also one with
 * several outer rings, is one 'Polygon' with all rings in one list, outer
 * rings counter-clockwise and holes clockwise, split again by orientation.
 */
import type Feature from 'ol/Feature.js';
import RenderFeature from 'ol/render/Feature.js';

export function toRenderFeature(feature: Feature): RenderFeature {
  const geometry: any = feature.getGeometry();
  const type: string = geometry.getType();
  if (geometry.getStride() !== 2) {
    throw new Error('only XY geometries');
  }
  let flat: number[];
  let ends: number[];
  switch (type) {
    case 'Point':
      flat = geometry.getFlatCoordinates().slice(0, 2);
      ends = [];
      break;
    case 'MultiPoint':
    case 'LineString':
      flat = geometry.getFlatCoordinates().slice();
      ends = [flat.length];
      break;
    case 'MultiLineString':
      flat = geometry.getFlatCoordinates().slice();
      ends = geometry.getEnds().slice();
      break;
    case 'Polygon':
      flat = geometry.getOrientedFlatCoordinates().slice();
      ends = geometry.getEnds().slice();
      break;
    case 'MultiPolygon':
      flat = geometry.getOrientedFlatCoordinates().slice();
      ends = geometry.getEndss().flat();
      break;
    default:
      throw new Error(`no RenderFeature for a ${type}`);
  }
  const properties = {...feature.getProperties()};
  delete properties[feature.getGeometryName()];
  return new RenderFeature(type === 'MultiPolygon' ? 'Polygon' : (type as any), flat, ends, 2, properties, feature.getId());
}

export const toRenderFeatures = (features: Feature[]) => features.map(toRenderFeature);

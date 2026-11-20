/**
 * Backend-neutral description of how a flat style is drawn, built from ol's
 * own style compiler (`convertStyleToShaders` → ShaderBuilder). Mirrors the
 * render pass setup in `ol/render/webgl/VectorStyleRenderer.js` (ol 10.11),
 * so buffers and shaders are laid out exactly as ol lays them out.
 */
import type {FlatStyleLike} from 'ol/style/flat.js';
import {convertStyleToShaders, toFlatStyleLike} from 'ol/render/webgl/VectorStyleRenderer.js';
import {getCustomAttributesSize} from 'ol/render/webgl/renderinstructions.js';
import {hasTextStyle} from 'ol/render/webgl/textUtil.js';

/** Same names as `Attributes` in VectorStyleRenderer.js. */
export const Attributes = {
  POSITION: 'a_position',
  LOCAL_POSITION: 'a_localPosition',
  SEGMENT_START: 'a_segmentStart',
  SEGMENT_END: 'a_segmentEnd',
  MEASURE_START: 'a_measureStart',
  MEASURE_END: 'a_measureEnd',
  ANGLE_TANGENT_SUM: 'a_angleTangentSum',
  JOIN_ANGLES: 'a_joinAngles',
  DISTANCE_LOW: 'a_distanceLow',
  DISTANCE_HIGH: 'a_distanceHigh',
} as const;

/** One float attribute in an interleaved buffer; `name: null` is padding. */
export interface AttributeDesc {
  name: string | null;
  size: number;
}

export type GeometryKind = 'polygon' | 'line' | 'point';

export interface SubPass {
  kind: GeometryKind;
  vertexShader: string;
  fragmentShader: string;
  /** Per-vertex attributes (buffer 0). */
  attributes: AttributeDesc[];
  /** Per-instance attributes (buffer 1); empty for polygons. */
  instanced: AttributeDesc[];
}

export interface StylePass {
  fill?: SubPass;
  stroke?: SubPass;
  symbol?: SubPass;
}

export interface AttributeDefinition {
  size?: number;
  callback: (this: any, feature: any) => number | number[];
}

/** ol's UniformValue: a value or a function of the frame state. */
export type UniformValue = any;

export interface StylePasses {
  passes: StylePass[];
  customAttributes: Record<string, AttributeDefinition>;
  customSize: number;
  /** Position of the feature ref inside the custom attributes. */
  refOffset: number;
  uniforms: Record<string, UniformValue>;
  hasFill: boolean;
  hasStroke: boolean;
  hasSymbol: boolean;
  hasText: boolean;
}

/** Name of the custom attribute holding the feature ref (for CPU picking). */
export const REF_ATTRIBUTE = 'olgpuRef';

export function buildStylePasses(style: FlatStyleLike, variables: Record<string, any>): StylePasses {
  const styleShaders = convertStyleToShaders(style as any, variables);

  // the ref goes first so its offset is always 0
  const customAttributes: Record<string, AttributeDefinition> = {
    [REF_ATTRIBUTE]: {
      size: 1,
      callback(this: {ref?: number}) {
        return this.ref ?? 0;
      },
    },
  };
  const uniforms: Record<string, UniformValue> = {};
  for (const s of styleShaders) {
    for (const name in s.attributes) {
      if (!(name in customAttributes)) {
        customAttributes[name] = s.attributes[name] as AttributeDefinition;
      }
    }
    for (const name in s.uniforms) {
      if (!(name in uniforms)) {
        uniforms[name] = s.uniforms[name];
      }
    }
  }

  const passes = styleShaders.map((s) => {
    const custom: AttributeDesc[] = Object.entries(customAttributes).map(([name, def]) => ({
      name: name in s.attributes ? `a_${name}` : null,
      size: def.size || 1,
    }));
    const pass: StylePass = {};
    const b = s.builder;
    if (b.getFillVertexShader()) {
      pass.fill = {
        kind: 'polygon',
        vertexShader: b.getFillVertexShader()!,
        fragmentShader: b.getFillFragmentShader()!,
        attributes: [{name: Attributes.POSITION, size: 2}, ...custom],
        instanced: [],
      };
    }
    if (b.getStrokeVertexShader()) {
      pass.stroke = {
        kind: 'line',
        vertexShader: b.getStrokeVertexShader()!,
        fragmentShader: b.getStrokeFragmentShader()!,
        attributes: [{name: Attributes.LOCAL_POSITION, size: 2}],
        instanced: [
          {name: Attributes.SEGMENT_START, size: 2},
          {name: Attributes.MEASURE_START, size: 1},
          {name: Attributes.SEGMENT_END, size: 2},
          {name: Attributes.MEASURE_END, size: 1},
          {name: Attributes.JOIN_ANGLES, size: 2},
          {name: Attributes.DISTANCE_LOW, size: 1},
          {name: Attributes.DISTANCE_HIGH, size: 1},
          {name: Attributes.ANGLE_TANGENT_SUM, size: 1},
          ...custom,
        ],
      };
    }
    if (b.getSymbolVertexShader()) {
      pass.symbol = {
        kind: 'point',
        vertexShader: b.getSymbolVertexShader()!,
        fragmentShader: b.getSymbolFragmentShader()!,
        attributes: [{name: Attributes.LOCAL_POSITION, size: 2}],
        instanced: [{name: Attributes.POSITION, size: 2}, ...custom],
      };
    }
    return pass;
  });

  const flat = toFlatStyleLike(style as any);
  return {
    passes,
    customAttributes,
    customSize: getCustomAttributesSize(customAttributes as any),
    refOffset: 0,
    uniforms,
    hasFill: passes.some((p) => p.fill),
    hasStroke: passes.some((p) => p.stroke),
    hasSymbol: passes.some((p) => p.symbol),
    hasText: !!flat && hasTextStyle(flat),
  };
}

export function stride(attrs: AttributeDesc[]): number {
  return attrs.reduce((sum, a) => sum + a.size, 0);
}

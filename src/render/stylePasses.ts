/**
 * Backend-neutral description of how a flat style is drawn, built from ol's
 * own style compiler (`convertStyleToShaders` → ShaderBuilder). Mirrors the
 * render pass setup in `ol/render/webgl/VectorStyleRenderer.js` (ol 10.11),
 * so buffers and shaders are laid out exactly as ol lays them out.
 */
import type {FlatStyleLike} from 'ol/style/flat.js';
import {Attributes, convertStyleToShaders, toFlatStyleLike} from 'ol/render/webgl/VectorStyleRenderer.js';
import {stringToGlsl} from 'ol/expr/gpu.js';
import {getCustomAttributesSize} from 'ol/render/webgl/renderinstructions.js';
import {hasTextStyle} from 'ol/render/webgl/textUtil.js';
import {FADE} from '../text/shaders.js';
import {styleOrder} from './order.js';

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
  /** The soft edge of a fill without a stroke (see `buildStylePasses`). */
  edge?: SubPass;
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
  hasEdge: boolean;
  hasStroke: boolean;
  hasSymbol: boolean;
  hasText: boolean;
}

/** Name of the custom attribute holding the feature ref (for CPU picking). */
export const REF_ATTRIBUTE = 'olgpuRef';

/** Width in pixels of the band outside a polygon in which its fill fades out. */
const EDGE_WIDTH = 1;

/**
 * @param smoothFill Fills without a stroke get an `edge` sub pass: the rings
 *   of the polygons drawn as lines with ol's stroke shader, in the fill
 *   colour, fading from the edge of the polygon to nothing `EDGE_WIDTH`
 *   pixels outside it. The rasterizer fills the pixels whose centre is
 *   inside a polygon, which gives stairs; the band covers the stairs. The
 *   rings come from the worker with the fill on their left (see
 *   `edgeInstructions`), so "outside" is to the right of the line.
 */
/**
 * The style without its `text-*` properties, with as many styles in the
 * same places. ol compiles those properties too, for its text worker: every
 * property a text reads becomes an attribute of every vertex, and every
 * text a feature has gets a number in a table that is never emptied
 * (`getStringNumberEquivalent`). Labels drawn by the layer itself read the
 * features, not the attributes.
 */
function withoutText(style: FlatStyleLike): FlatStyleLike {
  const strip = (flat: any): any => {
    if (!flat || typeof flat !== 'object' || !Object.keys(flat).some((key) => key.startsWith('text-'))) {
      return flat;
    }
    return Object.fromEntries(Object.entries(flat).filter(([key]) => !key.startsWith('text-')));
  };
  const one = (item: any): any => {
    if (!item || typeof item !== 'object' || 'builder' in item) {
      return item;
    }
    if ('style' in item) {
      return {...item, style: Array.isArray(item.style) ? item.style.map(strip) : strip(item.style)};
    }
    return strip(item);
  };
  return (Array.isArray(style) ? style.map(one) : one(style)) as FlatStyleLike;
}

/**
 * The fade of a symbol that takes part in decluttering: an attribute per
 * symbol (in the place the ref has in the instructions, which the GPU does
 * not read) with the number the labels have too (see `SHOWN` in
 * text/shaders.ts), and the time to make an opacity of it.
 */
export const FADE_ATTRIBUTE = 'a_olgFade';
export const FADE_TIME_UNIFORM = 'u_olgFadeTime';

/** The time of the fades of symbols, in seconds: never so small that a symbol that is shown looks like one that fades in. */
export function fadeClock(): number {
  return performance.now() / 1000 + 1;
}

/**
 * @param textAttributes also the attributes of the `text-*` properties, which only ol's text worker reads
 * @param symbolFade symbols fade in and out by `FADE_ATTRIBUTE`
 */
export function buildStylePasses(style: FlatStyleLike, variables: Record<string, any>, smoothFill = false, textAttributes = true, symbolFade = false): StylePasses {
  const styleShaders = convertStyleToShaders((textAttributes ? style : withoutText(style)) as any, variables);

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
    const lineAttributes = (): Pick<SubPass, 'attributes' | 'instanced'> => ({
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
    });
    if (b.getStrokeVertexShader()) {
      pass.stroke = {
        kind: 'line',
        vertexShader: b.getStrokeVertexShader()!,
        fragmentShader: b.getStrokeFragmentShader()!,
        ...lineAttributes(),
      };
    } else if (smoothFill && pass.fill && !/pattern|texture/i.test(b.getFillColorExpression())) {
      // The stroke shader of this builder, with the fill colour. In its fragment
      // shader `currentRadiusRatio * v_width / 2` is the distance to the line
      // in pixels, positive to its left: inside the polygon. (The builder is not
      // used after this.)
      const outside = 'clamp(1.0 + currentRadiusRatio * v_width * 0.5 / ' + EDGE_WIDTH.toFixed(1) + ', 0.0, 1.0) * step(currentRadiusRatio, 0.0)';
      b.setStrokeWidthExpression((2 * EDGE_WIDTH).toFixed(1));
      b.setStrokeColorExpression(`((${b.getFillColorExpression()}) * vec4(1.0, 1.0, 1.0, ${outside}))`);
      // segments that do not overlap where they meet, or a translucent fill is darker there
      b.setStrokeJoinExpression(stringToGlsl('miter'));
      pass.edge = {
        kind: 'line',
        vertexShader: b.getStrokeVertexShader()!,
        fragmentShader: b.getStrokeFragmentShader()!,
        ...lineAttributes(),
      };
    }
    if (b.getSymbolVertexShader()) {
      let instanced = custom;
      if (symbolFade) {
        // After the fills and strokes were made: only the symbols get the attribute.
        // (The builder is not used after this.)
        const seconds = (FADE / 1000).toFixed(3);
        const progress = `clamp((${FADE_TIME_UNIFORM} - abs(${FADE_ATTRIBUTE})) / ${seconds}, 0.0, 1.0)`;
        b.addUniform(FADE_TIME_UNIFORM, 'float');
        b.addAttribute(FADE_ATTRIBUTE, 'float');
        b.setSymbolColorExpression(`((${b.getSymbolColorExpression()}) * vec4(1.0, 1.0, 1.0, mix(1.0 - ${progress}, ${progress}, step(0.0, ${FADE_ATTRIBUTE}))))`);
        uniforms[FADE_TIME_UNIFORM] = fadeClock;
        instanced = custom.map((attribute, i) => (i === 0 ? {...attribute, name: FADE_ATTRIBUTE} : attribute));
      }
      pass.symbol = {
        kind: 'point',
        vertexShader: b.getSymbolVertexShader()!,
        fragmentShader: b.getSymbolFragmentShader()!,
        attributes: [{name: Attributes.LOCAL_POSITION, size: 2}],
        instanced: [{name: Attributes.POSITION, size: 2}, ...instanced],
      };
    }
    return pass;
  });

  // styles with a number as `z-index` are drawn in the order of those numbers
  const order = styleOrder(style);
  if (order && order.length === passes.length) {
    const inOrder = order.map((position) => passes[position]);
    passes.splice(0, passes.length, ...inOrder);
  }

  const flat = toFlatStyleLike(style as any);
  return {
    passes,
    customAttributes,
    customSize: getCustomAttributesSize(customAttributes as any),
    refOffset: 0,
    uniforms,
    hasFill: passes.some((p) => p.fill),
    hasEdge: passes.some((p) => p.edge),
    hasStroke: passes.some((p) => p.stroke),
    hasSymbol: passes.some((p) => p.symbol),
    hasText: !!flat && hasTextStyle(flat),
  };
}

export function stride(attrs: AttributeDesc[]): number {
  return attrs.reduce((sum, a) => sum + a.size, 0);
}

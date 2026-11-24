/**
 * CPU hit detection. The worker builds a packed R-tree (Rust) over the
 * rendered geometries, in "build pixels": (world - center) / resolution at
 * the time the buffers were built. Queries run synchronously in a
 * main-thread wasm instance, then each candidate is checked against the
 * parts of its style that decide a hit: filter, symbol size and where the
 * symbol is drawn (displacement, anchor, rotation), stroke width and offset,
 * and fill. These are evaluated per property with ol's CPU expression
 * evaluator, so a missing property only disables the part that uses it
 * (the GPU then draws a degenerate primitive too).
 *
 * Unlike ol's GPU hit detection this works for WebGPU (where readback is
 * async), honours `hitTolerance`, applies the style filter, and returns all
 * features under a pixel, topmost first.
 */
import type {FeatureLike} from 'ol/Feature.js';
import type {FrameState} from 'ol/Map.js';
import type {Coordinate} from 'ol/coordinate.js';
import {buildExpression, newEvaluationContext} from 'ol/expr/cpu.js';
import {BooleanType, NumberArrayType, NumberType, computeGeometryType, newParsingContext} from 'ol/expr/expression.js';
import type {FlatStyle, FlatStyleLike, Rule} from 'ol/style/flat.js';
import {type Core, HIT_KIND_LINE, HIT_KIND_POINT, HIT_KIND_POLYGON, HIT_WORDS} from '../wasm/core.js';

/**
 * How far from a geometry is searched, in CSS pixels, while the sizes of
 * the features are not known yet (see `measure`). Sizes that are known are
 * searched as far as they reach.
 */
export const MAX_PICK_RADIUS_PX = 128;

const ZOOM_VAR = '__olgpu_zoom';
const TIME_VAR = '__olgpu_time';

/**
 * ol's CPU evaluator lacks some GPU-only operators. For picking, `zoom` and
 * `time` become variables set per query; `line-metric`, `band` and
 * `palette` (meaningless for a hit test) become neutral literals.
 */
function cpuCompatible(value: any): any {
  if (!Array.isArray(value)) {
    return value;
  }
  switch (value[0]) {
    case 'zoom':
      return ['var', ZOOM_VAR];
    case 'time':
      return ['var', TIME_VAR];
    case 'line-metric':
    case 'band':
      return 0;
    case 'palette':
      return [0, 0, 0, 1];
    default:
      return value.map(cpuCompatible);
  }
}

type Evaluator<T> = ((ctx: any) => T) | null;

/** Operators whose value differs per feature / per view. */
const FEATURE_OPS = new Set(['get', 'has', 'id', 'geometry-type', 'line-metric']);
const VIEW_OPS = new Set(['var', 'zoom', 'resolution', 'time']);

function usesOps(value: unknown, ops: Set<string>): boolean {
  return Array.isArray(value) && ((typeof value[0] === 'string' && ops.has(value[0])) || value.some((v) => usesOps(v, ops)));
}

/**
 * How the size of a symbol or stroke varies:
 * - 'shared': same for all features (constant, or only variables/zoom/time):
 *   evaluated per query;
 * - 'feature': depends only on feature data: measured once per rebuild;
 * - 'mixed': depends on both: measured per zoom + variable values.
 */
type SizeKind = 'shared' | 'feature' | 'mixed';
function sizeKind(values: unknown[]): SizeKind {
  const feature = values.some((v) => usesOps(v, FEATURE_OPS));
  const view = values.some((v) => usesOps(v, VIEW_OPS));
  return !feature ? 'shared' : view ? 'mixed' : 'feature';
}

function compile<T>(value: unknown, type: number): Evaluator<T> {
  if (value === undefined) {
    return null;
  }
  try {
    return buildExpression(cpuCompatible(value), type, newParsingContext()) as (ctx: any) => T;
  } catch {
    return null; // e.g. GPU-only constructs: this part is then ignored
  }
}

function run<T>(evaluator: Evaluator<T>, ctx: any): T | undefined {
  if (!evaluator) {
    return undefined;
  }
  try {
    return evaluator(ctx);
  } catch {
    return undefined; // e.g. missing property where a number is required
  }
}

const iconSizes = new Map<string, [number, number]>();
function iconSize(src: string): [number, number] | undefined {
  if (!iconSizes.has(src) && typeof Image !== 'undefined') {
    iconSizes.set(src, [0, 0]);
    const img = new Image();
    img.onload = () => iconSizes.set(src, [img.naturalWidth, img.naturalHeight]);
    img.src = src;
  }
  return iconSizes.get(src);
}

interface CompiledStyle {
  fill: boolean;
  stroke: boolean;
  strokeWidth: Evaluator<number>;
  symbol: 'circle' | 'shape' | 'icon' | null;
  radius: Evaluator<number>;
  radius2: Evaluator<number>;
  symbolStrokeWidth: Evaluator<number>;
  scale: Evaluator<number | number[]>;
  displacement: Evaluator<number[]>;
  rotation: Evaluator<number>;
  rotateWithView: boolean;
  anchor: Evaluator<number[]>;
  anchorOrigin: unknown;
  anchorXPixels: boolean;
  anchorYPixels: boolean;
  strokeOffset: Evaluator<number>;
  iconWidth: Evaluator<number>;
  iconHeight: Evaluator<number>;
  iconSrc: string | null;
  symbolSize: SizeKind;
  strokeSize: SizeKind;
  /** Sizes change with `time`: never measurable ahead. */
  timeDependent: boolean;
}

function compileStyle(s: FlatStyle): CompiledStyle {
  const style = s as Record<string, unknown>;
  const symbol = 'circle-radius' in style ? 'circle' : 'shape-points' in style ? 'shape' : 'icon-src' in style ? 'icon' : null;
  const p = symbol === 'circle' ? 'circle' : symbol === 'shape' ? 'shape' : 'icon';
  const symbolSizes = [
    style[`${p}-radius`],
    style['shape-radius2'],
    style[`${p}-stroke-width`],
    style[`${p}-scale`],
    style['icon-width'],
    style['icon-height'],
    style[`${p}-displacement`],
    style['icon-anchor'],
  ];
  const strokeSizes = [style['stroke-width'], style['stroke-offset']];
  return {
    fill: 'fill-color' in style || 'fill-pattern-src' in style,
    stroke: 'stroke-color' in style || 'stroke-pattern-src' in style,
    strokeWidth: compile<number>(style['stroke-width'] ?? 1, NumberType),
    symbol,
    radius: compile<number>(style[`${p}-radius`], NumberType),
    radius2: compile<number>(style['shape-radius2'], NumberType),
    symbolStrokeWidth: compile<number>(style[`${p}-stroke-width`], NumberType),
    scale: compile<number | number[]>(style[`${p}-scale`], NumberType | NumberArrayType),
    displacement: compile<number[]>(style[`${p}-displacement`], NumberArrayType),
    rotation: compile<number>(style[`${p}-rotation`], NumberType),
    rotateWithView: !!style[`${p}-rotate-with-view`],
    anchor: compile<number[]>(style['icon-anchor'], NumberArrayType),
    anchorOrigin: style['icon-anchor-origin'],
    anchorXPixels: style['icon-anchor-x-units'] === 'pixels',
    anchorYPixels: style['icon-anchor-y-units'] === 'pixels',
    strokeOffset: compile<number>(style['stroke-offset'], NumberType),
    iconWidth: compile<number>(style['icon-width'], NumberType),
    iconHeight: compile<number>(style['icon-height'], NumberType),
    iconSrc: typeof style['icon-src'] === 'string' ? (style['icon-src'] as string) : null,
    symbolSize: sizeKind(symbolSizes),
    strokeSize: sizeKind(strokeSizes),
    timeDependent: [...symbolSizes, ...strokeSizes].some((v) => usesOps(v, new Set(['time']))),
  };
}

interface CompiledRule {
  filter: Evaluator<boolean>;
  /** For `else` rules: filters of all previous rules. */
  previous: Array<Evaluator<boolean>>;
  isElse: boolean;
  styles: CompiledStyle[];
}

/** Same rule semantics as ol's WebGL `convertStyleToShaders`. */
function compileRules(style: FlatStyleLike): CompiledRule[] {
  const list = (Array.isArray(style) ? style : [style]) as any[];
  const rules: Rule[] =
    list.length && 'style' in list[0]
      ? (list as Rule[])
      : list.map((s) => {
          const {filter, ...rest} = s;
          return {filter, style: rest};
        });
  const previous: Array<Evaluator<boolean>> = [];
  return rules.map((rule) => {
    const filter = compile<boolean>(rule.filter, BooleanType);
    const compiled: CompiledRule = {
      filter,
      previous: rule.else ? previous.slice() : [],
      isElse: !!rule.else,
      styles: (Array.isArray(rule.style) ? rule.style : [rule.style]).map(compileStyle),
    };
    if (rule.filter !== undefined) {
      previous.push(filter);
    }
    return compiled;
  });
}

/**
 * Where a symbol is drawn, in CSS pixels with y up, as ol's shaders place
 * it: its centre relative to the point (before the rotation of the symbol
 * turns that as well), and its half size. `round`: a circle of radius
 * `halfWidth`, else a rectangle.
 */
interface SymbolBox {
  x: number;
  y: number;
  halfWidth: number;
  halfHeight: number;
  round: boolean;
  /** Clockwise, without the rotation of the view. */
  rotation: number;
}
const box: SymbolBox = {x: 0, y: 0, halfWidth: 0, halfHeight: 0, round: true, rotation: 0};

/** The box of a symbol for the feature of `ctx` (shared: copy what is kept), or null when nothing is drawn. */
function symbolBox(s: CompiledStyle, ctx: any): SymbolBox | null {
  const scaleValue = run(s.scale, ctx) ?? 1;
  const scaleX = Math.abs(Array.isArray(scaleValue) ? scaleValue[0] : scaleValue);
  const scaleY = Math.abs(Array.isArray(scaleValue) ? scaleValue[1] : scaleValue);
  const displacement = run(s.displacement, ctx);
  box.x = displacement?.[0] ?? 0;
  box.y = displacement?.[1] ?? 0;
  box.rotation = run(s.rotation, ctx) ?? 0;
  if (s.symbol === 'icon') {
    const size = s.iconSrc ? iconSize(s.iconSrc) : undefined;
    const w = (run(s.iconWidth, ctx) ?? size?.[0] ?? 0) * scaleX;
    const h = (run(s.iconHeight, ctx) ?? size?.[1] ?? 0) * scaleY;
    const anchor = run(s.anchor, ctx);
    if (anchor) {
      // as `parseIconProperties` of ol/render/webgl/style.js
      const shiftX = anchor[0] * (s.anchorXPixels ? scaleX : w);
      const shiftY = anchor[1] * (s.anchorYPixels ? scaleX : h);
      switch (s.anchorOrigin) {
        case 'top-right':
          box.x += -w / 2 + shiftX;
          box.y += -h / 2 + shiftY;
          break;
        case 'bottom-left':
          box.x += w / 2 - shiftX;
          box.y += h / 2 - shiftY;
          break;
        case 'bottom-right':
          box.x += -w / 2 + shiftX;
          box.y += h / 2 - shiftY;
          break;
        default:
          box.x += w / 2 - shiftX;
          box.y += -h / 2 + shiftY;
      }
    }
    box.halfWidth = w / 2;
    box.halfHeight = h / 2;
    box.round = false;
    return box;
  }
  const r = run(s.radius, ctx);
  if (r === undefined || !(r > 0)) {
    return null;
  }
  const r2 = run(s.radius2, ctx) ?? 0;
  const stroke = run(s.symbolStrokeWidth, ctx) ?? 0;
  box.halfWidth = box.halfHeight = (Math.max(r, r2) + Math.max(stroke, 0) / 2) * Math.max(scaleX, scaleY);
  box.round = true;
  return box;
}

/** How far from its point a symbol reaches, or -1 when nothing is drawn. */
function symbolReach(s: CompiledStyle, ctx: any): number {
  const b = symbolBox(s, ctx);
  return b ? Math.hypot(b.x, b.y) + (b.round ? b.halfWidth : Math.hypot(b.halfWidth, b.halfHeight)) : -1;
}

/** How far from its line a stroke reaches. */
function strokeReach(s: CompiledStyle, ctx: any): number {
  return (run(s.strokeWidth, ctx) ?? 0) / 2 + Math.abs(run(s.strokeOffset, ctx) ?? 0);
}

export interface IndexState {
  center: Coordinate;
  resolution: number;
}

/** Minimal view of MixedGeometryBatch used to measure sizes. */
export interface MeasurableBatch {
  pointBatch: {entries: Record<string, {feature: FeatureLike}>};
  lineStringBatch: {entries: Record<string, {feature: FeatureLike}>};
}

export class Picker {
  private state: IndexState | null = null;
  /** This layer's index in the core, which holds those of all layers (0: none). */
  private index = 0;
  private rules: CompiledRule[];
  private readonly ctx = newEvaluationContext();
  private readonly start = Date.now();
  /** How far symbols and strokes reach from their geometry at most (CSS px) over all features, for one view key. */
  private measured: {key: string; point: number; line: number} | null = null;
  private measuring: string | null = null;
  private measureToken = 0;
  private batch: MeasurableBatch | null = null;
  /** Revision of the source the sizes were (or are being) measured for. */
  private measuredRevision = -1;
  private styles: CompiledStyle[];

  constructor(
    readonly core: Core,
    style: FlatStyleLike,
    private variables: Record<string, any>,
  ) {
    this.rules = compileRules(style);
    this.styles = this.rules.flatMap((r) => r.styles);
  }

  setStyle(style: FlatStyleLike, variables: Record<string, any>) {
    this.variables = variables;
    this.rules = compileRules(style);
    this.styles = this.rules.flatMap((r) => r.styles);
    this.measured = null;
    this.measuring = null;
    this.measureToken++;
  }

  /** Variables as seen by the evaluator, including the zoom/time stand-ins. */
  private frameVariables(frameState: FrameState): Record<string, any> {
    return {...this.variables, [ZOOM_VAR]: frameState.viewState.zoom, [TIME_VAR]: (Date.now() - this.start) / 1000};
  }

  /** Measured sizes are valid for this key: '' unless sizes also depend on the view. */
  private viewKey(frameState: FrameState): string {
    const mixed = this.styles.some((s) => (s.symbol && s.symbolSize === 'mixed') || (s.stroke && s.strokeSize === 'mixed'));
    return mixed ? `${frameState.viewState.zoom}|${JSON.stringify(this.variables)}` : '';
  }

  /**
   * Measures, in idle time and in chunks, how far the symbols and strokes of
   * all features reach from their geometry when that depends on feature data. Until
   * it finishes, picking searches the conservative MAX_PICK_RADIUS_PX.
   * The sizes do not depend on the extent that is rendered: they are kept
   * while the features (`revision` of the source) stay the same.
   */
  measure(batch: MeasurableBatch, frameState: FrameState, revision: number) {
    const key = this.viewKey(frameState);
    if (batch === this.batch && revision === this.measuredRevision && (this.measured?.key === key || this.measuring === key)) {
      return;
    }
    this.batch = batch;
    this.measuredRevision = revision;
    this.measured = null;
    this.startMeasure(frameState);
  }

  private startMeasure(frameState: FrameState) {
    const token = ++this.measureToken;
    const batch = this.batch;
    const styles = this.styles;
    const needPoints = styles.some((s) => s.symbol && s.symbolSize !== 'shared');
    const needLines = styles.some((s) => s.stroke && s.strokeSize !== 'shared');
    if (!batch || (!needPoints && !needLines) || styles.some((s) => s.timeDependent)) {
      this.measuring = null;
      return;
    }
    const key = this.viewKey(frameState);
    this.measuring = key;
    const lists: Array<[FeatureLike[], 'point' | 'line']> = [];
    if (needPoints) {
      lists.push([Object.values(batch.pointBatch.entries).map((e) => e.feature), 'point']);
    }
    if (needLines) {
      lists.push([Object.values(batch.lineStringBatch.entries).map((e) => e.feature), 'line']);
    }
    const variables = this.frameVariables(frameState);
    const resolution = frameState.viewState.resolution;
    const result = {key, point: 0, line: 0};
    let list = 0;
    let index = 0;
    const idle = (cb: () => void) =>
      typeof requestIdleCallback === 'function' ? requestIdleCallback(cb, {timeout: 200}) : setTimeout(cb, 0);
    const step = (deadline?: IdleDeadline) => {
      if (token !== this.measureToken) {
        return;
      }
      const end = performance.now() + Math.max(deadline?.timeRemaining() ?? 0, 8);
      while (list < lists.length && performance.now() < end) {
        const [features, kind] = lists[list];
        for (let k = 0; k < 4000 && index < features.length; k++, index++) {
          const ctx = this.prepareContext(features[index], variables, resolution);
          for (const s of styles) {
            if (kind === 'point' && s.symbol) {
              result.point = Math.max(result.point, symbolReach(s, ctx));
            } else if (kind === 'line' && s.stroke) {
              result.line = Math.max(result.line, strokeReach(s, ctx));
            }
          }
        }
        if (index >= features.length) {
          list++;
          index = 0;
        }
      }
      if (list < lists.length) {
        idle(step);
      } else {
        this.measured = result;
        this.measuring = null;
      }
    };
    idle(step);
  }

  /** True when picking can use a tight search radius (sizes known for this view). */
  isMeasured(frameState: FrameState): boolean {
    const styles = this.styles;
    if (!styles.some((s) => (s.symbol && s.symbolSize !== 'shared') || (s.stroke && s.strokeSize !== 'shared'))) {
      return true;
    }
    return this.measured?.key === this.viewKey(frameState);
  }

  /** How far from a geometry something of it can be drawn, in CSS px, for this frame. */
  private bound(frameState: FrameState): number {
    let bound = 0;
    const key = this.viewKey(frameState);
    const measured = this.measured?.key === key ? this.measured : null;
    const variables = this.frameVariables(frameState);
    for (const s of this.styles) {
      for (const [has, size, kind] of [
        [!!s.symbol, s.symbolSize, 'point'],
        [s.stroke, s.strokeSize, 'line'],
      ] as const) {
        if (!has) {
          continue;
        }
        if (size === 'shared') {
          const ctx = this.prepareContext(null, variables, frameState.viewState.resolution);
          const r = kind === 'point' ? symbolReach(s, ctx) : strokeReach(s, ctx);
          bound = Math.max(bound, r);
          continue;
        }
        if (!measured) {
          if (this.measuring !== key && !s.timeDependent) {
            this.startMeasure(frameState); // e.g. zoom or variables changed
          }
          return MAX_PICK_RADIUS_PX;
        }
        bound = Math.max(bound, measured[kind]);
      }
    }
    return Math.ceil(bound) + 1;
  }

  load(serialized: Float32Array, state: IndexState) {
    this.clear();
    this.index = this.core.loadIndex(serialized);
    this.state = this.index ? state : null;
  }

  /** Frees the index (also when the layer is disposed: the core is shared). */
  clear() {
    this.core.freeIndex(this.index);
    this.index = 0;
    this.state = null;
  }

  get loaded() {
    return this.state !== null;
  }

  /** @param feature null for sizes shared by all features */
  private prepareContext(feature: FeatureLike | null, variables: Record<string, any>, resolution: number) {
    const ctx = this.ctx;
    ctx.variables = variables;
    ctx.resolution = resolution;
    if (!feature) {
      ctx.properties = {};
      ctx.featureId = null;
      ctx.geometryType = '';
      return ctx;
    }
    ctx.properties = (feature as any).getPropertiesInternal?.() ?? feature.getProperties();
    const id = feature.getId();
    ctx.featureId = id === undefined ? null : id;
    const geometry = feature.getGeometry();
    ctx.geometryType = geometry ? computeGeometryType(geometry as any) : '';
    return ctx;
  }

  /**
   * Whether `feature` is hit at `distancePx` from a geometry of the given kind.
   * @param x for a point: the position relative to it, in CSS px on screen with y up;
   *   for a line: the distance again, positive to the right of its direction
   * @param viewRotation rotation of the view
   */
  private isHit(
    feature: FeatureLike,
    kind: number,
    distancePx: number,
    x: number,
    y: number,
    viewRotation: number,
    tolerance: number,
    variables: Record<string, any>,
    resolution: number,
  ): boolean {
    const ctx = this.prepareContext(feature, variables, resolution);
    for (const rule of this.rules) {
      if (rule.isElse && rule.previous.some((f) => run(f, ctx) === true)) {
        continue;
      }
      if (rule.filter && run(rule.filter, ctx) !== true) {
        continue;
      }
      for (const s of rule.styles) {
        if (kind === HIT_KIND_POINT && s.symbol) {
          const b = symbolBox(s, ctx);
          if (!b) {
            continue;
          }
          // the shader turns the symbol, and where it is, clockwise by this angle
          const angle = b.rotation + (s.rotateWithView ? viewRotation : 0);
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);
          const dx = x - (cos * b.x + sin * b.y);
          const dy = y - (-sin * b.x + cos * b.y);
          if (b.round) {
            if (Math.hypot(dx, dy) <= b.halfWidth + tolerance) {
              return true;
            }
          } else if (Math.abs(cos * dx - sin * dy) <= b.halfWidth + tolerance && Math.abs(sin * dx + cos * dy) <= b.halfHeight + tolerance) {
            return true;
          }
        } else if (kind === HIT_KIND_LINE && s.stroke) {
          const w = run(s.strokeWidth, ctx);
          const offset = run(s.strokeOffset, ctx) ?? 0;
          // a positive offset draws the stroke to the right of the line
          if (w !== undefined && w > 0 && (offset ? Math.abs(x - offset) : distancePx) <= w / 2 + tolerance) {
            return true;
          }
        } else if (kind === HIT_KIND_POLYGON && s.fill && distancePx <= tolerance) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Features at `coordinate`, topmost first, produced lazily so callers can
   * stop at the first one. Only at this coordinate: for a map that shows the
   * world more than once, the caller asks for the same place in each world
   * (as ol's map renderer does).
   */
  *pick(
    coordinate: Coordinate,
    frameState: FrameState,
    hitTolerance: number,
    getFeature: (ref: number) => FeatureLike | undefined,
  ): Generator<FeatureLike> {
    const state = this.state;
    if (!state) {
      return;
    }
    const toIndex = frameState.viewState.resolution / state.resolution; // css px → index units
    const radius = (this.bound(frameState) + hitTolerance) * toIndex;
    const variables = this.frameVariables(frameState);
    const resolution = frameState.viewState.resolution;
    const rotation = frameState.viewState.rotation;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const seen = new Set<FeatureLike>();
    {
      const x = (coordinate[0] - state.center[0]) / state.resolution;
      const y = (coordinate[1] - state.center[1]) / state.resolution;
      // copy the (small) hit list: evaluating styles must not see it change
      const {count, words, floats} = this.core.queryIndexRaw(x, y, radius, this.index);
      const refs = words.slice(0, count * HIT_WORDS);
      const distances = floats.slice(0, count * HIT_WORDS);
      for (let i = 0; i < count; i++) {
        const feature = getFeature(refs[i * HIT_WORDS]);
        if (!feature || seen.has(feature)) {
          continue;
        }
        const kind = refs[i * HIT_WORDS + 1];
        let a = distances[i * HIT_WORDS + 4] / toIndex;
        let b = distances[i * HIT_WORDS + 5] / toIndex;
        if (kind === HIT_KIND_POINT) {
          // from the map to the screen: the view turns the map clockwise by its rotation
          [a, b] = [cos * a + sin * b, -sin * a + cos * b];
        }
        if (this.isHit(feature, kind, distances[i * HIT_WORDS + 3] / toIndex, a, b, rotation, hitTolerance, variables, resolution)) {
          seen.add(feature);
          yield feature;
        }
      }
    }
  }
}

/**
 * CPU hit detection. The worker builds a packed R-tree (Rust) over the
 * rendered geometries, in "build pixels": (world - center) / resolution at
 * the time the buffers were built. Queries run synchronously in a
 * main-thread wasm instance, then each candidate is checked against the
 * parts of its style that decide a hit: filter, symbol radius, stroke width
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
import {type Core, HIT_KIND_LINE, HIT_KIND_POINT, HIT_KIND_POLYGON} from '../wasm/core.js';

/** Largest symbol radius / half stroke width searched for, in CSS pixels. */
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
  const symbolSizes = [style[`${p}-radius`], style['shape-radius2'], style[`${p}-stroke-width`], style[`${p}-scale`], style['icon-width'], style['icon-height']];
  return {
    fill: 'fill-color' in style || 'fill-pattern-src' in style,
    stroke: 'stroke-color' in style || 'stroke-pattern-src' in style,
    strokeWidth: compile<number>(style['stroke-width'] ?? 1, NumberType),
    symbol,
    radius: compile<number>(style[`${p}-radius`], NumberType),
    radius2: compile<number>(style['shape-radius2'], NumberType),
    symbolStrokeWidth: compile<number>(style[`${p}-stroke-width`], NumberType),
    scale: compile<number | number[]>(style[`${p}-scale`], NumberType | NumberArrayType),
    iconWidth: compile<number>(style['icon-width'], NumberType),
    iconHeight: compile<number>(style['icon-height'], NumberType),
    iconSrc: typeof style['icon-src'] === 'string' ? (style['icon-src'] as string) : null,
    symbolSize: sizeKind(symbolSizes),
    strokeSize: sizeKind([style['stroke-width']]),
    timeDependent: [...symbolSizes, style['stroke-width']].some((v) => usesOps(v, new Set(['time']))),
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

function symbolRadius(s: CompiledStyle, ctx: any): number {
  const scaleValue = run(s.scale, ctx) ?? 1;
  const scale = Array.isArray(scaleValue) ? Math.max(Math.abs(scaleValue[0]), Math.abs(scaleValue[1])) : Math.abs(scaleValue);
  if (s.symbol === 'icon') {
    const size = s.iconSrc ? iconSize(s.iconSrc) : undefined;
    const w = run(s.iconWidth, ctx) ?? size?.[0] ?? 0;
    const h = run(s.iconHeight, ctx) ?? size?.[1] ?? 0;
    return (Math.max(w, h) / 2) * scale;
  }
  const r = run(s.radius, ctx);
  if (r === undefined || !(r > 0)) {
    return -1;
  }
  const r2 = run(s.radius2, ctx) ?? 0;
  const stroke = run(s.symbolStrokeWidth, ctx) ?? 0;
  return (Math.max(r, r2) + Math.max(stroke, 0) / 2) * scale;
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
  private rules: CompiledRule[];
  private readonly ctx = newEvaluationContext();
  private readonly start = Date.now();
  /** Max symbol radius / half stroke width (CSS px) over all features, for one view key. */
  private measured: {key: string; point: number; line: number} | null = null;
  private measuring: string | null = null;
  private measureToken = 0;
  private batch: MeasurableBatch | null = null;

  constructor(
    private readonly core: Core,
    style: FlatStyleLike,
    private variables: Record<string, any>,
  ) {
    this.rules = compileRules(style);
  }

  setStyle(style: FlatStyleLike, variables: Record<string, any>) {
    this.variables = variables;
    this.rules = compileRules(style);
    this.measured = null;
    this.measuring = null;
    this.measureToken++;
  }

  private get styles(): CompiledStyle[] {
    return this.rules.flatMap((r) => r.styles);
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
   * Measures, in idle time and in chunks, the largest symbol radius and
   * stroke width over all features when sizes depend on feature data. Until
   * it finishes, picking searches the conservative MAX_PICK_RADIUS_PX.
   */
  measure(batch: MeasurableBatch, frameState: FrameState) {
    this.batch = batch;
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
              result.point = Math.max(result.point, symbolRadius(s, ctx));
            } else if (kind === 'line' && s.stroke) {
              result.line = Math.max(result.line, (run(s.strokeWidth, ctx) ?? 0) / 2);
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

  /** Upper bound of symbol radius / half stroke width in CSS px for this frame. */
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
          const r = kind === 'point' ? symbolRadius(s, ctx) : (run(s.strokeWidth, ctx) ?? 0) / 2;
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
    return Math.min(Math.ceil(bound) + 1, MAX_PICK_RADIUS_PX);
  }

  load(serialized: Float32Array, state: IndexState) {
    this.state = this.core.loadIndex(serialized) ? state : null;
  }

  clear() {
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

  /** Whether `feature` is hit at `distancePx` from a geometry of the given kind. */
  private isHit(feature: FeatureLike, kind: number, distancePx: number, tolerance: number, variables: Record<string, any>, resolution: number): boolean {
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
          const r = symbolRadius(s, ctx);
          if (r >= 0 && distancePx <= r + tolerance) {
            return true;
          }
        } else if (kind === HIT_KIND_LINE && s.stroke) {
          const w = run(s.strokeWidth, ctx);
          if (w !== undefined && w > 0 && distancePx <= w / 2 + tolerance) {
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
   * Features under `coordinate`, topmost first, produced lazily so callers
   * can stop at the first one.
   * @param worlds x offsets of the world copies rendered this frame
   */
  *pick(
    coordinate: Coordinate,
    frameState: FrameState,
    hitTolerance: number,
    getFeature: (ref: number) => FeatureLike | undefined,
    worlds: number[],
  ): Generator<FeatureLike> {
    const state = this.state;
    if (!state) {
      return;
    }
    const toIndex = frameState.viewState.resolution / state.resolution; // css px → index units
    const radius = (this.bound(frameState) + hitTolerance) * toIndex;
    const variables = this.frameVariables(frameState);
    const resolution = frameState.viewState.resolution;
    const seen = new Set<FeatureLike>();
    for (const offset of worlds) {
      const x = (coordinate[0] - offset - state.center[0]) / state.resolution;
      const y = (coordinate[1] - state.center[1]) / state.resolution;
      // copy the (small) hit list: evaluating styles must not see it change
      const {count, words, floats} = this.core.queryIndexRaw(x, y, radius);
      const refs = words.slice(0, count * 4);
      const distances = floats.slice(0, count * 4);
      for (let i = 0; i < count; i++) {
        const feature = getFeature(refs[i * 4]);
        if (!feature || seen.has(feature)) {
          continue;
        }
        if (this.isHit(feature, refs[i * 4 + 1], distances[i * 4 + 3] / toIndex, hitTolerance, variables, resolution)) {
          seen.add(feature);
          yield feature;
        }
      }
    }
  }
}

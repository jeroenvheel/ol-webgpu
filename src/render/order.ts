/**
 * The order features are drawn in within a layer.
 *
 * Without anything said, features are drawn in the order they came into
 * the source, per style in the order of the styles, and within a style all
 * fills, then all strokes, then all symbols: as ol's WebGL layers do.
 *
 * Two things change that, as far as one buffer per geometry kind and one
 * program per style allow:
 *
 * - `z-index` of a flat style. Styles with a number as `z-index` are drawn
 *   in the order of those numbers (`styleOrder`). A `z-index` that is an
 *   expression gives every feature a number: the features are in the
 *   buffers in the order of those numbers (`featureZIndex`), and the
 *   fills, strokes and symbols of one number are drawn before those of the
 *   next (levels.ts), so a feature with a higher one is drawn over all of
 *   a lower one. With more different numbers than are drawn one by one,
 *   that holds within each kind only.
 * - `renderOrder` of the layer, a function that compares two features, as
 *   for ol's Canvas vector layer: the order of features with the same
 *   `z-index`.
 */
import type {FeatureLike} from 'ol/Feature.js';
import {newEvaluationContext} from 'ol/expr/cpu.js';
import {BooleanType, NumberType, computeGeometryType} from 'ol/expr/expression.js';
import type {FlatStyle, FlatStyleLike, Rule} from 'ol/style/flat.js';
import {TIME_VAR, VIEW_OPS, ZOOM_VAR, compile, run, usesOps} from './picking.js';

interface OrderedStyle {
  zIndex: unknown;
  filter: ((ctx: any) => boolean) | null;
  /** For `else` rules: the filters of the rules before. */
  previous: Array<((ctx: any) => boolean) | null>;
  isElse: boolean;
}

/** The styles of a layer one by one, in the order ol makes shaders of them (`convertStyleToShaders`). */
function flatten(style: FlatStyleLike): OrderedStyle[] {
  const list = (Array.isArray(style) ? style : [style]) as any[];
  if (!list.length) {
    return [];
  }
  if ('builder' in list[0]) {
    return list.map(() => ({zIndex: undefined, filter: null, previous: [], isElse: false}));
  }
  if (!('style' in list[0])) {
    return (list as FlatStyle[]).map((s) => ({
      zIndex: (s as any)['z-index'],
      filter: compile<boolean>((s as any).filter, BooleanType),
      previous: [],
      isElse: false,
    }));
  }
  const out: OrderedStyle[] = [];
  const previous: OrderedStyle['previous'] = [];
  for (const rule of list as Rule[]) {
    const filter = compile<boolean>(rule.filter, BooleanType);
    for (const s of Array.isArray(rule.style) ? rule.style : [rule.style]) {
      out.push({zIndex: (s as any)['z-index'], filter, previous: rule.else ? previous.slice() : [], isElse: !!rule.else});
    }
    if (rule.filter !== undefined) {
      previous.push(filter);
    }
  }
  return out;
}

/**
 * The order to draw the styles in: their positions, sorted by a `z-index`
 * that is a number (others count as 0), in their own order where that is
 * the same. Null when that is the order they are in.
 */
export function styleOrder(style: FlatStyleLike): number[] | null {
  const z = flatten(style).map((s) => (typeof s.zIndex === 'number' ? s.zIndex : 0));
  const order = z.map((_z, i) => i).sort((a, b) => z[a] - z[b] || a - b);
  return order.every((position, i) => position === i) ? null : order;
}

export interface FeatureZIndex {
  /** The `z-index` of a feature: that of the first style it passes the filter of. */
  of(feature: FeatureLike): number;
  /** The number does not follow from the feature alone (variables, zoom): it is not kept between builds. */
  volatile: boolean;
}

/**
 * How to tell the `z-index` of a feature, or null when no style has one
 * that is an expression (the order of the styles is all there is then).
 * @param variables the style variables (the object the layer keeps up to date)
 * @param zoom the zoom to evaluate `['zoom']` with
 */
export function featureZIndex(style: FlatStyleLike, variables: Record<string, any>, zoom: () => number): FeatureZIndex | null {
  const styles = flatten(style);
  if (!styles.some((s) => Array.isArray(s.zIndex))) {
    return null;
  }
  const evaluators = styles.map((s) => (s.zIndex === undefined ? null : compile<number>(s.zIndex, NumberType)));
  const ctx = newEvaluationContext();
  return {
    volatile: styles.some((s) => usesOps(s.zIndex, VIEW_OPS)),
    of(feature) {
      ctx.variables = {...variables, [ZOOM_VAR]: zoom(), [TIME_VAR]: 0};
      ctx.properties = (feature as any).getPropertiesInternal?.() ?? feature.getProperties();
      const id = feature.getId();
      ctx.featureId = id === undefined ? null : id;
      const geometry = feature.getGeometry();
      ctx.geometryType = geometry ? computeGeometryType(geometry as any) : '';
      for (let i = 0; i < styles.length; i++) {
        const s = styles[i];
        if (s.isElse && s.previous.some((f) => run(f, ctx) === true)) {
          continue;
        }
        if (s.filter && run(s.filter, ctx) !== true) {
          continue;
        }
        const value = run(evaluators[i], ctx);
        return typeof value === 'number' && !Number.isNaN(value) ? value : 0;
      }
      return 0;
    },
  };
}

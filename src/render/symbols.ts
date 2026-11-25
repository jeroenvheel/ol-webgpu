/**
 * Symbols that take part in decluttering.
 *
 * A symbol (circle, shape or icon) of a style with `circle-declutter-mode`,
 * `shape-declutter-mode` or `icon-declutter-mode` set to `'declutter'` or
 * `'obstacle'` is placed with the labels of a layer that declutters: it
 * takes space, and with `'declutter'` it is not drawn where that space is
 * taken. The symbol and the label of a feature are one: both are drawn or
 * neither is.
 *
 * Unlike ol's Canvas layers, a symbol without such a mode is always drawn
 * (there the default is `'declutter'`): decluttering here began with text
 * only, and layers that rely on that keep their symbols.
 */
import type {FeatureLike} from 'ol/Feature.js';
import {newEvaluationContext} from 'ol/expr/cpu.js';
import {computeGeometryType} from 'ol/expr/expression.js';
import type {FlatStyleLike} from 'ol/style/flat.js';
import {TIME_VAR, ZOOM_VAR, compileRules, run, symbolBox} from './picking.js';

export interface DeclutterSymbol {
  /** The centre of the symbol relative to its point, in CSS pixels with y up. */
  x: number;
  y: number;
  halfWidth: number;
  halfHeight: number;
  /** An obstacle takes space and is always drawn. */
  obstacle: boolean;
}

export type SymbolEvaluator = (feature: FeatureLike, resolution: number) => DeclutterSymbol | null;

const out: DeclutterSymbol = {x: 0, y: 0, halfWidth: 0, halfHeight: 0, obstacle: false};

/**
 * Tells the symbol of a feature that takes part in decluttering (the object
 * it returns is reused), or null when no style of the layer has one.
 * @param variables the style variables (the object the layer keeps up to date)
 * @param zoom the zoom to evaluate `['zoom']` with
 */
export function buildSymbolEvaluator(style: FlatStyleLike, variables: Record<string, any>, zoom: () => number): SymbolEvaluator | null {
  const rules = compileRules(style);
  const placed = (mode: unknown) => mode === 'declutter' || mode === 'obstacle';
  if (!rules.some((rule) => rule.styles.some((s) => s.symbol && placed(s.declutterMode)))) {
    return null;
  }
  const ctx = newEvaluationContext();
  return (feature, resolution) => {
    ctx.variables = {...variables, [ZOOM_VAR]: zoom(), [TIME_VAR]: 0};
    ctx.resolution = resolution;
    ctx.properties = (feature as any).getPropertiesInternal?.() ?? feature.getProperties();
    const id = feature.getId();
    ctx.featureId = id === undefined ? null : id;
    const geometry = feature.getGeometry();
    ctx.geometryType = geometry ? computeGeometryType(geometry as any) : '';
    for (const rule of rules) {
      if (rule.isElse && rule.previous.some((f) => run(f, ctx) === true)) {
        continue;
      }
      if (rule.filter && run(rule.filter, ctx) !== true) {
        continue;
      }
      for (const s of rule.styles) {
        if (!s.symbol || !placed(s.declutterMode)) {
          continue;
        }
        const box = symbolBox(s, ctx);
        if (!box) {
          continue;
        }
        // a turned symbol takes the square around it
        const turned = box.rotation !== 0 || s.rotateWithView;
        const reach = turned ? Math.hypot(box.halfWidth, box.halfHeight) : 0;
        out.x = box.x;
        out.y = box.y;
        out.halfWidth = turned && !box.round ? reach : box.halfWidth;
        out.halfHeight = turned && !box.round ? reach : box.halfHeight;
        out.obstacle = s.declutterMode === 'obstacle';
        return out;
      }
    }
    return null;
  };
}

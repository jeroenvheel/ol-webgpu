/**
 * Evaluates the `text-*` part of a flat style per feature on the CPU, with
 * ol's own flat style compiler (`ol/render/canvas/style.js`). The geometry
 * styles stay on the GPU; only text needs values per feature here, because
 * strings cannot be vertex attributes.
 */
import type {FeatureLike} from 'ol/Feature.js';
import {buildExpression, newEvaluationContext} from 'ol/expr/cpu.js';
import {BooleanType, NumberType, computeGeometryType, newParsingContext} from 'ol/expr/expression.js';
import {buildStyle} from 'ol/render/canvas/style.js';
import {toFlatStyleLike} from 'ol/render/webgl/VectorStyleRenderer.js';
import type Style from 'ol/style/Style.js';
import type Text from 'ol/style/Text.js';
import type {FlatStyleLike} from 'ol/style/flat.js';

/**
 * Receives each text style of a feature; the `Text` object is reused, so
 * read it at once. `maxWidth`: `text-max-width` of the style (see wrap.ts),
 * 0 without one.
 */
export type TextCallback = (text: Text, zIndex: number, maxWidth: number) => void;

export type TextEvaluator = (feature: FeatureLike, resolution: number, callback: TextCallback) => void;

/** Keeps only what text needs, so fills, strokes and symbols are not evaluated twice. */
function textOnly(flat: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!('text-value' in flat)) {
    return out;
  }
  for (const key in flat) {
    if (key.startsWith('text-') || key === 'z-index') {
      out[key] = flat[key];
    }
  }
  return out;
}

/** An evaluator for the text styles of `style`, or null when it has none. */
export function buildTextEvaluator(style: FlatStyleLike, variables: Record<string, any>): TextEvaluator | null {
  const flat = toFlatStyleLike(style as any) as any;
  if (!flat) {
    return null;
  }
  const parsing = newParsingContext(variables) as any;
  const context = newEvaluationContext();
  context.variables = variables;
  // The rules as ol's `buildRuleSet` evaluates them (a style list is rules without
  // filters), with the `text-max-width` of each style, which ol does not know.
  interface TextStyle {
    evaluate: (c: typeof context) => Style | null;
    maxWidth: ((c: typeof context) => number) | null;
  }
  interface TextRule {
    filter: ((c: typeof context) => boolean) | null;
    isElse: boolean;
    styles: TextStyle[];
  }
  const compileStyle = (s: Record<string, unknown>): TextStyle => {
    const {'text-max-width': maxWidth, ...known} = s;
    return {
      evaluate: buildStyle(known as any, parsing) as any,
      maxWidth: maxWidth === undefined ? null : (buildExpression(maxWidth as any, NumberType, parsing) as any),
    };
  };
  let rules: TextRule[];
  if (Array.isArray(flat) && flat.length && 'style' in flat[0]) {
    rules = flat.map((rule: any) => ({
      filter: rule.filter !== undefined ? (buildExpression(rule.filter, BooleanType, parsing) as any) : null,
      isElse: !!rule.else,
      styles: [rule.style].flat().map(textOnly).map(compileStyle),
    }));
    if (!flat.some((rule: any) => [rule.style].flat().some((s: any) => 'text-value' in s))) {
      return null;
    }
  } else {
    const styles = (Array.isArray(flat) ? flat : [flat]).map(textOnly).filter((s: any) => 'text-value' in s);
    if (!styles.length) {
      return null;
    }
    rules = [{filter: null, isElse: false, styles: styles.map(compileStyle)}];
  }
  return (feature, resolution, callback) => {
    context.properties = (feature as any).getPropertiesInternal?.() ?? feature.getProperties() ?? {};
    context.resolution = resolution;
    const id = feature.getId();
    context.featureId = id !== undefined ? id : null;
    context.geometryType = computeGeometryType(feature.getGeometry() as any);
    let someMatched = false;
    for (const rule of rules) {
      if ((rule.filter && !rule.filter(context)) || (rule.isElse && someMatched)) {
        continue;
      }
      someMatched = true;
      for (const style of rule.styles) {
        const s = style.evaluate(context);
        const text = s?.getText();
        if (text) {
          let maxWidth = 0;
          if (style.maxWidth) {
            try {
              maxWidth = Number(style.maxWidth(context)) || 0;
            } catch {
              // e.g. a property that is not there: the label is not broken
            }
          }
          callback(text, s!.getZIndex() ?? 0, maxWidth);
        }
      }
    }
  };
}

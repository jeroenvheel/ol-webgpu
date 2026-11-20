/**
 * Evaluates the `text-*` part of a flat style per feature on the CPU, with
 * ol's own flat style compiler (`ol/render/canvas/style.js`). The geometry
 * styles stay on the GPU; only text needs values per feature here, because
 * strings cannot be vertex attributes.
 */
import type {FeatureLike} from 'ol/Feature.js';
import {newEvaluationContext} from 'ol/expr/cpu.js';
import {computeGeometryType, newParsingContext} from 'ol/expr/expression.js';
import {buildRuleSet, buildStyle} from 'ol/render/canvas/style.js';
import {toFlatStyleLike} from 'ol/render/webgl/VectorStyleRenderer.js';
import type Style from 'ol/style/Style.js';
import type Text from 'ol/style/Text.js';
import type {FlatStyleLike} from 'ol/style/flat.js';

/** Receives each text style of a feature; the `Text` object is reused, so read it at once. */
export type TextCallback = (text: Text, zIndex: number) => void;

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
  let evaluate: (c: typeof context) => Array<Style | null>;
  if (Array.isArray(flat) && flat.length && 'style' in flat[0]) {
    const rules = flat.map((rule: any) => ({
      ...rule,
      style: Array.isArray(rule.style) ? rule.style.map(textOnly) : textOnly(rule.style),
    }));
    if (!rules.some((r: any) => [r.style].flat().some((s: any) => 'text-value' in s))) {
      return null;
    }
    evaluate = buildRuleSet(rules, parsing) as any;
  } else {
    const styles = (Array.isArray(flat) ? flat : [flat]).map(textOnly).filter((s: any) => 'text-value' in s);
    if (!styles.length) {
      return null;
    }
    const evaluators = styles.map((s: any) => buildStyle(s, parsing));
    const out: Array<Style | null> = new Array(evaluators.length);
    evaluate = (c) => {
      for (let i = 0; i < evaluators.length; i++) {
        out[i] = evaluators[i](c as any);
      }
      return out;
    };
  }
  return (feature, resolution, callback) => {
    context.properties = (feature as any).getPropertiesInternal?.() ?? feature.getProperties() ?? {};
    context.resolution = resolution;
    const id = feature.getId();
    context.featureId = id !== undefined ? id : null;
    context.geometryType = computeGeometryType(feature.getGeometry() as any);
    for (const s of evaluate(context)) {
      const text = s?.getText();
      if (text) {
        callback(text, s!.getZIndex() ?? 0);
      }
    }
  };
}

import {describe, expect, it} from 'vitest';
import {buildStylePasses} from '../../src/render/stylePasses.js';

const names = (style: unknown, textAttributes: boolean) => Object.keys(buildStylePasses(style as any, {}, false, textAttributes).customAttributes).sort();

describe('buildStylePasses without the attributes of text', () => {
  const style = {'circle-radius': ['get', 'size'], 'circle-fill-color': '#f00', 'text-value': ['get', 'name'], 'text-font': '12px sans-serif'};

  it('leaves out what only a text reads', () => {
    expect(names(style, true)).toContain('prop_name');
    expect(names(style, false)).not.toContain('prop_name');
    expect(names(style, false)).toContain('prop_size');
  });

  it('keeps what something else reads too', () => {
    const both = {...style, 'circle-radius': ['get', 'name']};
    expect(names(both, false)).toContain('prop_name');
  });

  it('still knows the style has text, and has as many passes in the same order', () => {
    const list = [
      {'text-value': ['get', 'name'], 'z-index': 2},
      {'stroke-width': 2, 'stroke-color': '#00f', 'text-value': ['get', 'name'], 'z-index': 1},
    ];
    const withText = buildStylePasses(list as any, {});
    const without = buildStylePasses(list as any, {}, false, false);
    expect(without.hasText).toBe(true);
    expect(without.passes.length).toBe(withText.passes.length);
    expect(without.passes.map((p) => !!p.stroke)).toEqual(withText.passes.map((p) => !!p.stroke));
    expect(without.customSize).toBeLessThan(withText.customSize);
  });

  it('reads rules with a filter', () => {
    const rules = [
      {filter: ['==', ['get', 'kind'], 'a'], style: {'circle-radius': 3, 'circle-fill-color': '#f00', 'text-value': ['get', 'name']}},
      {else: true, style: [{'circle-radius': 2, 'circle-fill-color': '#00f'}, {'text-value': ['get', 'other']}]},
    ];
    const attributes = names(rules, false);
    expect(attributes).toContain('prop_kind');
    expect(attributes).not.toContain('prop_name');
    expect(attributes).not.toContain('prop_other');
    expect(buildStylePasses(rules as any, {}, false, false).passes.length).toBe(buildStylePasses(rules as any, {}).passes.length);
  });
});

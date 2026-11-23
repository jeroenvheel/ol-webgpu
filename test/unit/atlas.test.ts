import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {type AtlasUse, GlyphAtlas, createAtlasUse, fontFamilies, quantizeFont, quantizeStrokeWidth} from '../../src/text/atlas.js';

/** Texels of one side of every glyph the fake canvas measures: 4 x 8 of them fill the atlas. */
const GLYPH = 500;

/** A canvas that draws nothing and measures every text as a square of `GLYPH` pixels. */
function fakeCanvas() {
  const context: any = new Proxy(
    {},
    {
      get: (target: any, name: string) => {
        if (name === 'canvas') {
          return canvas;
        }
        if (name === 'measureText') {
          return () => ({width: GLYPH, actualBoundingBoxLeft: 0, actualBoundingBoxRight: GLYPH - 4, actualBoundingBoxAscent: (GLYPH - 4) / 2, actualBoundingBoxDescent: (GLYPH - 4) / 2});
        }
        return name in target ? target[name] : () => {};
      },
      set: (target: any, name: string, value: unknown) => {
        target[name] = value;
        return true;
      },
    },
  );
  const canvas: any = {width: 0, height: 0, getContext: () => context};
  return canvas;
}

const FONT = '12px "Label Font", sans-serif';

/** Takes `count` cells nothing else has asked for, as a layout would. */
function take(atlas: GlyphAtlas, count: number, name: string): AtlasUse {
  const use = createAtlasUse();
  const face = atlas.face(FONT, 0, 1, false, false);
  atlas.use = use;
  for (let i = 0; i < count; i++) {
    face.glyph(`${name}${i}`);
  }
  atlas.use = null;
  return use;
}

describe('GlyphAtlas', () => {
  let now = 0;
  beforeEach(() => {
    now = 100_000;
    vi.stubGlobal('document', {createElement: fakeCanvas});
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reads the families of a font', () => {
    expect(fontFamilies('bold 13px "Open Sans", sans-serif')).toEqual(['open sans', 'sans-serif']);
    expect(fontFamilies("italic 1.2em 'Noto Serif'")).toEqual(['noto serif']);
  });

  it('takes computed font sizes and halo widths in steps', () => {
    expect(quantizeFont('bold 13px "Open Sans", sans-serif')).toBe('bold 13px "Open Sans", sans-serif');
    expect(quantizeFont('12.5px sans-serif')).toBe('12.5px sans-serif');
    expect(quantizeFont('12.3456px sans-serif')).toBe('12.5px sans-serif');
    expect(quantizeFont('italic 12.2px/1.25 serif')).toBe('italic 12px/1.25 serif');
    expect(quantizeFont('0.1px serif')).toBe('0.5px serif');
    expect(quantizeFont('1.37em serif')).toBe('1.37em serif');
    expect(quantizeStrokeWidth(3)).toBe(3);
    expect(quantizeStrokeWidth(1.5)).toBe(1.5);
    expect(quantizeStrokeWidth(1.6)).toBe(1.5);
    expect(quantizeStrokeWidth(-1)).toBe(0);
  });

  it('starts over for a font of the labels only', () => {
    const atlas = new GlyphAtlas();
    expect(atlas.fontsLoaded([{family: 'Label Font'}])).toBe(false); // nothing drawn yet
    take(atlas, 1, 'a');
    const page = atlas.page;
    expect(atlas.fontsLoaded([{family: 'Icons'}])).toBe(false);
    expect(atlas.page).toBe(page);
    expect(atlas.fontsLoaded([{family: '"label font"'}])).toBe(true);
    expect(atlas.generation).toBe(page.generation + 1);
  });

  it('keeps the page of the generation before as it was', () => {
    const atlas = new GlyphAtlas();
    take(atlas, 3, 'a');
    const page = atlas.page;
    const {canvas, version, generation} = page;
    atlas.reset();
    take(atlas, 2, 'b');
    expect(atlas.page).not.toBe(page);
    expect(page).toEqual({canvas, version, generation});
    expect(atlas.page.canvas).not.toBe(canvas);
  });

  it('counts each cell of a layout once, with those that did not fit', () => {
    const atlas = new GlyphAtlas();
    const use = take(atlas, 2, 'a');
    const cell = use.area / 2;
    expect(cell).toBeGreaterThan(0.9 * GLYPH * GLYPH);
    // the same cells again, and one more
    const face = atlas.face(FONT, 0, 1, false, false);
    atlas.use = use;
    face.glyph('a0');
    face.glyph('a1');
    face.glyph('a2');
    atlas.use = null;
    expect(use.area).toBe(3 * cell);
    // more than the atlas holds
    const big = take(atlas, 40, 'b');
    expect(big.area).toBe(40 * cell);
  });

  it('starts a full atlas over when the labels of the last layouts fit', () => {
    const atlas = new GlyphAtlas();
    const user = {};
    const other = {};
    expect(atlas.layoutDone(other, take(atlas, 4, 'other'))).toBe(false); // not full
    take(atlas, 40, 'gone'); // labels of views before: fills the atlas
    const page = atlas.page;
    expect(atlas.layoutDone(user, take(atlas, 3, 'now'))).toBe(true);
    expect(atlas.generation).toBe(page.generation + 1);

    // full again at once: not before some time has passed
    take(atlas, 40, 'gone again');
    expect(atlas.layoutDone(user, take(atlas, 3, 'now'))).toBe(false);
    now += 6000;
    expect(atlas.layoutDone(user, take(atlas, 3, 'now'))).toBe(true);
  });

  it('does not start over for labels that need more than it holds', () => {
    const atlas = new GlyphAtlas();
    const user = {};
    const other = {};
    const page = atlas.page;
    atlas.layoutDone(other, take(atlas, 20, 'other'));
    expect(atlas.layoutDone(user, take(atlas, 20, 'mine'))).toBe(false);
    now += 6000;
    expect(atlas.layoutDone(user, take(atlas, 20, 'mine'))).toBe(false);
    expect(atlas.page).toBe(page);
    expect(console.warn).toHaveBeenCalledTimes(1);

    // the other layer is gone: what is left fits
    atlas.forget(other);
    expect(atlas.layoutDone(user, take(atlas, 20, 'mine'))).toBe(true);
  });
});

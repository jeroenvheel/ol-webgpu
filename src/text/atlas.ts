/**
 * Glyph atlas for GPU text: graphemes are drawn once with Canvas 2D on the
 * main thread (so the page's web fonts work, at the device pixel ratio) and
 * packed into one canvas that the backends upload as a texture.
 *
 * Each cell holds two coverage masks, as in the OpenLayers `webgpu-renderer`
 * branch (ol/webgpu/FontAtlas.js): the halo (stroke) in the red channel and
 * the fill in the green channel. A label draws the halos of all its glyphs
 * and then their fills, so a halo never covers a neighbouring letter.
 *
 * Browsers anti-alias light text heavier than dark text, so a mask is drawn
 * the way its colour would be: black on white for a dark colour, white on
 * black for a light one. A cell is therefore also keyed by whether its fill
 * and its halo are light.
 *
 * One atlas is shared by all layers of the page. When it starts over (a web
 * font of the labels arrived, or it is full of cells no label needs any
 * more) it gets a new page with a new `generation`. Label sets built for an
 * older generation are laid out again, and drawn from the page they were
 * made for until then.
 */
import {getFontParameters} from 'ol/css.js';
import {TATWEEL, ZWJ} from './textpath.js';
import {textHeights} from 'ol/render/canvas.js';

export interface Glyph {
  /** Cell in the atlas, in texels (zero size: nothing to draw, e.g. a space). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Quad origin relative to the pen position on the line's vertical centre, CSS pixels. */
  left: number;
  top: number;
  /** Quad size in CSS pixels. */
  width: number;
  height: number;
  /** Texels from the cell's left edge to the pen position, and from its top to the line centre. */
  leftTexels: number;
  topTexels: number;
  /** The last layout that took the cell (see `AtlasUse`). */
  used?: number;
}

/** The canvas of one generation of the atlas. Label sets keep the page their cells are on. */
export interface AtlasPage {
  /** Increases when the atlas starts over: the cells of earlier pages are not on this one. */
  generation: number;
  /** Replaced by a higher one, with the same cells, when the page grows. */
  canvas: HTMLCanvasElement;
  /** Increases whenever the canvas content changes (the backends upload again). */
  version: number;
}

/** What one layout takes from the atlas. */
export interface AtlasUse {
  id: number;
  /** Texels of the cells the layout uses, each counted once, with those that did not fit. */
  area: number;
}

let nextUseId = 1;

export function createAtlasUse(): AtlasUse {
  return {id: nextUseId++, area: 0};
}

/**
 * Positions of a glyph between two device pixels that get their own cell,
 * as browsers have for horizontal text: letter spacing stays even, and
 * upright text comes out like Canvas text, pixel for pixel.
 */
export const SUBPIXEL_BINS = 4;
/** Positions of a line between two rows of device pixels that get their own cell. */
export const DROP_BINS = 8;

const WIDTH = 2048;
const INITIAL_HEIGHT = 512;
const MAX_HEIGHT = 4096;
/** Texels of cells that fit a page, with what the shelves leave unused. */
const CAPACITY = WIDTH * MAX_HEIGHT * 0.85;
/** A full atlas starts over at most this often. */
const FULL_RESET_INTERVAL = 5000;
/** Measured texts kept per font; more than this and they are measured again. */
const MAX_MEASURED_TEXTS = 20000;
const EMPTY: Glyph = {x: 0, y: 0, w: 0, h: 0, left: 0, top: 0, width: 0, height: 0, leftTexels: 0, topTexels: 0};

/** Scripts whose letters join, stack or reorder: such text is drawn as a whole, not per grapheme. */
const SHAPED = /[֐-ࣿऀ-႟ក-៿᠀-᢯ᨀ-᫿יִ-﷿ﹰ-ﻼ]|\p{M}|‍/u;

/** A font family as fonts are compared by: without quotes, in lower case. */
function familyName(family: string): string {
  return family.trim().replace(/^['"]|['"]$/g, '').trim().toLowerCase();
}

/** The families a CSS font value names, or null when it cannot be read (a system font like `caption`). */
export function fontFamilies(font: string): string[] | null {
  const families = getFontParameters(font)?.families;
  return families ? families.map(familyName) : null;
}

const quantizedFonts = new Map<string, string>();

/**
 * A font with its pixel size in half pixels. Every font gets cells and
 * measurements of its own, so a size that is computed (from a property or
 * the zoom) would otherwise fill the atlas with fonts that look the same.
 */
export function quantizeFont(font: string): string {
  let quantized = quantizedFonts.get(font);
  if (quantized === undefined) {
    quantized = font.replace(/(\d*\.\d+)px/g, (_match, size) => `${Math.max(0.5, Math.round(Number(size) * 2) / 2)}px`);
    if (quantizedFonts.size > 1000) {
      quantizedFonts.clear();
    }
    quantizedFonts.set(font, quantized);
  }
  return quantized;
}

/** A halo width in quarter pixels, for the same reason as `quantizeFont`. */
export function quantizeStrokeWidth(width: number): number {
  return Math.max(0, Math.round(width * 4) / 4);
}

/** Text that is one run from right to left of letters that join. */
const JOINED_RUN = /^[\p{Script=Arabic}\p{Script=Syriac}\p{M}\s]+$/u;
const DIGIT = /\p{N}/u;

export function needsShaping(text: string): boolean {
  return SHAPED.test(text);
}

let segmenter: Intl.Segmenter | null = null;

/** Splits text into the units that get their own atlas cell. */
export function segments(text: string): string[] {
  if (needsShaping(text)) {
    return [text];
  }
  return graphemes(text);
}

/** The graphemes of a text. */
export function graphemes(text: string): string[] {
  segmenter ??= new Intl.Segmenter(undefined, {granularity: 'grapheme'});
  const out: string[] = [];
  for (const s of segmenter.segment(text)) {
    out.push(s.segment);
  }
  return out;
}

/** Measurements of one font, in CSS pixels. */
export class FontMetrics {
  private readonly advances = new Map<string, number>();
  private readonly pairs = new Map<string, Map<string, number>>();

  constructor(
    private readonly atlas: GlyphAtlas,
    readonly font: string,
  ) {}

  /** Forgets the measurements when there are too many (labels that keep changing, like times or counts). */
  trim() {
    if (this.advances.size > MAX_MEASURED_TEXTS) {
      this.advances.clear();
      this.pairs.clear();
    }
  }

  /** Advance width of a text. */
  advance(text: string): number {
    let a = this.advances.get(text);
    if (a === undefined) {
      a = this.atlas.measure(this.font, text).width;
      this.advances.set(text, a);
    }
    return a;
  }

  /** Kerning between two segments that follow each other. */
  kerning(a: string, b: string): number {
    let after = this.pairs.get(a);
    if (!after) {
      after = new Map();
      this.pairs.set(a, after);
    }
    let k = after.get(b);
    if (k === undefined) {
      k = this.atlas.measure(this.font, a + b).width - this.advance(a) - this.advance(b);
      // measurement noise is not kerning
      k = Math.abs(k) < 0.01 ? 0 : k;
      after.set(b, k);
    }
    return k;
  }
}

/** The cells of one font drawn one way: halo width, size on screen and whether the colours are light. */
export class Face {
  /** Cells by position between pixels, then by segment. */
  private readonly variants = new Map<number, Map<string, Glyph>>();

  constructor(
    private readonly atlas: GlyphAtlas,
    readonly font: string,
    readonly strokeWidth: number,
    readonly pixelRatio: number,
    readonly lightFill: boolean,
    readonly lightHalo: boolean,
  ) {}

  /**
   * The cell of a segment, drawn on first use.
   * @param shift position of the pen right of a whole texel, in `SUBPIXEL_BINS`
   * @param drop position of the line centre below a whole texel, in `DROP_BINS`:
   *     the browser decides where the baseline lands, as it does for Canvas text
   */
  glyph(segment: string, shift = 0, drop = 0): Glyph {
    const variant = shift * 16 + drop;
    let cells = this.variants.get(variant);
    if (!cells) {
      cells = new Map();
      this.variants.set(variant, cells);
    }
    let g = cells.get(segment);
    if (!g) {
      g = this.atlas.draw(this, segment, shift / SUBPIXEL_BINS, drop / DROP_BINS);
      cells.set(segment, g);
    }
    const use = this.atlas.use;
    if (use && g.w > 0 && g.used !== use.id) {
      g.used = use.id;
      use.area += (g.w + 1) * (g.h + 1);
    }
    return g;
  }
}

export class GlyphAtlas {
  /** The page cells are drawn on now. */
  page!: AtlasPage;
  private context!: CanvasRenderingContext2D;
  /** The layout that is taking cells (set by the layout while it runs). */
  use: AtlasUse | null = null;
  /** Texels the last layout of each user of the atlas took. */
  private readonly demands = new Map<object, number>();
  private lastFullReset = -Infinity;
  private warnedFull = false;
  private shelfX = 0;
  private shelfY = 0;
  private shelfHeight = 0;
  private readonly faces = new Map<string, Face>();
  private readonly fonts = new Map<string, FontMetrics>();
  /** Widths of whole texts per font, for labels along lines (ol's `measureAndCacheTextWidth`). */
  widthCaches: Record<string, Record<string, number>> = {};
  private readonly listeners = new Set<() => void>();
  /** A cell did not fit: the atlas starts over when the layout that found out is done. */
  private full = false;
  /** Where one mask of a cell is drawn before it goes into its channel. */
  private readonly scratch = document.createElement('canvas').getContext('2d')!;
  private readonly measureContext = document.createElement('canvas').getContext('2d')!;
  private measureFont = '';
  /** The families of the fonts measured or drawn since the atlas started over. */
  private readonly families = new Set<string>();
  /** A font in use could not be read for its families: any font that loads may be one of its. */
  private unknownFamilies = false;

  constructor() {
    this.reset();
    if (document.fonts?.addEventListener) {
      document.fonts.addEventListener('loadingdone', (e) => this.fontsLoaded((e as FontFaceSetLoadEvent).fontfaces));
    }
  }

  /**
   * Web fonts became available: cells and measurements made with a fallback
   * font in their place are stale, so the atlas starts over. Fonts no label
   * uses (an icon font, the fonts of the page around the map) change nothing.
   * @param faces the fonts that loaded (unknown: any font may have)
   * @return whether the atlas started over
   */
  fontsLoaded(faces?: readonly {family: string}[] | null): boolean {
    if (!this.unknownFamilies && this.families.size === 0) {
      return false; // nothing measured or drawn yet
    }
    if (faces?.length && !this.unknownFamilies && !faces.some((face) => this.families.has(familyName(face.family)))) {
      return false;
    }
    this.reset();
    return true;
  }

  private useFont(font: string) {
    const families = fontFamilies(font);
    if (families) {
      families.forEach((family) => this.families.add(family));
    } else {
      this.unknownFamilies = true;
    }
  }

  get canvas(): HTMLCanvasElement {
    return this.page.canvas;
  }

  /** Increases whenever the canvas content changes. */
  get version(): number {
    return this.page.version;
  }

  /** Increases when the atlas starts over: cells handed out before are not on the new page. */
  get generation(): number {
    return this.page.generation;
  }

  private init(height: number): CanvasRenderingContext2D {
    const canvas = document.createElement('canvas');
    canvas.width = WIDTH;
    canvas.height = height;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#000';
    context.fillRect(0, 0, WIDTH, height);
    this.page.canvas = canvas;
    this.context = context;
    return context;
  }

  /**
   * Keeps the caches of measured texts bounded. Called when a layout
   * starts, so the measurements of one layout stay.
   */
  trim() {
    this.fonts.forEach((metrics) => metrics.trim());
    for (const font in this.widthCaches) {
      let count = 0;
      for (const _text in this.widthCaches[font]) {
        if (++count > MAX_MEASURED_TEXTS) {
          delete this.widthCaches[font];
          break;
        }
      }
    }
  }

  /** Called when the atlas starts over (fonts of the labels loaded, or the atlas was full). */
  onReset(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Forgets all cells and measurements and goes on with a new page. The page
   * so far stays as it is, for the label sets that were made with it.
   */
  reset() {
    const previous = this.page as AtlasPage | undefined;
    this.page = {generation: (previous?.generation ?? 0) + 1, version: (previous?.version ?? 0) + 1, canvas: null!};
    this.init(INITIAL_HEIGHT);
    this.faces.clear();
    this.fonts.clear();
    this.widthCaches = {};
    this.measureFont = '';
    this.families.clear();
    this.unknownFamilies = false;
    // line heights ol measured before a web font arrived are stale too
    for (const font in textHeights) {
      delete textHeights[font];
    }
    this.shelfX = 0;
    this.shelfY = 0;
    this.shelfHeight = 0;
    this.full = false;
    this.warnedFull = false;
    this.listeners.forEach((l) => l());
  }

  /**
   * A layout has finished. When cells did not fit, the atlas starts over if
   * that helps: when the last layouts of all its users together fit a page,
   * so what fills it are cells of labels that are gone. Labels that need
   * more than a page keep the cells they have; starting over would only
   * leave out other glyphs.
   * @param user whose layout it was (see `forget`)
   * @param use what the layout took
   * @return whether the atlas started over: the layout is to be made again
   */
  layoutDone(user: object, use: AtlasUse): boolean {
    this.demands.set(user, use.area);
    if (!this.full) {
      return false;
    }
    const now = performance.now();
    if (now - this.lastFullReset < FULL_RESET_INTERVAL) {
      return false;
    }
    let demand = 0;
    this.demands.forEach((area) => (demand += area));
    if (demand > CAPACITY) {
      if (!this.warnedFull) {
        this.warnedFull = true;
        console.warn('ol-webgpu: the labels in view need more glyphs than the atlas holds; some glyphs are left out');
      }
      return false;
    }
    this.lastFullReset = now;
    this.reset();
    return true;
  }

  /** A user of the atlas is gone: its labels no longer count. */
  forget(user: object) {
    this.demands.delete(user);
  }

  private allocate(w: number, h: number): {x: number; y: number} | null {
    if (w + 2 > WIDTH) {
      return null;
    }
    if (this.shelfX + w + 1 > WIDTH) {
      this.shelfY += this.shelfHeight + 1;
      this.shelfX = 0;
      this.shelfHeight = 0;
    }
    while (this.shelfY + h + 1 > this.canvas.height) {
      if (this.canvas.height >= MAX_HEIGHT) {
        this.full = true;
        return null;
      }
      const old = this.canvas;
      const context = this.init(old.height * 2);
      context.drawImage(old, 0, 0);
    }
    const at = {x: this.shelfX + 1, y: this.shelfY + 1};
    this.shelfX += w + 1;
    this.shelfHeight = Math.max(this.shelfHeight, h);
    this.page.version++;
    return at;
  }

  /** Metrics of `text` for the baseline 'middle', as the cells are drawn. */
  measure(font: string, text: string): TextMetrics {
    const context = this.measureContext;
    if (this.measureFont !== font) {
      this.useFont(font);
      context.font = font;
      context.textBaseline = 'middle';
      context.textAlign = 'left';
      this.measureFont = font;
    }
    return context.measureText(text);
  }

  /** The measurements of a font. */
  metrics(font: string): FontMetrics {
    let m = this.fonts.get(font);
    if (!m) {
      m = new FontMetrics(this, font);
      this.fonts.set(font, m);
    }
    return m;
  }

  /**
   * The cells of a font drawn one way.
   * @param strokeWidth halo width in CSS pixels (0: no halo)
   * @param pixelRatio texels per CSS pixel
   * @param lightFill whether the fill colour is light (see the module comment)
   * @param lightHalo whether the halo colour is light
   */
  face(font: string, strokeWidth: number, pixelRatio: number, lightFill: boolean, lightHalo: boolean): Face {
    const key = `${strokeWidth}|${pixelRatio}|${lightFill ? 1 : 0}${lightHalo ? 1 : 0}|${font}`;
    let face = this.faces.get(key);
    if (!face) {
      face = new Face(this, font, strokeWidth, pixelRatio, lightFill, lightHalo);
      this.faces.set(key, face);
    }
    return face;
  }

  /**
   * How a segment is drawn: as it is, or, for a chunk of a word that was cut
   * between letters that join, with a tatweel at the side where the word
   * goes on (`lead`: at its start, `trail`: at its end) and what to keep of
   * that, in CSS pixels from the left of the text.
   */
  joined(font: string, segment: string): {text: string; cutLeft: number; cutRight: number; lead: boolean; trail: boolean} {
    const lead = segment.length > 1 && segment.startsWith(ZWJ);
    const trail = segment.length > 1 && segment.endsWith(ZWJ);
    if (!lead && !trail) {
      return {text: segment, cutLeft: 0, cutRight: Infinity, lead, trail};
    }
    const core = segment.slice(lead ? 1 : 0, trail ? -1 : undefined);
    if (!JOINED_RUN.test(core) || DIGIT.test(core)) {
      return {text: core, cutLeft: 0, cutRight: Infinity, lead: false, trail: false};
    }
    const text = (lead ? TATWEEL : '') + core + (trail ? TATWEEL : '');
    const tatweel = this.measure(font, TATWEEL).width;
    return {text, cutLeft: trail ? tatweel : 0, cutRight: this.measure(font, text).width - (lead ? tatweel : 0), lead, trail};
  }

  /** Draws the cell of a segment (see `Face.glyph`; `shift` and `drop` in texels here). */
  draw(face: Face, segment: string, shift: number, drop: number): Glyph {
    const {font, strokeWidth, pixelRatio} = face;
    // A chunk of a word that was cut between letters that join (marked with a zero
    // width joiner, see joinChunks in layout.ts) is drawn with a tatweel where the
    // rest of the word was, which gives its letters their joining form, and the
    // tatweel is cut off. (A zero width joiner itself changes nothing on a canvas.)
    // Right to left, so the start of the chunk is at its right.
    const {text, cutLeft, cutRight, lead} = this.joined(font, segment);
    const measured = this.measure(font, text);
    // the ink, relative to where the kept part starts
    const m = {
      actualBoundingBoxLeft: -(Math.max(-measured.actualBoundingBoxLeft, cutLeft) - cutLeft),
      actualBoundingBoxRight: Math.min(measured.actualBoundingBoxRight, cutRight) - cutLeft,
      actualBoundingBoxAscent: measured.actualBoundingBoxAscent,
      actualBoundingBoxDescent: measured.actualBoundingBoxDescent,
    };
    if (m.actualBoundingBoxLeft + m.actualBoundingBoxRight <= 0 || m.actualBoundingBoxAscent + m.actualBoundingBoxDescent <= 0) {
      return EMPTY;
    }
    // in texels, so a quad on whole device pixels shows the cell unfiltered
    const pad = Math.ceil((strokeWidth / 2) * pixelRatio) + 1;
    const left = Math.ceil(Math.max(0, m.actualBoundingBoxLeft) * pixelRatio) + pad;
    const right = Math.ceil(Math.max(0, m.actualBoundingBoxRight) * pixelRatio) + pad + (shift > 0 ? 1 : 0);
    const ascent = Math.ceil(Math.max(0, m.actualBoundingBoxAscent) * pixelRatio) + pad;
    const descent = Math.ceil(Math.max(0, m.actualBoundingBoxDescent) * pixelRatio) + pad + (drop > 0 ? 1 : 0);
    const w = left + right;
    const h = ascent + descent;
    const at = this.allocate(w, h);
    if (!at) {
      if (this.use) {
        this.use.area += (w + 1) * (h + 1); // wanted all the same
      }
      return EMPTY;
    }
    const place = (ctx: CanvasRenderingContext2D) => {
      if (text !== segment && cutRight !== Infinity) {
        // only the kept part: the cell ends where the rest of the word goes on
        const x0 = cutLeft > 0 ? left + shift : 0;
        const x1 = lead ? left + shift + (cutRight - cutLeft) * pixelRatio : w;
        ctx.beginPath();
        ctx.rect(x0, 0, x1 - x0, h);
        ctx.clip();
      }
      ctx.setTransform(pixelRatio, 0, 0, pixelRatio, left + shift - cutLeft * pixelRatio, ascent + drop);
      ctx.font = font;
    };
    if (strokeWidth > 0) {
      this.mask(at.x, at.y, w, h, face.lightHalo, '#f00', (ctx) => {
        place(ctx);
        ctx.lineWidth = strokeWidth;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.strokeText(text, 0, 0);
      });
    }
    this.mask(at.x, at.y, w, h, face.lightFill, '#0f0', (ctx) => {
      place(ctx);
      ctx.fillText(text, 0, 0);
    });
    return {
      x: at.x,
      y: at.y,
      w,
      h,
      left: -left / pixelRatio,
      top: -ascent / pixelRatio,
      width: w / pixelRatio,
      height: h / pixelRatio,
      leftTexels: left,
      topTexels: ascent,
    };
  }

  /**
   * Draws one coverage mask of a cell into a colour channel of the atlas:
   * `draw` paints with the context's fill and stroke style, white on black
   * for a light colour and black on white (then inverted) for a dark one.
   */
  private mask(x: number, y: number, w: number, h: number, light: boolean, channel: string, draw: (ctx: CanvasRenderingContext2D) => void) {
    const ctx = this.scratch;
    const canvas = ctx.canvas;
    if (canvas.width < w || canvas.height < h) {
      canvas.width = Math.max(canvas.width, w, 64);
      canvas.height = Math.max(canvas.height, h, 64);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = light ? '#000' : '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = ctx.strokeStyle = light ? '#fff' : '#000';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.save();
    draw(ctx);
    ctx.restore(); // a clip of the cell
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (!light) {
      ctx.globalCompositeOperation = 'difference';
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
    }
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = channel;
    ctx.fillRect(0, 0, w, h);
    const atlas = this.context;
    atlas.setTransform(1, 0, 0, 1, 0, 0);
    atlas.globalCompositeOperation = 'lighter';
    atlas.drawImage(canvas, 0, 0, w, h, x, y, w, h);
    atlas.globalCompositeOperation = 'source-over';
  }
}

let shared: GlyphAtlas | null = null;

/** The atlas shared by all layers of the page. */
export function sharedAtlas(): GlyphAtlas {
  shared ??= new GlyphAtlas();
  return shared;
}

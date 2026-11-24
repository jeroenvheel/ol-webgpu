/**
 * Label layout: turns the text styles of features into glyph instances for
 * the GPU and into boxes for decluttering and hit detection.
 *
 * Positions follow ol's Canvas text renderer (`createLabel` and the text
 * instructions in ol/render/canvas/Executor.js), so alignment, baseline,
 * offsets, scale, padding and backgrounds land where Canvas puts them.
 * Labels along lines use ol's `drawTextOnPath`; they are laid out for one
 * resolution and are rigid until the next layout.
 */
import type {FeatureLike} from 'ol/Feature.js';
import {asArray} from 'ol/color.js';
import type {Extent} from 'ol/extent.js';
import {containsExtent, intersects} from 'ol/extent.js';
import {clipFlatLineStrings} from 'ol/geom/flat/clip.js';
import {lineStringLength} from 'ol/geom/flat/length.js';
import {lineChunk} from 'ol/geom/flat/linechunk.js';
import {matchingChunk} from 'ol/geom/flat/straightchunk.js';
import {drawTextOnPath, rtlRegEx} from 'ol/geom/flat/textpath.js';
import {measureAndCacheTextWidth, measureTextHeight} from 'ol/render/canvas.js';
import type Text from 'ol/style/Text.js';
import {getUid} from 'ol/util.js';
import {
  type AtlasPage,
  type AtlasUse,
  DROP_BINS,
  type GlyphAtlas,
  SUBPIXEL_BINS,
  createAtlasUse,
  quantizeFont,
  quantizeStrokeWidth,
  segments,
} from './atlas.js';
import type {TextEvaluator} from './style.js';

/**
 * Sizes of the attributes of an instance, in shader location order after
 * the quad corner: anchor (2, map units relative to the set's origin),
 * part offset (2, pixels), glyph offset (2), size (2), atlas cell (4,
 * texels), colour (4), angle, rotate with view, and what to draw: the
 * `HALO` or `FILL` channel of the cell, or a `SOLID` rectangle.
 *
 * Instances are drawn in order. A label is its background, then the halos
 * of all its glyphs, then their fills: a halo never covers a letter of its
 * own label, and a label covers the labels drawn before it, as on a Canvas.
 */
export const INSTANCE_ATTRIBUTES = [2, 2, 2, 2, 4, 4, 3];
export const INSTANCE_FLOATS = INSTANCE_ATTRIBUTES.reduce((sum, size) => sum + size, 0);

/** Channels of an atlas cell: the halo in red, the fill in green. */
const HALO = 0;
const FILL = 1;
/** A rectangle of one colour with anti-aliased edges, for backgrounds (no cell). */
const SOLID = 2;

/**
 * Doubles per part: anchor x, y (map units, absolute), part offset x, y
 * (pixels), angle, rotate with view, box min x, min y, max x, max y (pixels,
 * before the angle is applied), cosine and sine of the angle.
 */
export const PART_DOUBLES = 12;

export const MODE_DECLUTTER = 0;
export const MODE_OBSTACLE = 1;
export const MODE_NONE = 2;

const TEXT_ALIGN: Record<string, number> = {
  left: 0,
  center: 0.5,
  right: 1,
  top: 0,
  middle: 0.5,
  hanging: 0.2,
  alphabetic: 0.8,
  ideographic: 0.8,
  bottom: 1,
};

function horizontalAlign(text: string, align: string | undefined): number {
  if (align === 'start') {
    align = rtlRegEx.test(text) ? 'right' : 'left';
  } else if (align === 'end') {
    align = rtlRegEx.test(text) ? 'left' : 'right';
  }
  return TEXT_ALIGN[align ?? 'center'] ?? 0.5;
}

export interface LabelSet {
  id: number;
  /** Map coordinate the instance anchors are relative to. */
  origin: [number, number];
  resolution: number;
  rotation: number;
  /** Atlas generation the glyph cells belong to. */
  generation: number;
  /** The atlas page the glyph cells are on. */
  page: AtlasPage;
  /** Version of the page that has all the cells of the set. */
  atlasVersion: number;
  instances: Float32Array;
  glyphCount: number;
  count: number;
  features: FeatureLike[];
  /** Identity of a label across layouts: feature uid and its index among the feature's labels. */
  keys: Float64Array;
  /**
   * What a label says and where (see `contentKey`): the identity of a label
   * whose feature is another object than before, as after a source loaded
   * its features again.
   */
  content: Float64Array;
  glyphStart: Uint32Array;
  glyphEnd: Uint32Array;
  partStart: Uint32Array;
  partEnd: Uint32Array;
  mode: Uint8Array;
  parts: Float64Array;
  /** Label indices from the highest declutter priority down. */
  order: Uint32Array;
  /** Some labels follow lines: they depend on the view rotation (keep upright). */
  hasLine: boolean;
}

export interface LayoutOptions {
  origin: [number, number];
  resolution: number;
  rotation: number;
  pixelRatio: number;
  extent: Extent;
  /** Transforms a geometry to the view projection (when a user projection is set). */
  toView?: (geometry: any) => any;
  /** Only measure the labels (parts and boxes), without glyphs: the first pass when decluttering. */
  boxesOnly?: boolean;
  /** Only lay out the labels with these keys: the second pass when decluttering. */
  accept?: Set<number>;
}

/**
 * Box (CSS pixels, axis aligned) of one part of a label on screen, into `out`.
 * @param transform coordinate to pixel transform of the view
 * @param viewCos cosine of the view rotation
 * @param viewSin sine of the view rotation
 */
export function partBox(parts: Float64Array, part: number, transform: number[], worldOffset: number, viewCos: number, viewSin: number, out: number[]) {
  const at = part * PART_DOUBLES;
  const x = parts[at] + worldOffset;
  const y = parts[at + 1];
  let sx = transform[0] * x + transform[2] * y + transform[4];
  let sy = transform[1] * x + transform[3] * y + transform[5];
  const rotateWithView = parts[at + 5];
  const vc = rotateWithView ? viewCos : 1;
  const vs = rotateWithView ? viewSin : 0;
  sx += vc * parts[at + 2] - vs * parts[at + 3];
  sy += vs * parts[at + 2] + vc * parts[at + 3];
  const x0 = parts[at + 6];
  const y0 = parts[at + 7];
  const x1 = parts[at + 8];
  const y1 = parts[at + 9];
  const angle = parts[at + 4];
  if (angle === 0 && vs === 0) {
    out[0] = sx + x0;
    out[1] = sy + y0;
    out[2] = sx + x1;
    out[3] = sy + y1;
    return;
  }
  const ac = parts[at + 10];
  const as = parts[at + 11];
  // the view's rotation (when rotating with it) after the part's own angle
  const c = vc * ac - vs * as;
  const s = vs * ac + vc * as;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let k = 0; k < 4; k++) {
    const lx = k & 1 ? x1 : x0;
    const ly = k & 2 ? y1 : y0;
    const px = sx + c * lx - s * ly;
    const py = sy + s * lx + c * ly;
    minX = Math.min(minX, px);
    maxX = Math.max(maxX, px);
    minY = Math.min(minY, py);
    maxY = Math.max(maxY, py);
  }
  out[0] = minX;
  out[1] = minY;
  out[2] = maxX;
  out[3] = maxY;
}

let nextSetId = 1;

const NONE = [0, 0, 0, 0];

function rgba(colorLike: unknown): number[] | null {
  if (typeof colorLike === 'string' || Array.isArray(colorLike)) {
    try {
      const c = asArray(colorLike as any);
      return [c[0] / 255, c[1] / 255, c[2] / 255, c[3] ?? 1];
    } catch {
      return null;
    }
  }
  return null; // patterns and gradients are not supported for text
}

function isLight(color: number[] | null): boolean {
  return !!color && 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2] > 0.5;
}

interface Chunk {
  text: string;
  font: string;
}

interface Line {
  chunks: Chunk[];
  width: number;
  height: number;
}

/**
 * Lays out the labels of a list of features, a slice at a time so a large
 * source does not block a frame.
 */
export class LabelBuilder {
  private index = 0;
  private instances = new Float32Array(INSTANCE_FLOATS * 1024);
  private glyphCount = 0;
  private readonly labelFeatures: FeatureLike[] = [];
  private readonly keys: number[] = [];
  private readonly content: number[] = [];
  private readonly glyphStart: number[] = [];
  private readonly glyphEnd: number[] = [];
  private readonly partStart: number[] = [];
  private readonly partEnd: number[] = [];
  private readonly mode: number[] = [];
  private readonly zIndex: number[] = [];
  private readonly uid: number[] = [];
  private parts: number[] = [];
  private hasLine = false;
  private readonly page: AtlasPage;
  /** What this layout takes from the atlas. */
  readonly use: AtlasUse = createAtlasUse();
  private current: FeatureLike | null = null;
  private currentUid = 0;
  private currentIndex = 0;
  private currentKey = 0;
  private readonly boxesOnly: boolean;
  private readonly accept: Set<number> | null;
  private readonly onText = (text: Text, zIndex: number) => this.addText(text, zIndex);

  constructor(
    private readonly features: FeatureLike[],
    private readonly evaluator: TextEvaluator,
    private readonly atlas: GlyphAtlas,
    readonly options: LayoutOptions,
  ) {
    this.page = atlas.page;
    this.boxesOnly = !!options.boxesOnly;
    this.accept = options.accept ?? null;
  }

  /** Lays out features until `deadline` (`performance.now()` time); true when all are done. */
  run(deadline: number): boolean {
    const features = this.features;
    const resolution = this.options.resolution;
    this.atlas.use = this.use;
    while (this.index < features.length) {
      const feature = features[this.index++];
      this.current = feature;
      this.currentUid = Number(getUid(feature));
      this.currentIndex = 0;
      try {
        this.evaluator(feature, resolution, this.onText);
      } catch (e) {
        // one feature with a bad value must not stop the others
        console.warn('ol-webgpu: text style evaluation failed', e);
      }
      if ((this.index & 31) === 0 && performance.now() >= deadline) {
        break;
      }
    }
    this.atlas.use = null;
    return this.index >= features.length;
  }

  /** Whether the atlas started over while laying out: the cells used so far are gone. */
  isStale(): boolean {
    return this.page !== this.atlas.page;
  }

  finish(): LabelSet {
    const count = this.labelFeatures.length;
    // Labels are drawn in the order of the buffers: by z-index, then as the
    // features come (by age), so a label with a higher z-index is on top.
    const zIndices = this.zIndex;
    let sorted = true;
    for (let i = 1; i < count && sorted; i++) {
      sorted = zIndices[i] >= zIndices[i - 1];
    }
    if (!sorted) {
      this.sortByZIndex();
    }
    const order = new Uint32Array(count);
    for (let i = 0; i < count; i++) {
      order[i] = i;
    }
    const {zIndex, uid} = this;
    order.sort((a, b) => zIndex[b] - zIndex[a] || uid[a] - uid[b] || a - b);
    const o = this.options;
    return {
      id: nextSetId++,
      origin: o.origin,
      resolution: o.resolution,
      rotation: o.rotation,
      generation: this.page.generation,
      page: this.page,
      atlasVersion: this.page.version,
      instances: this.instances.subarray(0, this.glyphCount * INSTANCE_FLOATS),
      glyphCount: this.glyphCount,
      count,
      features: this.labelFeatures,
      keys: Float64Array.from(this.keys),
      content: Float64Array.from(this.content),
      glyphStart: Uint32Array.from(this.glyphStart),
      glyphEnd: Uint32Array.from(this.glyphEnd),
      partStart: Uint32Array.from(this.partStart),
      partEnd: Uint32Array.from(this.partEnd),
      mode: Uint8Array.from(this.mode),
      parts: Float64Array.from(this.parts),
      order,
      hasLine: this.hasLine,
    };
  }

  /** Reorders the labels, with their instances, by z-index (stable). */
  private sortByZIndex() {
    const count = this.labelFeatures.length;
    const zIndex = this.zIndex;
    const draw = new Uint32Array(count);
    for (let i = 0; i < count; i++) {
      draw[i] = i;
    }
    draw.sort((a, b) => zIndex[a] - zIndex[b] || a - b);
    const instances = new Float32Array(this.glyphCount * INSTANCE_FLOATS);
    const take = <T>(values: T[]): T[] => Array.from(draw, (i) => values[i]);
    const glyphStart: number[] = [];
    const glyphEnd: number[] = [];
    let at = 0;
    for (const i of draw) {
      const from = this.glyphStart[i];
      const to = this.glyphEnd[i];
      instances.set(this.instances.subarray(from * INSTANCE_FLOATS, to * INSTANCE_FLOATS), at * INSTANCE_FLOATS);
      glyphStart.push(at);
      at += to - from;
      glyphEnd.push(at);
    }
    this.instances = instances;
    replace(this.glyphStart, glyphStart);
    replace(this.glyphEnd, glyphEnd);
    replace(this.labelFeatures, take(this.labelFeatures));
    replace(this.keys, take(this.keys));
    replace(this.content, take(this.content));
    replace(this.partStart, take(this.partStart));
    replace(this.partEnd, take(this.partEnd));
    replace(this.mode, take(this.mode));
    replace(this.uid, take(this.uid));
    replace(this.zIndex, take(this.zIndex));
  }

  // --- instances ---------------------------------------------------------

  private instance(
    ax: number,
    ay: number,
    px: number,
    py: number,
    ox: number,
    oy: number,
    w: number,
    h: number,
    tx: number,
    ty: number,
    tw: number,
    th: number,
    color: number[],
    angle: number,
    rotateWithView: number,
    channel: number,
  ) {
    if (this.boxesOnly) {
      return;
    }
    let a = this.instances;
    const at = this.glyphCount * INSTANCE_FLOATS;
    if (at + INSTANCE_FLOATS > a.length) {
      const grown = new Float32Array(a.length * 2);
      grown.set(a);
      a = this.instances = grown;
    }
    const origin = this.options.origin;
    a[at] = ax - origin[0];
    a[at + 1] = ay - origin[1];
    a[at + 2] = px;
    a[at + 3] = py;
    a[at + 4] = ox;
    a[at + 5] = oy;
    a[at + 6] = w;
    a[at + 7] = h;
    a[at + 8] = tx;
    a[at + 9] = ty;
    a[at + 10] = tw;
    a[at + 11] = th;
    a[at + 12] = color[0];
    a[at + 13] = color[1];
    a[at + 14] = color[2];
    a[at + 15] = color[3];
    a[at + 16] = angle;
    a[at + 17] = rotateWithView;
    a[at + 18] = channel;
    this.glyphCount++;
  }

  /** A filled rectangle. */
  private rect(ax: number, ay: number, x: number, y: number, w: number, h: number, color: number[], angle: number, rotateWithView: number) {
    this.instance(ax, ay, 0, 0, x, y, w, h, 0, 0, 0, 0, color, angle, rotateWithView, SOLID);
  }

  /**
   * The next label of the current feature: gives it its key (the same in
   * both passes) and tells whether it is to be laid out.
   */
  private take(): boolean {
    this.currentKey = this.currentUid * 4096 + (this.currentIndex++ & 4095);
    return !this.accept || this.accept.has(this.currentKey);
  }

  private beginLabel(mode: number, zIndex: number, value: string | string[], x: number, y: number) {
    this.labelFeatures.push(this.current!);
    this.keys.push(this.currentKey);
    this.content.push(contentKey(value, x, y));
    this.glyphStart.push(this.glyphCount);
    this.partStart.push(this.parts.length / PART_DOUBLES);
    this.mode.push(mode);
    this.zIndex.push(zIndex);
    this.uid.push(this.currentUid);
  }

  private endLabel() {
    this.glyphEnd.push(this.glyphCount);
    this.partEnd.push(this.parts.length / PART_DOUBLES);
  }

  // --- text --------------------------------------------------------------

  private addText(text: Text, zIndex: number) {
    const value = text.getText();
    if (value === undefined || value === '' || (Array.isArray(value) && !value.length)) {
      return;
    }
    const fillStyle = text.getFill();
    const strokeStyle = text.getStroke();
    const fill = fillStyle ? rgba(fillStyle.getColor()) : null;
    const stroke = strokeStyle ? rgba(strokeStyle.getColor()) : null;
    if (!fill && !stroke) {
      return;
    }
    let geometry = this.current!.getGeometry() as any;
    if (!geometry) {
      return;
    }
    if (this.options.toView) {
      geometry = this.options.toView(geometry);
    }
    const strokeWidth = stroke ? quantizeStrokeWidth(strokeStyle!.getWidth() ?? 1) : 0;
    const declutterMode = text.getDeclutterMode();
    const mode = declutterMode === 'obstacle' ? MODE_OBSTACLE : declutterMode === 'none' ? MODE_NONE : MODE_DECLUTTER;
    const type: string = geometry.getType();
    const style = {
      value,
      font: quantizeFont(text.getFont() || '10px sans-serif'),
      fill: fill ?? NONE,
      stroke: stroke ?? NONE,
      lightFill: isLight(fill),
      lightHalo: isLight(stroke),
      strokeWidth,
      scale: (text.getScaleArray() as number[]) ?? [1, 1],
      mode,
      zIndex,
    };
    if (text.getPlacement() === 'line' && (type === 'LineString' || type === 'MultiLineString' || type === 'Polygon' || type === 'MultiPolygon')) {
      this.addLineLabels(text, geometry, type, style);
    } else {
      this.addPointLabels(text, geometry, type, style);
    }
  }

  private addPointLabels(text: Text, geometry: any, type: string, style: TextValues) {
    let flat: number[];
    let stride = geometry.getStride?.() ?? 2;
    let widths: number[] | null = null;
    const overflow = text.getOverflow();
    const resolution = this.options.resolution;
    switch (type) {
      case 'Point':
      case 'MultiPoint':
        flat = geometry.getFlatCoordinates();
        break;
      case 'LineString':
        flat = geometry.getFlatMidpoint();
        break;
      case 'Circle':
        flat = geometry.getCenter();
        break;
      case 'MultiLineString':
        flat = geometry.getFlatMidpoints();
        stride = 2;
        break;
      case 'Polygon':
        flat = geometry.getFlatInteriorPoint();
        if (!overflow) {
          widths = [flat[2] / resolution];
        }
        stride = 3;
        break;
      case 'MultiPolygon': {
        const points: number[] = geometry.getFlatInteriorPoints();
        flat = [];
        widths = overflow ? null : [];
        for (let i = 0; i < points.length; i += 3) {
          flat.push(points[i], points[i + 1]);
          widths?.push(points[i + 2] / resolution);
        }
        stride = 2;
        break;
      }
      default:
        return;
    }
    if (!flat.length) {
      return;
    }
    const layout = this.pointLayout(text, style);
    if (!layout) {
      return;
    }
    const extent = this.options.extent;
    for (let i = 0, n = 0; i < flat.length; i += stride, n++) {
      const x = flat[i];
      const y = flat[i + 1];
      if (x < extent[0] || x > extent[2] || y < extent[1] || y > extent[3]) {
        continue;
      }
      if (widths && widths[n] < Math.abs(layout.labelWidth)) {
        continue;
      }
      this.emitPointLabel(layout, x, y, style);
    }
  }

  /** Glyph quads and box of a point label, relative to its anchor. */
  private pointLayout(text: Text, style: TextValues): PointLayout | null {
    const atlas = this.atlas;
    const value = style.value;
    // chunks as ol: text, font, text, font, ... with '\n' between lines
    const raw: string[] = Array.isArray(value)
      ? value
      : String(value)
          .split('\n')
          .flatMap((line, i) => (i > 0 ? ['\n', '', line, ''] : [line, '']));
    const lines: Line[] = [{chunks: [], width: 0, height: 0}];
    for (let i = 0; i < raw.length; i += 2) {
      const chunkText = raw[i];
      if (chunkText === '\n') {
        lines.push({chunks: [], width: 0, height: 0});
        continue;
      }
      const font = raw[i + 1] ? quantizeFont(raw[i + 1]) : style.font;
      const width = atlas.metrics(font).advance(chunkText);
      const height = measureTextHeight(font);
      const line = lines[lines.length - 1];
      line.chunks.push({text: chunkText, font});
      line.width += width;
      line.height = Math.max(line.height, height);
    }
    let width = 0;
    let height = 0;
    for (const line of lines) {
      width = Math.max(width, line.width);
      height += line.height;
    }
    const first = raw[0] ?? '';
    const s = style.strokeWidth;
    const [sx, sy] = style.scale;
    const alignText = horizontalAlign(first, text.getTextAlign());
    const justify = text.getJustify();
    const align = justify ? (TEXT_ALIGN[justify] ?? alignText) : alignText;
    const baseline = TEXT_ALIGN[text.getTextBaseline() ?? 'middle'] ?? 0.5;
    const round = (v: number) => (v < 0 ? Math.floor(v) : Math.ceil(v));
    // the label image of ol's Canvas renderer, 2 pixels wider than the text
    // sized in device pixels, as the canvas of the label image is
    const pixelRatio = this.options.pixelRatio;
    const labelWidth = round((width + s + 2) * sx * pixelRatio) / pixelRatio;
    const labelHeight = round((height + s) * sy * pixelRatio) / pixelRatio;
    const anchorX = alignText * (labelWidth - 2 * sx) + 2 * (0.5 - alignText) * s;
    const anchorY = baseline * labelHeight + 2 * (0.5 - baseline) * s;
    // top left corner of the label image, from the anchor
    const bx = -anchorX + (text.getOffsetX() || 0);
    const by = -anchorY + (text.getOffsetY() || 0);
    const rotation = text.getRotation() || 0;
    const raster = rasterScale(pixelRatio, sx, sy);
    // Glyphs are placed like Canvas places them in its label image: on a
    // whole device pixel down, and at a fraction of a pixel along the line,
    // with a cell drawn for that fraction. This needs cells at the size on
    // screen, so not for mirrored or stretched text.
    const exact = sx === sy && sx > 0 && raster === pixelRatio * sx;
    // An upright label image has its corner on a whole device pixel (done
    // in the shader, as it depends on the view).
    const snap = exact && rotation === 0;
    const device = pixelRatio * sx;
    const cornerX = snap ? 0 : bx;
    const cornerY = snap ? 0 : by;
    const quads: number[] = [];
    let lineOffset = 0;
    for (const line of this.boxesOnly ? [] : lines) {
      let pen = s / 2 + align * (width - line.width);
      const cy = 0.5 * (s + line.height) + lineOffset;
      // the line centre in device pixels: a whole row, and the rest for the cell
      const row = Math.floor(cy * device + 0.5 / DROP_BINS);
      const drop = Math.max(0, Math.round((cy * device - row) * DROP_BINS));
      for (const chunk of line.chunks) {
        const segs = segments(chunk.text);
        const metrics = atlas.metrics(chunk.font);
        const face = atlas.face(chunk.font, s, raster, style.lightFill, style.lightHalo);
        for (let k = 0; k < segs.length; k++) {
          if (exact) {
            const x = pen * device;
            let whole = Math.floor(x);
            let bin = Math.round((x - whole) * SUBPIXEL_BINS);
            if (bin === SUBPIXEL_BINS) {
              whole++;
              bin = 0;
            }
            const g = face.glyph(segs[k], bin, drop);
            if (g.w > 0) {
              quads.push(cornerX + (whole - g.leftTexels) / pixelRatio, cornerY + (row - g.topTexels) / pixelRatio, g.w / pixelRatio, g.h / pixelRatio, g.x, g.y, g.w, g.h);
            }
          } else {
            const g = face.glyph(segs[k]);
            if (g.w > 0) {
              quads.push(bx + (pen + g.left) * sx, by + (cy + g.top) * sy, g.width * sx, g.height * sy, g.x, g.y, g.w, g.h);
            }
          }
          pen += metrics.advance(segs[k]) + (k + 1 < segs.length ? metrics.kerning(segs[k], segs[k + 1]) : 0);
        }
      }
      lineOffset += line.height;
    }
    const padding = text.getPadding() ?? [0, 0, 0, 0];
    const x0 = Math.min(bx, bx + labelWidth) - padding[3];
    const x1 = Math.max(bx, bx + labelWidth) + padding[1];
    const y0 = Math.min(by, by + labelHeight) - padding[0];
    const y1 = Math.max(by, by + labelHeight) + padding[2];
    const backgroundFill = text.getBackgroundFill();
    const backgroundStroke = text.getBackgroundStroke();
    return {
      quads,
      corner: snap ? [bx, by] : [0, 0],
      box: [x0, y0, x1, y1],
      labelWidth,
      rotation,
      rotateWithView: text.getRotateWithView() ? 1 : 0,
      background: backgroundFill ? rgba(backgroundFill.getColor()) : null,
      backgroundStroke: backgroundStroke ? rgba(backgroundStroke.getColor()) : null,
      backgroundStrokeWidth: backgroundStroke ? (backgroundStroke.getWidth() ?? 1) : 0,
    };
  }

  private emitPointLabel(layout: PointLayout, x: number, y: number, style: TextValues) {
    if (!this.take()) {
      return;
    }
    const {quads, box, rotation, rotateWithView, corner} = layout;
    this.beginLabel(style.mode, style.zIndex, style.value, x, y);
    const [x0, y0, x1, y1] = box;
    if (layout.background) {
      this.rect(x, y, x0, y0, x1 - x0, y1 - y0, layout.background, rotation, rotateWithView);
    }
    if (layout.backgroundStroke && layout.backgroundStrokeWidth > 0) {
      const w = layout.backgroundStrokeWidth;
      const c = layout.backgroundStroke;
      this.rect(x, y, x0 - w / 2, y0 - w / 2, x1 - x0 + w, w, c, rotation, rotateWithView);
      this.rect(x, y, x0 - w / 2, y1 - w / 2, x1 - x0 + w, w, c, rotation, rotateWithView);
      this.rect(x, y, x0 - w / 2, y0 + w / 2, w, y1 - y0 - w, c, rotation, rotateWithView);
      this.rect(x, y, x1 - w / 2, y0 + w / 2, w, y1 - y0 - w, c, rotation, rotateWithView);
    }
    // all halos of the label, then all fills
    for (let channel = HALO; channel <= FILL; channel++) {
      const color = channel === HALO ? style.stroke : style.fill;
      if (color[3] <= 0 || (channel === HALO && style.strokeWidth <= 0)) {
        continue;
      }
      for (let i = 0; i < quads.length; i += 8) {
        this.instance(x, y, corner[0], corner[1], quads[i], quads[i + 1], quads[i + 2], quads[i + 3], quads[i + 4], quads[i + 5], quads[i + 6], quads[i + 7], color, rotation, rotateWithView, channel);
      }
    }
    this.parts.push(x, y, 0, 0, rotation, rotateWithView, x0, y0, x1, y1, Math.cos(rotation), Math.sin(rotation));
    this.endLabel();
  }

  private addLineLabels(text: Text, geometry: any, type: string, style: TextValues) {
    const o = this.options;
    const geometryExtent = geometry.getExtent();
    if (!intersects(o.extent, geometryExtent)) {
      return;
    }
    let flat: number[] = geometry.getFlatCoordinates();
    let stride: number = geometry.getStride();
    let ends: number[];
    if (type === 'LineString') {
      ends = [flat.length];
    } else if (type === 'MultiLineString') {
      ends = geometry.getEnds();
    } else if (type === 'Polygon') {
      ends = geometry.getEnds().slice(0, 1);
    } else {
      ends = (geometry.getEndss() as number[][]).map((e) => e[0]);
    }
    const textAlign = text.getTextAlign();
    if (textAlign === undefined && (type === 'LineString' || type === 'MultiLineString') && !containsExtent(o.extent, geometryExtent)) {
      // as ol: anchor the label within the laid out area, not along the whole line
      const clipped = clipFlatLineStrings(flat, ends, stride, o.extent);
      flat = clipped.flatCoordinates;
      ends = clipped.ends;
      stride = 2;
      if (!ends.length) {
        return;
      }
    }
    const value = style.value;
    const plain = (Array.isArray(value) ? value.filter((_v, i) => i % 2 === 0).join('') : String(value)).replace(/\n/g, ' ');
    const repeat = text.getRepeat();
    const align = repeat ? undefined : textAlign;
    const maxAngle = text.getMaxAngle() ?? Math.PI / 4;
    const resolution = o.resolution;
    let offset = 0;
    for (const end of ends) {
      const chunks = repeat ? lineChunk(repeat * resolution, flat, offset, end, stride) : [stride === 2 ? flat.slice(offset, end) : strip(flat, offset, end, stride)];
      for (const chunk of chunks) {
        let begin = 0;
        let chunkEnd = chunk.length;
        if (align === undefined) {
          const range = matchingChunk(maxAngle, chunk, 0, chunk.length, 2);
          begin = range[0];
          chunkEnd = range[1];
        }
        if (chunkEnd - begin >= 4) {
          this.emitLineLabel(text, chunk, begin, chunkEnd, plain, style, maxAngle);
        }
      }
      offset = end;
    }
  }

  private emitLineLabel(text: Text, path: number[], begin: number, end: number, plain: string, style: TextValues, maxAngle: number) {
    const o = this.options;
    const atlas = this.atlas;
    const resolution = o.resolution;
    const [ox, oy] = o.origin;
    // pixels at the layout resolution, y down, not rotated
    const pixels: number[] = new Array(end - begin);
    for (let i = begin, k = 0; i < end; i += 2, k += 2) {
      pixels[k] = (path[i] - ox) / resolution;
      pixels[k + 1] = -(path[i + 1] - oy) / resolution;
    }
    const font = style.font;
    const sx = Math.abs(style.scale[0]);
    const sy = style.scale[1];
    const pathLength = lineStringLength(pixels, 0, pixels.length, 2);
    const cache = (this.atlas.widthCaches[font] ??= {});
    const textLength = sx * measureAndCacheTextWidth(font, plain, cache);
    if (!text.getOverflow() && textLength > pathLength) {
      return;
    }
    const startM = (pathLength - textLength) * horizontalAlign(plain, text.getTextAlign());
    const parts = drawTextOnPath(pixels, 0, pixels.length, 2, plain, startM, maxAngle, sx, measureAndCacheTextWidth, font, cache, o.rotation, text.getKeepUpright() ?? true);
    if (!parts || !parts.length || !this.take()) {
      return;
    }
    this.hasLine = true;
    const s = style.strokeWidth;
    const height = measureTextHeight(font);
    const baseline = TEXT_ALIGN[text.getTextBaseline() ?? 'middle'] ?? 0.5;
    const offsetX = text.getOffsetX() || 0;
    const cy = (0.5 - baseline) * height * sy + (text.getOffsetY() || 0);
    const raster = rasterScale(o.pixelRatio, sx, sy);
    const middle = parts[parts.length >> 1];
    const mx = middle[0] as number;
    const my = middle[1] as number;
    const ax = ox + mx * resolution;
    const ay = oy - my * resolution;
    const metrics = atlas.metrics(font);
    const face = atlas.face(font, s, raster, style.lightFill, style.lightHalo);
    // a line label is where its line starts: its own place depends on the view
    this.beginLabel(style.mode, style.zIndex, plain, path[begin], path[begin + 1]);
    // per glyph: part offset x, y, offset x, y, size w, h, atlas cell x, y, w, h, angle
    const glyphs: number[] = [];
    for (const part of parts) {
      const px = (part[0] as number) - mx;
      const py = (part[1] as number) - my;
      const half = part[2] as number;
      const angle = part[3] as number;
      const segs = this.boxesOnly ? [] : segments(part[4] as string);
      let pen = 0;
      for (let k = 0; k < segs.length; k++) {
        const g = face.glyph(segs[k]);
        if (g.w > 0) {
          glyphs.push(px, py, -half + offsetX + (pen + g.left) * sx, cy + g.top * sy, g.width * sx, g.height * sy, g.x, g.y, g.w, g.h, angle);
        }
        pen += metrics.advance(segs[k]) + (k + 1 < segs.length ? metrics.kerning(segs[k], segs[k + 1]) : 0);
      }
      const h = (Math.abs(height * sy) + s) / 2;
      this.parts.push(ax, ay, px, py, angle, 1, -half + offsetX - s / 2, cy - h, half + offsetX + s / 2, cy + h, Math.cos(angle), Math.sin(angle));
    }
    // all halos of the label, then all fills
    for (let channel = HALO; channel <= FILL; channel++) {
      const color = channel === HALO ? style.stroke : style.fill;
      if (color[3] <= 0 || (channel === HALO && s <= 0)) {
        continue;
      }
      for (let i = 0; i < glyphs.length; i += 11) {
        this.instance(ax, ay, glyphs[i], glyphs[i + 1], glyphs[i + 2], glyphs[i + 3], glyphs[i + 4], glyphs[i + 5], glyphs[i + 6], glyphs[i + 7], glyphs[i + 8], glyphs[i + 9], color, glyphs[i + 10], 1, channel);
      }
    }
    this.endLabel();
  }
}

const keyDoubles = new Float64Array(2);
const keyWords = new Uint32Array(keyDoubles.buffer);

/**
 * A number for the text of a label and its place on the map (53 bits of a
 * hash: two labels with the same number are the same label, in practice).
 */
export function contentKey(value: string | string[], x: number, y: number): number {
  // FNV-1a, twice with other parameters
  let a = 0x811c9dc5;
  let b = 0x01000193;
  const mix = (n: number) => {
    a = Math.imul(a ^ n, 0x01000193);
    b = Math.imul(b ^ n, 0x85ebca6b) ^ (b >>> 13);
  };
  const parts = typeof value === 'string' ? [value] : value;
  for (let p = 0; p < parts.length; p++) {
    const text = String(parts[p]);
    for (let i = 0; i < text.length; i++) {
      mix(text.charCodeAt(i));
    }
    mix(0x10000);
  }
  keyDoubles[0] = x;
  keyDoubles[1] = y;
  for (let i = 0; i < 4; i++) {
    mix(keyWords[i]);
  }
  return (a >>> 0) * 0x200000 + (b >>> 11);
}

interface TextValues {
  value: string | string[];
  font: string;
  fill: number[];
  stroke: number[];
  /** Whether the colours are light: the glyph masks are drawn accordingly (see atlas.ts). */
  lightFill: boolean;
  lightHalo: boolean;
  strokeWidth: number;
  scale: number[];
  mode: number;
  zIndex: number;
}

interface PointLayout {
  /** Per glyph: offset x, y, size w, h, atlas cell x, y, w, h. */
  quads: number[];
  /** What the glyph offsets are relative to: the label image's corner when it is snapped to a pixel, else the anchor. */
  corner: number[];
  box: [number, number, number, number];
  labelWidth: number;
  rotation: number;
  rotateWithView: number;
  background: number[] | null;
  backgroundStroke: number[] | null;
  backgroundStrokeWidth: number;
}

/** Texels per CSS pixel of the font size for a glyph cell: scaled text is drawn at its size on screen. */
function rasterScale(pixelRatio: number, sx: number, sy: number): number {
  const scale = Math.max(Math.abs(sx), Math.abs(sy), 0.25);
  // in steps, so a scale that varies per feature does not fill the atlas
  return pixelRatio * Math.min(8, Math.ceil(scale * 20 - 1e-9) / 20);
}

function replace<T>(target: T[], values: T[]) {
  for (let i = 0; i < values.length; i++) {
    target[i] = values[i];
  }
}

function strip(flat: number[], offset: number, end: number, stride: number): number[] {
  const out: number[] = [];
  for (let i = offset; i < end; i += stride) {
    out.push(flat[i], flat[i + 1]);
  }
  return out;
}


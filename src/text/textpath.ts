/**
 * Text along a line for scripts whose letters join (Arabic, Syriac).
 *
 * ol's `drawTextOnPath` gives every letter the width it has on its own. A
 * letter inside an Arabic word is much narrower than that, so a word that
 * goes around bends was spread out, with gaps at the bends. `textOnPath` is
 * `drawTextOnPath` of ol/geom/flat/textpath.js with the width of each letter
 * as an argument; `joinedAdvances` measures those widths inside the text.
 */
import {rotate} from 'ol/geom/flat/transform.js';
import {rtlRegEx} from 'ol/geom/flat/textpath.js';
import {lerp} from 'ol/math.js';

/** Letters of scripts whose letters join: their form depends on their neighbours. */
export const JOINING = /[\p{Script=Arabic}\p{Script=Syriac}]/u;
const MARKS_AT_END = /\p{M}+$/u;
export const ZWJ = String.fromCharCode(0x200d);
export const TATWEEL = String.fromCharCode(0x640);

/** Whether the letters at both sides of a cut join: the last of `before` and the first of `after`. */
export function joinsAcross(before: string, after: string): boolean {
  const last = Array.from(before.replace(MARKS_AT_END, '')).pop();
  const first = Array.from(after)[0];
  return !!last && !!first && JOINING.test(last) && JOINING.test(first);
}

/**
 * The width of each of `segments` (the graphemes of a text) as it is inside
 * the text, in the units of `measure`: the difference of the widths of the
 * text up to and with it. Where the text goes on with a letter that joins,
 * it is measured with a tatweel after it (and without the width of that),
 * so the last letter has the form it has in the word.
 */
export function joinedAdvances(segments: string[], measure: (text: string) => number): Float64Array {
  const advances = new Float64Array(segments.length);
  const tatweel = measure(TATWEEL);
  let prefix = '';
  let before = 0;
  for (let i = 0; i < segments.length; i++) {
    prefix += segments[i];
    const joins = i + 1 < segments.length && joinsAcross(prefix, segments[i + 1]);
    const width = joins ? measure(prefix + TATWEEL) - tatweel : measure(prefix);
    advances[i] = Math.max(0, width - before);
    before = width;
  }
  return advances;
}

/**
 * `drawTextOnPath` of ol with given widths.
 * @param flatCoordinates path to put the text on (x, y pairs)
 * @param segments the graphemes of the text, in the order of the text
 * @param advances the width of each of them
 * @param startM where along the path the text starts
 * @param maxAngle largest angle between adjacent chunks
 * @param rotation rotation of the view, for `keepUpright`
 * @return chunks `[x, y, half width, angle, text]`, or null when `maxAngle` is exceeded
 */
export function textOnPath(
  flatCoordinates: number[],
  segments: string[],
  advances: ArrayLike<number>,
  startM: number,
  maxAngle: number,
  rotation: number,
  keepUpright: boolean,
): Array<[number, number, number, number, string]> | null {
  const stride = 2;
  const end = flatCoordinates.length;
  let offset = 0;
  let x2 = flatCoordinates[offset];
  let y2 = flatCoordinates[offset + 1];
  let x1 = 0;
  let y1 = 0;
  let segmentLength = 0;
  let segmentM = 0;

  const advance = () => {
    x1 = x2;
    y1 = y2;
    offset += stride;
    x2 = flatCoordinates[offset];
    y2 = flatCoordinates[offset + 1];
    segmentM += segmentLength;
    segmentLength = Math.sqrt((x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1));
  };
  do {
    advance();
  } while (offset < end - stride && segmentM + segmentLength < startM);

  let interpolate = segmentLength === 0 ? 0 : (startM - segmentM) / segmentLength;
  const beginX = lerp(x1, x2, interpolate);
  const beginY = lerp(y1, y2, interpolate);

  const startOffset = offset - stride;
  const startLength = segmentM;
  let total = 0;
  for (let i = 0; i < advances.length; i++) {
    total += advances[i];
  }
  const endM = startM + total;
  while (offset < end - stride && segmentM + segmentLength < endM) {
    advance();
  }
  interpolate = segmentLength === 0 ? 0 : (endM - segmentM) / segmentLength;
  const endX = lerp(x1, x2, interpolate);
  const endY = lerp(y1, y2, interpolate);

  let reverse = false;
  if (keepUpright) {
    if (rotation) {
      const flat = [beginX, beginY, endX, endY];
      rotate(flat, 0, 4, 2, rotation, flat, flat);
      reverse = flat[0] > flat[2];
    } else {
      reverse = beginX > endX;
    }
  }

  const PI = Math.PI;
  const result: Array<[number, number, number, number, string]> = [];
  const singleSegment = startOffset + stride === offset;
  const text = segments.join('');

  offset = startOffset;
  segmentLength = 0;
  segmentM = startLength;
  x2 = flatCoordinates[offset];
  y2 = flatCoordinates[offset + 1];

  let previousAngle: number | undefined;
  if (singleSegment) {
    advance();
    previousAngle = Math.atan2(y2 - y1, x2 - x1);
    if (reverse) {
      previousAngle += previousAngle > 0 ? -PI : PI;
    }
    result[0] = [(endX + beginX) / 2, (endY + beginY) / 2, (endM - startM) / 2, previousAngle, text];
    return result;
  }

  // Right to left text starts at the end of the path as it is read, so its
  // chunks are placed in reverse order unless the path itself is reversed.
  const reverseChunks = reverse !== rtlRegEx.test(text);
  for (let i = 0, ii = segments.length; i < ii; ) {
    advance();
    let angle = Math.atan2(y2 - y1, x2 - x1);
    if (reverse) {
      angle += angle > 0 ? -PI : PI;
    }
    if (previousAngle !== undefined) {
      let delta = angle - previousAngle;
      delta += delta > PI ? -2 * PI : delta < -PI ? 2 * PI : 0;
      if (Math.abs(delta) > maxAngle) {
        return null;
      }
    }
    previousAngle = angle;

    const iStart = i;
    let charLength = 0;
    for (; i < ii; ++i) {
      const index = reverseChunks ? ii - i - 1 : i;
      const len = advances[index];
      if (offset + stride < end && segmentM + segmentLength < startM + charLength + len / 2) {
        break;
      }
      charLength += len;
    }
    if (i === iStart) {
      continue;
    }
    const chars = (reverseChunks ? segments.slice(ii - i, ii - iStart) : segments.slice(iStart, i)).join('');
    interpolate = segmentLength === 0 ? 0 : (startM + charLength / 2 - segmentM) / segmentLength;
    result.push([lerp(x1, x2, interpolate), lerp(y1, y2, interpolate), charLength / 2, angle, chars]);
    startM += charLength;
  }
  return result;
}

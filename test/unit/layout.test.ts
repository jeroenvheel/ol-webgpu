/**
 * Parts of the label layout that need no canvas (text/layout.ts): the
 * identity of a label by what it says and where, the direction of a label
 * along a line for a view rotation, and letters that join across the
 * chunks of a label along a line.
 */
import {describe, expect, it} from 'vitest';
import {contentKey, joinChunks, orderBy, orderByWhole, reads} from '../../src/text/layout.js';

const ZWJ = '‍';
// "salam" in Arabic: seen, lam, alef, meem
const SEEN = 'س';
const LAM = 'ل';
const ALEF = 'ا';
const MEEM = 'م';

describe('contentKey', () => {
  it('is the same for the same text at the same place', () => {
    expect(contentKey('Utrecht', 136000.5, 455000.25)).toBe(contentKey('Utrecht', 136000.5, 455000.25));
    expect(contentKey(['Utrecht', 'bold 12px sans-serif'], 1, 2)).toBe(contentKey(['Utrecht', 'bold 12px sans-serif'], 1, 2));
  });

  it('differs for another text or another place', () => {
    const key = contentKey('Utrecht', 136000.5, 455000.25);
    expect(contentKey('Utrecht ', 136000.5, 455000.25)).not.toBe(key);
    expect(contentKey('Utrecht', 136000.5, 455000.5)).not.toBe(key);
    expect(contentKey('Utrecht', 136001.5, 455000.25)).not.toBe(key);
    expect(contentKey(['Utr', 'echt'], 136000.5, 455000.25)).not.toBe(key);
  });

  it('is a whole number that a double holds exactly', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 20000; i++) {
      const key = contentKey(`n${i % 200}`, i * 0.5, -i);
      expect(Number.isSafeInteger(key)).toBe(true);
      seen.add(key);
    }
    expect(seen.size).toBe(20000);
  });
});

describe('reads', () => {
  // `along` is from the end of the text to its start, in pixels with y down
  it('keeps the first direction for a label without a second one', () => {
    expect(reads(0, 0, 0, Math.PI)).toBe(false);
  });

  it('turns a label around when the view turned it upside down', () => {
    // text from left to right at rotation 0: its end is to the right of its start
    const along: [number, number] = [-100, 0];
    expect(reads(...along, 0, 0)).toBe(false);
    expect(reads(...along, 0, 0.4 * Math.PI)).toBe(false);
    expect(reads(...along, 0, 0.6 * Math.PI)).toBe(true);
    expect(reads(...along, 0, Math.PI)).toBe(true);
    expect(reads(...along, 0, 1.6 * Math.PI)).toBe(false);
  });

  it('counts from the rotation of the layout', () => {
    const along: [number, number] = [-100, 0];
    // laid out for a view that was half a turn around: the first direction is the turned one
    expect(reads(...along, Math.PI, Math.PI)).toBe(false);
    expect(reads(...along, Math.PI, 0)).toBe(true);
  });
});

describe('joinChunks', () => {
  it('leaves text of scripts that do not join as it is', () => {
    const chunks = ['Lange ', 'Nieuw', 'straat'];
    expect(joinChunks(chunks, 'Lange Nieuwstraat')).toBe(chunks);
    expect(joinChunks(['one'], 'one')).toEqual(['one']);
  });

  it('joins letters of a word that is cut, in the order of the text', () => {
    const text = SEEN + LAM + ALEF + MEEM;
    expect(joinChunks([SEEN + LAM, ALEF + MEEM], text)).toEqual([SEEN + LAM + ZWJ, ZWJ + ALEF + MEEM]);
  });

  it('joins when the chunks are in the order of the line, not of the text', () => {
    const text = SEEN + LAM + ALEF + MEEM;
    // right to left text on a line that is read from left to right: the last chunk of the text comes first
    expect(joinChunks([ALEF + MEEM, SEEN + LAM], text)).toEqual([ZWJ + ALEF + MEEM, SEEN + LAM + ZWJ]);
  });

  it('does not join across a space or to another script', () => {
    const text = `${SEEN + LAM} ${ALEF + MEEM} A`;
    const chunks = [`${SEEN + LAM} `, ALEF + MEEM, ' A'];
    expect(joinChunks(chunks, text)).toEqual(chunks);
  });

  it('looks past combining marks at the end of a chunk', () => {
    const fatha = 'َ';
    const text = SEEN + fatha + LAM;
    expect(joinChunks([SEEN + fatha, LAM], text)).toEqual([SEEN + fatha + ZWJ, ZWJ + LAM]);
  });

  it('leaves chunks alone that do not make up the text', () => {
    const chunks = [SEEN, MEEM];
    expect(joinChunks(chunks, SEEN + LAM + MEEM)).toBe(chunks);
  });
});

describe('orderBy', () => {
  it('gives the places in the order of their values, equal ones as they are', () => {
    expect([...orderBy([3, 1, 2, 1, 3], 5)!]).toEqual([1, 3, 2, 0, 4]);
    expect([...orderBy([3, 1, 2, 1, 3], 5, true)!]).toEqual([0, 4, 2, 1, 3]);
    expect([...orderBy([], 0)!]).toEqual([]);
  });

  it('takes numbers that are not whole, and below zero', () => {
    expect([...orderBy([0.5, -2, 1e12, -2.5], 4)!]).toEqual([3, 1, 0, 2]);
  });

  it('keeps equal values in the order of another order', () => {
    // by age first (place 2 is the oldest), then by z-index falling
    const byAge = orderBy([30, 20, 10, 40], 4)!;
    expect([...byAge]).toEqual([2, 1, 0, 3]);
    expect([...orderBy([1, 5, 1, 5], 4, true, byAge)!]).toEqual([1, 3, 2, 0]);
  });

  it('is null for a value that is not a number', () => {
    expect(orderBy([1, NaN], 2)).toBeNull();
  });

  it('gives what a sort with a function gives, for many values', () => {
    const n = 20000;
    const values = Array.from({length: n}, (_v, i) => (i * 7919) % 613);
    const expected = Array.from({length: n}, (_v, i) => i).sort((a, b) => values[a] - values[b] || a - b);
    expect([...orderBy(values, n)!]).toEqual(expected);
  });
});

describe('orderByWhole', () => {
  it('orders whole numbers of up to 32 bits, equal ones as they are', () => {
    const values = Uint32Array.of(70000, 3, 4000000000, 3, 65536, 0);
    expect([...orderByWhole(values, values.length)]).toEqual([5, 1, 3, 4, 0, 2]);
  });
});

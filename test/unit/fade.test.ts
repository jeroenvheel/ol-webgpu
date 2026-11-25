/**
 * The fade of a label as one number (text/shaders.ts): what is written to
 * the glyphs once, and what the shaders make of it for every frame.
 */
import {describe, expect, it} from 'vitest';
import {FADE, HIDDEN, SHOWN, fadeAlpha, fadeFrom} from '../../src/text/shaders.js';

const seconds = FADE / 1000;

describe('label fades', () => {
  it('shown and hidden hold at any time', () => {
    for (const time of [1, 1.01, 50, 20000]) {
      expect(fadeAlpha(SHOWN, time)).toBe(1);
      expect(fadeAlpha(HIDDEN, time)).toBe(0);
    }
  });

  it('fades in from nothing and out from full in the time of a fade', () => {
    const time = 12;
    const fadeIn = fadeFrom(0, time, true);
    expect(fadeAlpha(fadeIn, time)).toBeCloseTo(0, 6);
    expect(fadeAlpha(fadeIn, time + seconds / 2)).toBeCloseTo(0.5, 6);
    expect(fadeAlpha(fadeIn, time + seconds)).toBeCloseTo(1, 6);
    expect(fadeAlpha(fadeIn, time + 10)).toBe(1);
    const fadeOut = fadeFrom(1, time, false);
    expect(fadeAlpha(fadeOut, time)).toBeCloseTo(1, 6);
    expect(fadeAlpha(fadeOut, time + seconds / 3)).toBeCloseTo(2 / 3, 6);
    expect(fadeAlpha(fadeOut, time + seconds)).toBeCloseTo(0, 6);
    expect(fadeAlpha(fadeOut, time + 10)).toBe(0);
  });

  it('turns around from where it is', () => {
    const time = 7;
    // a third of the way in, then out again: from a third, in a third of the time
    const fadeOut = fadeFrom(1 / 3, time, false);
    expect(fadeAlpha(fadeOut, time)).toBeCloseTo(1 / 3, 6);
    expect(fadeAlpha(fadeOut, time + seconds / 3)).toBeCloseTo(0, 6);
    const fadeIn = fadeFrom(0.8, time, true);
    expect(fadeAlpha(fadeIn, time)).toBeCloseTo(0.8, 6);
    expect(fadeAlpha(fadeIn, time + seconds * 0.2)).toBeCloseTo(1, 6);
  });

  it('is shown or hidden at once when there is nothing to fade', () => {
    expect(fadeFrom(1, 5, true)).toBe(SHOWN);
    expect(fadeFrom(0, 5, false)).toBe(HIDDEN);
  });

  it('keeps its side as a 32 bit float', () => {
    // what the buffer holds: a fade in is zero or more, a fade out below zero
    expect(Math.fround(fadeFrom(0.5, 1, true))).toBeGreaterThanOrEqual(0);
    expect(Math.fround(fadeFrom(0.5, 1, false))).toBeLessThan(0);
    expect(Math.fround(HIDDEN)).toBeLessThan(0);
  });
});

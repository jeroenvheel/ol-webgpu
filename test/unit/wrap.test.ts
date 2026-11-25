/**
 * `text-max-width`: where a label is broken into lines (text/wrap.ts).
 */
import {describe, expect, it} from 'vitest';
import {wrapText} from '../../src/text/wrap.js';

// every character is 10 wide
const measure = (text: string) => text.length * 10;

describe('wrapText', () => {
  it('leaves a text that fits, and a text without a place to break', () => {
    expect(wrapText('one two', 70, measure)).toBe('one two');
    expect(wrapText('onetwothree', 30, measure)).toBe('onetwothree');
    expect(wrapText('one two', 0, measure)).toBe('one two');
  });

  it('breaks at spaces so that no line is wider', () => {
    expect(wrapText('one two three four', 70, measure)).toBe('one two\nthree\nfour');
    expect(wrapText('one two three four', 90, measure)).toBe('one two\nthree\nfour');
    expect(wrapText('one two three four', 100, measure)).toBe('one two\nthree four');
    expect(wrapText('one two three four', 130, measure)).toBe('one two three\nfour');
  });

  it('does not cut a word that is too wide on its own', () => {
    expect(wrapText('a verylongword b', 50, measure)).toBe('a\nverylongword\nb');
  });

  it('keeps the line breaks of the text', () => {
    expect(wrapText('one two\nthree four five', 80, measure)).toBe('one two\nthree\nfour\nfive');
    expect(wrapText('one\ntwo', 30, measure)).toBe('one\ntwo');
  });
});

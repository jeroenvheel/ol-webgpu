/**
 * `text-max-width`: where a label is broken into lines (text/wrap.ts).
 */
import {describe, expect, it} from 'vitest';
import {wrapChunks, wrapText} from '../../src/text/wrap.js';

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

describe('wrapChunks', () => {
  // a letter is 10 wide, and 20 in the font 'big'
  const measure = (text: string, font: string) => text.length * (font === 'big' ? 20 : 10);

  it('leaves parts that fit', () => {
    const chunks = ['one ', '', 'two', 'big'];
    expect(wrapChunks(chunks, 200, measure)).toBe(chunks);
    expect(wrapChunks(chunks, 0, measure)).toBe(chunks);
  });

  it('breaks at a space inside a part, with the width of each font', () => {
    // 'one two' is 70 wide, ' six' in the big font 80 more
    expect(wrapChunks(['one two', '', ' six', 'big'], 100, measure)).toEqual(['one', '', ' ', '', 'two', '', '\n', '', 'six', 'big']);
    // the same text fits in the small font
    expect(wrapChunks(['one two', '', ' six', ''], 110, measure)).toEqual(['one two', '', ' six', '']);
  });

  it('keeps parts that touch together as one word', () => {
    // 'ab' + 'cd' is one word of 60: it goes to the next line as a whole
    expect(wrapChunks(['xx ab', '', 'cd', 'big'], 70, measure)).toEqual(['xx', '', '\n', '', 'ab', '', 'cd', 'big']);
  });

  it('keeps the line breaks that are there and starts counting again after them', () => {
    expect(wrapChunks(['aa bb', '', '\n', '', 'cc dd ee', ''], 50, measure)).toEqual(['aa', '', ' ', '', 'bb', '', '\n', '', 'cc', '', ' ', '', 'dd', '', '\n', '', 'ee', '']);
  });

  it('does not cut a word that is too wide on its own', () => {
    expect(wrapChunks(['a wideword b', ''], 30, measure)).toEqual(['a', '', '\n', '', 'wideword', '', '\n', '', 'b', '']);
  });
});

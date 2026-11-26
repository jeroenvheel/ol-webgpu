/**
 * `text-max-width`: a label that is wider is broken into lines.
 *
 * ol's flat styles have no such property (ol draws a label as it is given,
 * with the line breaks in its text). Here a text style may say
 * `'text-max-width': 120` (CSS pixels of the label as it is drawn, a number
 * or an expression): lines are broken at spaces so that none is wider. A
 * word that is wider than that on its own is not cut.
 */

/** Characters a line may be broken at: they go when it is. */
const BREAK = /[ ​]/;

/**
 * @param text the text of a label, with or without line breaks of its own
 * @param maxWidth the widest a line may be, in the units of `measure`
 * @param measure the width of a piece of text
 * @return the text with line breaks added (the same string when none is needed)
 */
export function wrapText(text: string, maxWidth: number, measure: (text: string) => number): string {
  if (!(maxWidth > 0) || !BREAK.test(text)) {
    return text;
  }
  const space = measure(' ');
  let changed = false;
  const lines = text.split('\n').map((line) => {
    if (measure(line) <= maxWidth) {
      return line;
    }
    const out: string[] = [];
    let current = '';
    let width = 0;
    for (const word of line.split(BREAK)) {
      const w = word ? measure(word) : 0;
      if (current && width + space + w > maxWidth) {
        out.push(current);
        current = word;
        width = w;
      } else {
        width = current ? width + space + w : w;
        current = current ? `${current} ${word}` : word;
      }
    }
    out.push(current);
    changed ||= out.length > 1;
    return out.join('\n');
  });
  return changed ? lines.join('\n') : text;
}

/**
 * The same for a text in parts with fonts of their own (ol's rich text:
 * `[text, font, text, font, ...]`, a part that is `'\n'` starts a line).
 * A line is broken at a space inside a part; the space goes. Parts that
 * touch without a space are one word, whatever their fonts.
 * @param measure the width of a piece of text in a font (`''`: the font of the style)
 * @return the parts with line breaks added (the same array when none is needed)
 */
export function wrapChunks(chunks: string[], maxWidth: number, measure: (text: string, font: string) => number): string[] {
  if (!(maxWidth > 0)) {
    return chunks;
  }
  const out: string[] = [];
  let changed = false;
  let lineWidth = 0;
  // the word in the making: its pieces, and the space it is written after
  let word: Array<[text: string, font: string]> = [];
  let wordWidth = 0;
  let space = false;
  let spaceFont = '';
  const endWord = () => {
    if (!word.length) {
      return;
    }
    const gap = space && lineWidth > 0 ? measure(' ', spaceFont) : 0;
    if (lineWidth > 0 && space && lineWidth + gap + wordWidth > maxWidth) {
      out.push('\n', '');
      changed = true;
      lineWidth = 0;
    } else if (gap) {
      out.push(' ', spaceFont);
      lineWidth += gap;
    }
    for (const [text, font] of word) {
      out.push(text, font);
    }
    lineWidth += wordWidth;
    word = [];
    wordWidth = 0;
    space = false;
  };
  for (let i = 0; i + 1 < chunks.length; i += 2) {
    const text = chunks[i];
    const font = chunks[i + 1];
    if (text === '\n') {
      endWord();
      out.push(text, font);
      lineWidth = 0;
      space = false;
      continue;
    }
    const pieces = text.split(BREAK);
    for (let p = 0; p < pieces.length; p++) {
      if (p > 0) {
        // a space: the word before it is done
        endWord();
        space = true;
        spaceFont = font;
      }
      if (pieces[p]) {
        word.push([pieces[p], font]);
        wordWidth += measure(pieces[p], font);
      }
    }
  }
  endWord();
  return changed ? out : chunks;
}

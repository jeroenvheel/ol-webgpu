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

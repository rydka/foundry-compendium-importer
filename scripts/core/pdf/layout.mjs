/**
 * Page layout: columns, lines and the text of a line. Port of `column_split`, `group_lines`, `join_words`,
 * `page_columns`, `is_footer_line` and `extract_lines_from_page` of the Python tool.
 *
 * @typedef {object} PdfLine
 * @property {string} text    Text of the line, words joined by the layout (see `joinWords`).
 * @property {number} y       Baseline of the first word.
 * @property {number} x0      Left edge.
 * @property {number} x1      Right edge.
 * @property {number} size    Largest font size of the line.
 * @property {import("./page-model.mjs").PdfWord[]} words  Words, left to right.
 * @property {number} [col]   Column index (set by `pageColumns`).
 */

const LINE_TOLERANCE = 2.5;
const GAP_RATIO = 0.15;

/** Collapse whitespace. */
export const normalizeSpace = value => String(value ?? "").replace(/\s+/g, " ").trim();

/**
 * Running header or footer: letters doubled many times ("TTTTTTTTHHHHHHHH...", "1111111111555...", a page number
 * "1313131313", "IGIGIGIGIGIG").
 * @param {string} text
 * @returns {boolean}
 */
export function isFooterLine(text) {
  const compact = String(text ?? "").replace(/\s+/g, "");
  return !!compact && /^(?:(.{1,2})\1{3,})+[’']?(?:(.{1,2})\2{3,})*.?$/.test(compact);
}

/**
 * x of the gap between the two columns (the fewest words crossing it near the middle), null for one column.
 * @param {import("./page-model.mjs").PdfWord[]} words
 * @param {number} width
 * @returns {number|null}
 */
export function columnSplit(words, width) {
  let best = null;
  const from = Math.floor(width * 0.4);
  const to = Math.floor(width * 0.6);
  for ( let x = from; x <= to; x++ ) {
    let crossing = 0;
    for ( const w of words ) if ( (w.x0 < x) && (x < w.x1) ) crossing++;
    const distance = Math.abs(x - width / 2);
    if ( !best || (crossing < best.crossing) || ((crossing === best.crossing) && (distance < best.distance)) ) {
      best = { crossing, distance, x };
    }
  }
  if ( !best || best.crossing > 3 ) return null;
  return best.x;
}

/**
 * Words of a line with a space only where the layout has one: a gap wider than 0.15 × the font size. A word set
 * in another font is a word of its own ("invisible" in italic then "." stays "invisible."). A line that ends with
 * "letter-" followed by a lowercase word is joined without a space, hyphen kept.
 * @param {import("./page-model.mjs").PdfWord[]} words  Left to right.
 * @returns {string}
 */
export function joinWords(words) {
  let out = "";
  let prev = null;
  for ( const w of words ) {
    if ( prev ) {
      const gap = w.x0 - prev.x1;
      const size = Math.max(prev.size, w.size, 1);
      if ( gap > GAP_RATIO * size ) out += " ";
    }
    out += w.str;
    prev = w;
  }
  return normalizeSpace(out);
}

/**
 * Group words into lines by baseline (tolerance 2.5 points), top to bottom; words left to right in a line.
 * @param {import("./page-model.mjs").PdfWord[]} words
 * @returns {PdfLine[]}
 */
export function groupLines(words) {
  const sorted = words.map((w, index) => ({ w, index }))
    .sort((a, b) => (b.w.y - a.w.y) || (a.w.x0 - b.w.x0) || (a.index - b.index))
    .map(({ w }) => w);
  const lines = [];
  for ( const w of sorted ) {
    const last = lines.at(-1);
    if ( last && (Math.abs(w.y - last.y) <= LINE_TOLERANCE) ) last.words.push(w);
    else lines.push({ y: w.y, words: [w] });
  }
  for ( const line of lines ) {
    line.words.sort((a, b) => a.x0 - b.x0);
    line.text = joinWords(line.words);
    line.size = Math.max(...line.words.map(w => w.size || 0));
    line.x0 = Math.min(...line.words.map(w => w.x0));
    line.x1 = Math.max(...line.words.map(w => w.x1));
  }
  return lines.filter(line => line.text);
}

/**
 * Lines of the page, column after column (left then right); each line carries its column index.
 * @param {import("./page-model.mjs").PdfPage} page
 * @returns {PdfLine[][]}
 */
export function pageColumns(page) {
  const words = page.items ?? [];
  const split = columnSplit(words, page.width);
  const columns = split === null
    ? [groupLines(words)]
    : [groupLines(words.filter(w => (w.x0 + w.x1) / 2 < split)), groupLines(words.filter(w => (w.x0 + w.x1) / 2 >= split))];
  columns.forEach((lines, col) => lines.forEach(line => { line.col = col; }));
  return columns;
}

/**
 * All the lines of the page in reading order (left column, then right column), footers removed.
 * @param {import("./page-model.mjs").PdfPage} page
 * @returns {PdfLine[]}
 */
export function pageLines(page) {
  return pageColumns(page).flat().filter(line => !isFooterLine(line.text));
}

/**
 * Lines of the page interleaved by baseline, whatever the column (the raw order of `extract_lines_from_page`).
 * @param {import("./page-model.mjs").PdfPage} page
 * @returns {PdfLine[]}
 */
export function interleavedLines(page) {
  return groupLines(page.items ?? []).filter(line => !isFooterLine(line.text));
}

/** Text of the whole page (one string per line, reading order). */
export function pageText(page) {
  return pageLines(page).map(line => line.text).join("\n");
}

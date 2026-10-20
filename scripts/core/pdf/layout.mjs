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
 * "1313131313", "IGIGIGIGIGIG", "H’SH’SH’SH’S").
 * @param {string} text
 * @returns {boolean}
 */
export function isFooterLine(text) {
  const compact = String(text ?? "").replace(/\s+/g, "");
  return !!compact && /^(?:(.{1,3}?)\1{3,})+.?$/.test(compact);
}

const GUTTER_HALF_WIDTH = 4;
const GUTTER_MAX_LINES = 3;
const GUTTER_MAX_SHARE = 0.15;

/**
 * x of the gutter between the two columns, null for one column. The gutter is the 8-point band near the middle
 * that the fewest lines cross: at most three lines (a banner across both columns), and at most 15 % of the lines
 * of the page, so a sparse one-column page whose few long lines happen to leave a gap is not split.
 * @param {import("./page-model.mjs").PdfWord[]} words
 * @param {number} width
 * @returns {number|null}
 */
export function columnSplit(words, width) {
  const lines = groupLines(words);
  if ( !lines.length ) return null;
  let best = null;
  const from = Math.floor(width * 0.4);
  const to = Math.floor(width * 0.6);
  for ( let x = from; x <= to; x++ ) {
    const left = x - GUTTER_HALF_WIDTH;
    const right = x + GUTTER_HALF_WIDTH;
    let crossing = 0;
    for ( const line of lines ) if ( line.words.some(w => (w.x0 < right) && (w.x1 > left)) ) crossing++;
    const distance = Math.abs(x - width / 2);
    if ( !best || (crossing < best.crossing) || ((crossing === best.crossing) && (distance < best.distance)) ) {
      best = { crossing, distance, x };
    }
  }
  if ( best.crossing > GUTTER_MAX_LINES || best.crossing > Math.max(1, GUTTER_MAX_SHARE * lines.length) ) return null;
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
      // A font change between two words ("Saving Throws" in bold, "Dex +6" in regular) is a word boundary unless
      // the next word is punctuation ("invisible" in italic then "."): the widths of a line set as one item are
      // estimated per character, so the gap alone is not reliable there.
      const fontChange = (w.font !== prev.font) && /^[\p{L}\d(+-]/u.test(w.str) && !/[(\-–]$/.test(prev.str);
      if ( gap > GAP_RATIO * size || (fontChange && gap > -0.3 * size) ) out += " ";
    }
    out += w.str;
    prev = w;
  }
  return normalizeSpace(out);
}

/**
 * A running header or footer in the top or bottom margin of the page: a bare page number ("12"), letter-spaced
 * words ("T H E H O L L O W C H O I R 1") or doubled letters (`isFooterLine`). Body text is never tested by its
 * position alone: some books print their last line very low.
 * @param {PdfLine} line
 * @param {number} height  Page height.
 * @returns {boolean}
 */
export function isMarginLine(line, height) {
  const inMargin = (line.y < 0.07 * height) || (line.y > 0.93 * height);
  if ( !inMargin ) return false;
  const text = line.text;
  return /^\d{1,4}$/.test(text) || /^(?:\S\s){3,}\S?$/.test(text) || isFooterLine(text);
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
  return columns.map((lines, col) => lines.filter(line => !isMarginLine(line, page.height ?? 0))
    .map(line => Object.assign(line, { col })));
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

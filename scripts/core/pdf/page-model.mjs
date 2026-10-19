/**
 * Page model: the pure, pdf.js-independent view of one page that every other `core/pdf` module reads.
 * This format is the contract with the tests (`tests/support/pdfjs-node.mjs` builds it in Node).
 *
 * @typedef {object} PdfWord
 * @property {string} str   Text of the word (no whitespace, cleaned by `cleanText`).
 * @property {number} x0    Left edge, in PDF points (origin at the bottom left of the page).
 * @property {number} x1    Right edge.
 * @property {number} y     Baseline.
 * @property {number} size  Font size (the pdf.js `height` of the item, or the scale of its transform).
 * @property {string} font  Real font name (`MAAAAA+ScalySansRemakeBoldItalic`), or the pdf.js identifier
 *                          (`g_d0_f16`) when the name could not be resolved.
 *
 * @typedef {object} PdfPage
 * @property {number} number   1-based page number.
 * @property {number} width    Page width, in points.
 * @property {number} height   Page height, in points.
 * @property {PdfWord[]} items Words of the page, in the order pdf.js gave them (not sorted).
 */

// Code points written as escapes: private-use area U+E000-U+F8FF (dice fonts), soft hyphen U+00AD, minus U+2212,
// non-breaking and figure spaces U+00A0, U+202F, U+2007.
const PRIVATE_USE = new RegExp("[\uE000-\uF8FF\u00AD]", "g");
const MINUS = new RegExp("\u2212", "g");
const HARD_SPACES = new RegExp("[\u00A0\u202F\u2007]", "g");

/**
 * Clean the text of a pdf.js item: private-use glyphs (dice fonts), soft hyphens, minus sign to hyphen,
 * non-breaking spaces to spaces.
 * @param {string} str
 * @returns {string}
 */
export function cleanText(str) {
  return String(str ?? "").replace(PRIVATE_USE, "").replace(MINUS, "-").replace(HARD_SPACES, " ");
}

/**
 * Split items into words. pdf.js items are sometimes a whole line, sometimes a word, sometimes one character:
 * the width of each word is the share of the item's width proportional to its characters.
 * @param {PdfWord[]} items  Items with the fields of a word (`str` may hold spaces).
 * @returns {PdfWord[]}
 */
export function splitWords(items) {
  const words = [];
  for ( const item of items ) {
    const str = String(item.str ?? "");
    if ( !str.trim() ) continue;
    const charWidth = (item.x1 - item.x0) / str.length;
    const re = /\S+/g;
    let m;
    while ( (m = re.exec(str)) ) {
      const x0 = item.x0 + m.index * charWidth;
      words.push({ str: m[0], x0, x1: x0 + m[0].length * charWidth, y: item.y, size: item.size, font: item.font });
    }
  }
  return words;
}

/**
 * Convert the output of `page.getTextContent()` into a page model.
 * @param {{items: object[]}} textContent  pdf.js text content (`items[{ str, transform, width, height, fontName }]`).
 * @param {{number: number, width: number, height: number}} page
 * @param {Record<string, string>} [fontNames]  pdf.js font identifier to real font name.
 * @returns {PdfPage}
 */
export function toPageModel(textContent, { number, width, height }, fontNames = {}) {
  const raw = [];
  for ( const item of textContent?.items ?? [] ) {
    if ( typeof item?.str !== "string" ) continue;
    const str = cleanText(item.str);
    if ( !str.trim() ) continue;
    const t = item.transform ?? [1, 0, 0, 1, 0, 0];
    const size = item.height || Math.hypot(t[2], t[3]) || 0;
    raw.push({ str, x0: t[4], x1: t[4] + (item.width ?? 0), y: t[5], size, font: fontNames[item.fontName] ?? item.fontName ?? "" });
  }
  return { number, width, height, items: splitWords(raw) };
}

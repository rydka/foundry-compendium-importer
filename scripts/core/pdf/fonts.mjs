/**
 * Font names of a PDF: family and style. Port of `font_family` / `is_bold_italic` of the Python tool, extended to
 * the `Oblique` of the standard fonts (`Helvetica-BoldOblique`).
 */

const STYLE_SUFFIX = /[-_,]?(regular|regul|bold|ital|italic|oblique|medium|semibold|light|mt|psmt)+$/;
const UNRESOLVED = /^g_d\d+_f\d+$/;

/**
 * `'GAAAAA+ScalySansRemakeBoldItal'` -> `'scalysansremake'`.
 * @param {string} name
 * @returns {string}
 */
export function fontFamily(name) {
  const base = String(name ?? "").split("+").pop().toLowerCase();
  return base.replace(STYLE_SUFFIX, "");
}

/**
 * Bold and italic read from the font name. Both false for an unresolved pdf.js identifier (`g_d0_f16`).
 * @param {string} name
 * @returns {{bold: boolean, italic: boolean, known: boolean}}
 */
export function fontStyle(name) {
  const low = String(name ?? "").toLowerCase();
  const known = !!low && !UNRESOLVED.test(low);
  return {
    bold: known && /bold|black|heavy|semibold|demibold|extrabold|ultrabold/.test(low),
    italic: known && /ital|oblique/.test(low),
    known
  };
}

/** True when the font name is a pdf.js identifier, not a real name. */
export const isUnresolved = name => UNRESOLVED.test(String(name ?? ""));

/**
 * Fallback when the font names are unknown: the entry font (the one of "Shadow Meld.") is the most frequent font
 * of the heads of lines that end with a period, in the lines given (the entries area of the block).
 * @param {{words: {str: string, font: string}[]}[]} lines
 * @param {Iterable<string>} [bodyFonts]  Fonts that cannot be the entry font (the regular body font).
 * @returns {string|null}
 */
export function inferEntryFont(lines, bodyFonts = []) {
  const excluded = new Set(bodyFonts);
  const counts = new Map();
  for ( const line of lines ) {
    const words = line.words ?? [];
    if ( !words.length ) continue;
    const font = words[0].font;
    if ( excluded.has(font) ) continue;
    let n = 0;
    while ( n < words.length && words[n].font === font && n < 6 ) n++;
    if ( n === words.length && n > 4 ) continue; // a whole line in one font: body text, not a head
    const head = words.slice(0, n).map(w => w.str).join(" ");
    if ( !/[.:]$/.test(head) ) continue;
    counts.set(font, (counts.get(font) ?? 0) + 1);
  }
  let best = null;
  for ( const [font, count] of counts ) if ( !best || count > best.count ) best = { font, count };
  return best?.font ?? null;
}

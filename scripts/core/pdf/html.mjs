/**
 * Text of a PDF written into an HTML description. Besides `&`, `<` and `>`, the sequences that start a Foundry or
 * dnd5e enricher are broken by markup, so a PDF cannot plant `@UUID[...]`, `@Embed[...]`, `[[/r ...]]` or
 * `&Reference[...]` that the editor would execute when the description is rendered. Entities alone are not
 * enough: Foundry decodes them when the document is written (`&#64;` becomes `@` again). A `<span>` around the
 * first character keeps the text as written (the text content is unchanged) while the enricher patterns, which
 * run on each text node, no longer match: `<span>@</span>UUID[...]`, `<span>[</span>[/r 2d6]]`.
 */

const DOCUMENT_LINK = /@(?=\w+\[)/g; // @UUID[, @Actor[, @Embed[, @Compendium[…
const INLINE_ROLL = /\[\[/g; // [[/r 1d6]], [[/damage ...]], [[lookup ...]]
const REFERENCE = /&amp;(?=\w+\[)/g; // dnd5e &Reference[...]

/**
 * @param {string} text
 * @returns {string}
 */
export function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(DOCUMENT_LINK, "<span>@</span>")
    .replace(REFERENCE, "<span>&amp;</span>")
    .replace(INLINE_ROLL, "<span>[</span>[");
}

/** Enricher patterns of Foundry v14 and dnd5e 6, on plain text (one text node): used by the tests. */
export const ENRICHER_PATTERNS = Object.freeze([/@\w+\[/, /\[\[/, /&\w+\[/]);

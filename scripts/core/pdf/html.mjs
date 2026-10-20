/**
 * Text of a PDF written into an HTML description. Besides `&`, `<` and `>`, the characters that start a Foundry
 * enricher are written as entities, so a PDF cannot plant `@UUID[...]`, `@Embed[...]` or `[[/r ...]]` that the
 * editor would execute when the description is rendered.
 * @param {string} text
 * @returns {string}
 */
export function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/@/g, "&#64;")
    .replace(/\[/g, "&#91;");
}

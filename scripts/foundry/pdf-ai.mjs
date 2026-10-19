/**
 * Local AI (Ollama) for the blocks the rules could not read (C5). Filled in by the AI task (D5): until then, the
 * queue is left as problems of the review.
 */

/**
 * Submit the queued blocks to the local AI and add the accepted actors to the extraction.
 * @param {object} extraction  Result of `extractDocument` (modified in place: `actors`, `blocks`, `problems`).
 * @param {{ai: object, parser: object, fileName: string, signal?: AbortSignal, onProgress?: Function}} ctx
 * @returns {Promise<void>}
 */
export async function readBlocksWithAi(extraction, ctx) {
  void extraction;
  void ctx;
}

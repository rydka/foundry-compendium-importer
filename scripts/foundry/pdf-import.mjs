import { MODULE_ID } from "../constants.mjs";
import { extractDocumentAsync } from "../core/pdf/extract.mjs";
import { loadParser } from "./enrichment.mjs";
import { pdfLimits } from "./settings.mjs";
import { PdfReadError, readPdf } from "./pdf-reader.mjs";
import { readBlocksWithAi } from "./pdf-ai.mjs";

/**
 * Error of the PDF import, shown to the GM: `code` is one of scanned, encrypted, invalid, readerUnavailable,
 * parserMissing, aborted.
 */
export class PdfImportError extends Error {
  constructor(code, detail = "", data = {}) {
    super(`${code}${detail ? `: ${detail}` : ""}`);
    this.name = "PdfImportError";
    this.code = code;
    /** Values for the translated message (`Error.Pdf.<code>`). */
    this.data = data;
  }
}

const MB = 1024 * 1024;

/** Bytes of a File, a Blob, an ArrayBuffer or a Uint8Array. */
async function toBytes(fileOrBytes) {
  if ( fileOrBytes instanceof Uint8Array ) return fileOrBytes;
  if ( fileOrBytes instanceof ArrayBuffer ) return new Uint8Array(fileOrBytes);
  if ( typeof fileOrBytes?.arrayBuffer === "function" ) return new Uint8Array(await fileOrBytes.arrayBuffer());
  throw new PdfImportError("invalid", "not a file");
}

/**
 * Read a PDF and extract its creatures and magic items as dnd5e sources, ready for `analyzeEntries`.
 * @param {File|Blob|ArrayBuffer|Uint8Array} fileOrBytes
 * @param {object} [opts]
 * @param {string} [opts.fileName]  Name of the file (seeds the ids, shown in the review).
 * @param {string} [opts.documentName]  "Actor" or "Item": only the entries of that type are kept; the others
 *   are counted in `report.ignoredOtherType`. Omitted: both.
 * @param {AbortSignal} [opts.signal]
 * @param {Function} [opts.onProgress]  `({ stage: "pdfOpen"|"pdfPage"|"pdfAi", done?, total?, name? })`
 * @param {object|null} [opts.ai]  Local AI configuration (`aiConfig()`), null or `enabled: false` for none.
 * @param {{maxSizeMb?: number, maxPages?: number}} [opts.limits]  Size and page limits (`pdfLimits()`), 0 = none.
 * @returns {Promise<{entries: object[], meta: {docType: string}, report: object}>}
 * @throws {PdfImportError}
 */
export async function extractFromPdf(fileOrBytes, { fileName = "", documentName, signal, onProgress, ai = null, limits = pdfLimits() } = {}) {
  const parser = await loadParser();
  if ( !parser ) throw new PdfImportError("parserMissing");
  const bytes = await toBytes(fileOrBytes);
  const name = fileName || fileOrBytes?.name || "document.pdf";
  const sizeMb = bytes.length / MB;
  if ( limits?.maxSizeMb && (sizeMb > limits.maxSizeMb) ) {
    throw new PdfImportError("tooLarge", `${sizeMb.toFixed(0)} MB > ${limits.maxSizeMb} MB`, { size: sizeMb.toFixed(0), limit: limits.maxSizeMb });
  }
  onProgress?.({ stage: "pdfOpen" });
  let pages;
  let timings;
  try {
    ({ pages, timings } = await readPdf(bytes, {
      signal, maxPages: limits?.maxPages ?? 0, onPage: (done, total) => onProgress?.({ stage: "pdfPage", done, total })
    }));
  } catch(err) {
    if ( err instanceof PdfReadError ) throw new PdfImportError(err.code, err.message, err.data ?? {});
    throw err;
  }
  const t0 = performance.now();
  let extraction;
  try {
    // One page per turn of the event loop: the window repaints and the Cancel button works during the extraction
    extraction = await extractDocumentAsync(pages, { parser, fileName: name }, { signal, yieldTo: () => new Promise(resolve => setTimeout(resolve, 0)) });
  } catch(err) {
    if ( err?.name === "AbortError" ) throw new PdfImportError("aborted");
    throw err;
  }
  timings.extract = performance.now() - t0;
  if ( extraction.scanned ) throw new PdfImportError("scanned");

  timings.ai = 0;
  if ( ai?.enabled && extraction.aiQueue.length ) {
    const t1 = performance.now();
    await readBlocksWithAi(extraction, { ai, parser, fileName: name, signal, onProgress });
    timings.ai = performance.now() - t1;
  }
  if ( signal?.aborted ) throw new PdfImportError("aborted");

  const { actors, items } = extraction;
  const ignoredOtherType = { Actor: 0, Item: 0 };
  let entries;
  if ( documentName === "Actor" ) { entries = actors; ignoredOtherType.Item = items.length; }
  else if ( documentName === "Item" ) { entries = items; ignoredOtherType.Actor = actors.length; }
  else entries = [...actors, ...items];
  // Sources written for the current dnd5e: the validator checks them strictly instead of migrating them
  for ( const entry of entries ) entry._stats = { systemId: game.system.id, systemVersion: game.system.version };
  const report = {
    fileName: name,
    pages: pages.length,
    scanned: false,
    timings,
    blocks: extraction.blocks,
    items: items.map(i => ({ name: i.name, page: i.flags?.[MODULE_ID]?.pdf?.page ?? null })),
    ignoredOtherType,
    problems: extraction.problems,
    stats: extraction.stats
  };
  return { entries, meta: { docType: documentName ?? (actors.length ? "Actor" : "Item") }, report };
}

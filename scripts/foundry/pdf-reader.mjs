import { MODULE_ID } from "../constants.mjs";
import { toPageModel } from "../core/pdf/page-model.mjs";
import { mayHoldStatBlock } from "../core/pdf/lexicon.mjs";
import { mayHoldItemHeader } from "../core/pdf/magic-item.mjs";

/**
 * Reads a PDF with the pdf.js that Foundry ships and serves under /scripts/pdfjs (node_modules/@foundryvtt/pdfjs,
 * version 4.0.379 in Foundry 14.369). This is not a documented API: `loadPdfJs` checks the version and the exports
 * and fails with a clear message when they change. The document is parsed in a Web Worker created here (a port
 * given to pdf.js, so the global worker options stay untouched) and terminated when the read ends or is cancelled.
 */

const PDFJS_MIN_MAJOR = 4;
const ROUTE_LIB = "scripts/pdfjs/build/pdf.mjs";
const ROUTE_WORKER = "scripts/pdfjs/build/pdf.worker.mjs";
const ROUTE_CMAPS = "scripts/pdfjs/web/cmaps/";
const ROUTE_FONTS = "scripts/pdfjs/web/standard_fonts/";
const PAGE_BATCH = 8;

let pdfjsPromise = null;
/** Workers alive right now (tests check that a cancelled or finished read leaves none). */
let liveWorkers = 0;

/** Error of the PDF reader: `code` is one of readerUnavailable, encrypted, invalid, tooManyPages, aborted. */
export class PdfReadError extends Error {
  constructor(code, detail = "") {
    super(`${code}${detail ? `: ${detail}` : ""}`);
    this.name = "PdfReadError";
    this.code = code;
  }
}

/** Number of pdf.js workers alive. */
export const pdfWorkerCount = () => liveWorkers;

/**
 * Load the pdf.js build served by Foundry (once). Rejects with `readerUnavailable` when it is missing or too old.
 * @returns {Promise<object>}  The pdf.js module (`getDocument`, `PDFWorker`, `VerbosityLevel`, `version`…).
 */
export function loadPdfJs() {
  pdfjsPromise ??= (async () => {
    let lib;
    try {
      lib = await import(foundry.utils.getRoute(ROUTE_LIB));
    } catch(err) {
      console.error(`${MODULE_ID} | cannot load pdf.js from Foundry`, err);
      throw new PdfReadError("readerUnavailable", String(err?.message ?? err));
    }
    return checkPdfJs(lib);
  })().catch(err => { pdfjsPromise = null; throw err; });
  return pdfjsPromise;
}

/**
 * Check a pdf.js module: version 4 or later, `getDocument` and `PDFWorker` exported.
 * @param {object} lib
 * @returns {object}  The same module.
 * @throws {PdfReadError} `readerUnavailable`
 */
export function checkPdfJs(lib) {
  const major = Number(String(lib?.version ?? "").split(".")[0]);
  if ( !(major >= PDFJS_MIN_MAJOR) || (typeof lib.getDocument !== "function") || (typeof lib.PDFWorker !== "function") ) {
    throw new PdfReadError("readerUnavailable", `pdf.js ${lib?.version ?? "?"}`);
  }
  return lib;
}

/** True when the text of a page may hold a stat block or a magic item (then its fonts are worth resolving). */
export function isCandidatePage(text) {
  return mayHoldStatBlock(text) || mayHoldItemHeader(text);
}

/**
 * Real font names of a page: pdf.js only gives identifiers (`g_d0_f16`) in the text content; the PostScript name
 * (`MAAAAA+ScalySansRemakeBoldItalic`) sits in `page.commonObjs` once the operator list is built.
 * @param {object} page  pdf.js page proxy.
 * @param {object[]} items  Text items of the page.
 * @param {Record<string, string>} fontNames  Known names, completed in place.
 * @returns {Promise<boolean>}  True when the operator list was built.
 */
async function resolveFonts(page, items, fontNames) {
  const missing = new Set(items.map(it => it.fontName).filter(id => id && !(id in fontNames)));
  if ( !missing.size ) return false;
  await page.getOperatorList();
  for ( const id of missing ) {
    let name = id;
    try {
      const font = page.commonObjs.has(id) ? page.commonObjs.get(id) : null;
      if ( font?.name ) name = font.name;
    } catch(err) {
      console.debug(`${MODULE_ID} | font ${id} not resolved`, err);
    }
    fontNames[id] = name;
  }
  return true;
}

const abortError = () => new PdfReadError("aborted");

/**
 * Read the pages of a PDF, one page model at a time.
 * @param {Uint8Array} bytes
 * @param {{signal?: AbortSignal, onPage?: (done: number, total: number) => void, timings?: object}} [opts]
 *   `timings` receives `open`, `pages` and `fonts` (ms).
 * @yields {import("../core/pdf/page-model.mjs").PdfPage}
 * @throws {PdfReadError} `readerUnavailable`, `encrypted`, `invalid`, `aborted`
 */
export async function* readPdfPages(bytes, { signal, onPage, timings = {}, maxPages = 0 } = {}) {
  const pdfjs = await loadPdfJs();
  if ( signal?.aborted ) throw abortError();
  const t0 = performance.now();
  let worker = null;
  let task = null;
  let terminated = false;
  // The worker is killed at once on abort (a busy worker would answer pdf.js's own Terminate only after its
  // current parse): every wait on it is raced against the abort, since a dead worker never answers
  const terminate = () => {
    if ( !worker || terminated ) return;
    terminated = true;
    worker.terminate();
    liveWorkers--;
  };
  let onAbort = null;
  const aborted = new Promise((_, reject) => {
    if ( signal?.aborted ) reject(abortError());
    onAbort = () => { terminate(); reject(abortError()); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(() => {});
  try {
    worker = new Worker(foundry.utils.getRoute(ROUTE_WORKER), { type: "module" });
    liveWorkers++;
    // A worker script that does not load (404, CSP) never answers pdf.js: its error event ends the wait
    const workerFailed = new Promise((_, reject) => worker.addEventListener("error", event => {
      reject(new PdfReadError("readerUnavailable", event?.message || "the pdf.js worker failed to load"));
    }, { once: true }));
    workerFailed.catch(() => {});
    const pdfWorker = new pdfjs.PDFWorker({ port: worker });
    task = pdfjs.getDocument({
      data: bytes,
      worker: pdfWorker,
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      maxImageSize: 0,
      verbosity: pdfjs.VerbosityLevel.ERRORS,
      cMapUrl: foundry.utils.getRoute(ROUTE_CMAPS),
      cMapPacked: true,
      standardFontDataUrl: foundry.utils.getRoute(ROUTE_FONTS)
    });
    let doc;
    try {
      doc = await Promise.race([task.promise, workerFailed, aborted]);
    } catch(err) {
      if ( err instanceof PdfReadError ) throw err;
      if ( signal?.aborted ) throw abortError();
      if ( err?.name === "PasswordException" ) throw new PdfReadError("encrypted", err.message);
      if ( err?.name === "InvalidPDFException" ) throw new PdfReadError("invalid", err.message);
      throw new PdfReadError("invalid", String(err?.message ?? err));
    }
    if ( maxPages && (doc.numPages > maxPages) ) {
      throw Object.assign(new PdfReadError("tooManyPages", `${doc.numPages} > ${maxPages}`), { data: { pages: doc.numPages, limit: maxPages } });
    }
    timings.open = performance.now() - t0;
    timings.pages = 0;
    timings.fonts = 0;
    const fontNames = {};
    const total = doc.numPages;
    // Pages are requested by batches: every call to the worker is a round trip that waits for the main thread,
    // so the requests of a batch overlap instead of queuing behind each frame
    for ( let first = 1; first <= total; first += PAGE_BATCH ) {
      if ( signal?.aborted ) throw abortError();
      const tp = performance.now();
      const numbers = [];
      for ( let n = first; n <= Math.min(total, first + PAGE_BATCH - 1); n++ ) numbers.push(n);
      const batch = await Promise.race([Promise.all(numbers.map(async number => {
        const page = await doc.getPage(number);
        return { number, page, content: await page.getTextContent() };
      })), aborted]);
      timings.pages += performance.now() - tp;
      for ( const { number, page, content } of batch ) {
        if ( signal?.aborted ) throw abortError();
        const text = content.items.map(it => it.str ?? "").join(" ").replace(/\s+/g, " ");
        const tf = performance.now();
        if ( isCandidatePage(text) ) await Promise.race([resolveFonts(page, content.items, fontNames), aborted]);
        timings.fonts += performance.now() - tf;
        const [x0, y0, x1, y1] = page.view;
        const model = toPageModel(content, { number, width: x1 - x0, height: y1 - y0 }, fontNames);
        page.cleanup();
        onPage?.(number, total);
        yield model;
      }
    }
  } finally {
    if ( onAbort ) signal?.removeEventListener("abort", onAbort);
    terminate();
    // Not awaited: the worker is already gone, pdf.js would wait for an answer that never comes
    task?.destroy().catch(() => {});
  }
}

/**
 * Read a whole PDF.
 * @param {Uint8Array} bytes
 * @param {{signal?: AbortSignal, onPage?: Function}} [opts]
 * @returns {Promise<{pages: object[], timings: {open: number, pages: number, fonts: number}}>}
 */
export async function readPdf(bytes, opts = {}) {
  const timings = {};
  const pages = [];
  for await ( const page of readPdfPages(bytes, { ...opts, timings }) ) pages.push(page);
  return { pages, timings };
}

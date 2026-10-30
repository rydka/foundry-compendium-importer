// Glue between the test documents (specs, PDFs), the pdf.js reader and the module's pure core.
// The only place that knows how `extractDocument` is called: adapt `runExtract` if its context changes.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as parser from "dnd5e-text-parser";
import { buildPdf, expectedOfDoc, loadDoc } from "./synth.mjs";
import { readPages } from "./pdfjs-node.mjs";
import { hasFoundryPdfjs } from "./fingerprint.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.join(HERE, "..", "fixtures", "pdf");
export const SYNTHETIC = path.join(FIXTURES, "synthetic");
export const BETTER_UNDEAD_PDF = path.join(HERE, "..", "..", "tools", "Better Undead Compendium.pdf");

export const hasBetterUndead = () => existsSync(BETTER_UNDEAD_PDF) && hasFoundryPdfjs();
export { hasFoundryPdfjs };

export const keys = parser.keysFromConfig(JSON.parse(readFileSync(path.join(FIXTURES, "dnd5e-keys.json"), "utf8")));
export { parser };

/** Loads every `*.json` document of a folder, sorted by name. */
export function loadDocs(dir = SYNTHETIC, filter = () => true) {
  return readdirSync(dir).filter((f) => f.endsWith(".json") && filter(f)).sort().map((f) => ({ file: f, doc: loadDoc(path.join(dir, f)) }));
}

/** Builds the PDF of a document and reads it back as page models (cached per document id and content). */
export async function pagesOfDoc(doc) {
  const bytes = await buildPdf(doc);
  const { pages } = await readPages(bytes, { key: `${doc.id}:${bytes.length}` });
  return { bytes, pages };
}

/** Calls the module's extractor on page models. */
export async function runExtract(pages, { fileName = "book.pdf", ...rest } = {}) {
  const { extractDocument } = await import("../../scripts/core/pdf/extract.mjs");
  return extractDocument(pages, { parser, keys, fileName, source: fileName, ...rest });
}

/** Expected creatures and items of a synthetic document. */
export const expectedOf = (doc) => expectedOfDoc(doc);

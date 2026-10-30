// pdf.js of Foundry (read-only, same build as at run time) in Node: bytes -> page models.
// Mirrors scripts/foundry/pdf-reader.mjs: getTextContent for every page, then getOperatorList (images skipped)
// only when a font identifier is not resolved yet, to learn the real font names (commonObjs).
import { readFileSync } from "node:fs";
import { PDFJS_BUILD } from "./fingerprint.mjs";
import { toPageModel } from "../../scripts/core/pdf/page-model.mjs";

let pdfjsPromise = null;
export const loadNodePdfjs = () => (pdfjsPromise ??= import(`file:///${PDFJS_BUILD}/pdf.mjs`));

const cache = new Map();

/**
 * @param {Uint8Array|Buffer|string} source  Bytes or a file path.
 * @param {{ key?: string, only?: number[], onPage?: Function }} [opts]  `key` caches the result; `only` limits the pages.
 * @returns {Promise<{ pages: object[], fontNames: Record<string,string>, ms: number }>}
 */
export async function readPages(source, { key, only, onPage } = {}) {
  if (key && cache.has(key)) return cache.get(key);
  const t0 = performance.now();
  const pdfjs = await loadNodePdfjs();
  const data = new Uint8Array(typeof source === "string" ? readFileSync(source) : source);
  const doc = await pdfjs.getDocument({
    data, verbosity: 0, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, maxImageSize: 0
  }).promise;
  const fontNames = {};
  const pages = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      if (only && !only.includes(n)) continue;
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const unresolved = content.items.some((i) => i.str.trim() && !(i.fontName in fontNames));
      if (unresolved) {
        await page.getOperatorList();
        for (const i of content.items) {
          if (i.fontName in fontNames) continue;
          if (page.commonObjs.has(i.fontName)) fontNames[i.fontName] = page.commonObjs.get(i.fontName).name;
        }
      }
      const view = page.getViewport({ scale: 1 });
      pages.push(toPageModel(content, { number: n, width: view.width, height: view.height }, fontNames));
      page.cleanup();
      onPage?.(n, doc.numPages);
    }
  } finally {
    await doc.destroy();
  }
  const out = { pages, fontNames, ms: performance.now() - t0 };
  if (key) cache.set(key, out);
  return out;
}

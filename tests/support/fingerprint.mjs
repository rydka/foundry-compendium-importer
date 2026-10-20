// Shared helpers of the tests: text fingerprints and the location of Foundry's pdf.js (read-only).
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";

/** pdf.js 4.0.379 shipped with Foundry (same build the module loads at run time). */
export const PDFJS_BUILD = "C:/Users/Shadow/AppData/Local/Programs/Foundry Virtual Tabletop/resources/app/node_modules/@foundryvtt/pdfjs/build";
export const hasFoundryPdfjs = () => existsSync(`${PDFJS_BUILD}/pdf.mjs`);

/** Removes tags (the `<small>Action</small>` header included), entities, spacing, punctuation, case. */
export function normalizeForFingerprint(text) {
  return String(text)
    .replace(/<small>.*?<\/small>/gis, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

export const sha1 = (s) => createHash("sha1").update(s).digest("hex");
export const fingerprintOf = (text) => { const n = normalizeForFingerprint(text); return { sha1: sha1(n), length: n.length }; };

/** True when `text` holds a passage that has the fingerprint (equal to the whole text or a window of it). */
export function containsFingerprint(text, fp) {
  const n = normalizeForFingerprint(text);
  if (n.length === fp.length) return sha1(n) === fp.sha1;
  for (let i = 0; i + fp.length <= n.length; i++) if (sha1(n.slice(i, i + fp.length)) === fp.sha1) return true;
  return false;
}

/** Sorted names of items, for count comparisons. */
export const names = (list) => list.map((x) => x.name);

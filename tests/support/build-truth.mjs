// Builds tests/fixtures/pdf/better-undead.truth.json from the hand-annotated values file and the local PDF.
//
//   node tests/support/build-truth.mjs [path-to-pdf]
//
// The values (stats, names, sections) are typed by hand in better-undead.values.json. This script only adds a
// fingerprint to each entry (and to the first paragraph of each magic item): the sha-1 of the normalised text
// and its length. No text of the book is written. It reads the PDF with the pdf.js served by Foundry (same
// version as at run time), from the printed layout alone, and does NOT use the module code or tools/out.
//
// Entry boundaries come from the fonts: an entry starts on a line whose first run is bold italic, and the
// start is accepted only if it matches the next annotated name (so a stray bold italic word at the start of
// a continuation line is not mistaken for an entry).
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFJS_BUILD, normalizeForFingerprint } from "./fingerprint.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, "..", "fixtures", "pdf");
const PDF = process.argv[2] ?? path.join(HERE, "..", "..", "tools", "Better Undead Compendium.pdf");

const pdfjs = await import(`file:///${PDFJS_BUILD}/pdf.mjs`);
const doc = await pdfjs.getDocument({
  data: new Uint8Array(readFileSync(PDF)), verbosity: 0, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, maxImageSize: 0
}).promise;

const sha1 = (s) => createHash("sha1").update(s).digest("hex");
const fingerprint = (text) => { const n = normalizeForFingerprint(text); return { sha1: sha1(n), length: n.length }; };

/** Lines of a page in reading order (left column, then right), with the font of the first run. */
async function pageLines(number) {
  const page = await doc.getPage(number);
  const content = await page.getTextContent();
  await page.getOperatorList();
  const width = page.getViewport({ scale: 1 }).width;
  const runs = content.items
    .filter((i) => i.str.trim())
    .map((i) => ({ s: i.str, x: i.transform[4], y: i.transform[5], h: Math.round(i.height * 10) / 10, font: page.commonObjs.has(i.fontName) ? page.commonObjs.get(i.fontName).name : "?" }));
  const lines = [];
  for (const col of [0, 1]) {
    const inCol = runs.filter((r) => (r.x >= width / 2) === (col === 1));
    const rows = new Map();
    for (const r of inCol) {
      const key = Math.round(r.y / 3);
      if (!rows.has(key)) rows.set(key, []);
      rows.get(key).push(r);
    }
    for (const key of [...rows.keys()].sort((a, b) => b - a)) {
      const g = rows.get(key).sort((a, b) => a.x - b.x);
      lines.push({ col, h: g[0].h, font: g[0].font, text: g.map((r) => r.s).join(" ").replace(/\s+/g, " ").trim(), first: g[0].s.trim() });
    }
  }
  return lines;
}

// Running heads, drop-cap quotes, page numbers: not part of any block.
const isNoise = (l) => [7.5, 8.2, 11.2].includes(l.h) || (l.h === 12 && /^\d+( \d+)*$/.test(l.text));
const norm = (s) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const SECTION = { actions: "action", "bonus actions": "bonus", "bonus action": "bonus", reactions: "reaction", "legendary actions": "legendary" };

function readCreature(lines, c) {
  const titleIdx = lines.findIndex((l) => l.text === c.name && l.h >= 17);
  if (titleIdx < 0) throw new Error(`${c.name}: title not found on page ${c.page}`);
  const chIdx = lines.findIndex((l, i) => i > titleIdx && /^Challenge /.test(l.text));
  if (chIdx < 0) throw new Error(`${c.name}: Challenge line not found`);
  const expected = c.entries.map(([section, name]) => ({ section, name, text: "" , done: false }));
  const extras = [];
  let section = "trait";
  let cur = null;
  let next = 0;
  for (let i = chIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (isNoise(l)) continue;
    if (l.h === 12.7) {
      const key = SECTION[l.text.toLowerCase()];
      if (key) { section = key; cur = null; continue; }
      section = "block"; cur = { section: "spellcasting-block", name: l.text, text: "" }; extras.push(cur); continue;
    }
    if (l.h !== 9) break; // lore text, notes, next title...
    const want = expected[next];
    const startsEntry = /BoldItalic/.test(l.font) && want && want.section === section && norm(l.text).startsWith(norm(want.name));
    if (startsEntry) { cur = want; cur.text = l.text; next++; continue; }
    if (/BoldItalic/.test(l.font) && /^[A-Z][^.]{2,40}.( |$)/.test(l.text)) console.warn(`  note: bold italic line start not annotated as an entry: "${l.text.slice(0, 40)}" (${c.name})`);
    if (cur) cur.text += " " + l.text;
  }
  if (next !== expected.length && process.env.DEBUG_TRUTH) {
    console.log(lines.map((l) => `${l.col} ${l.h} ${l.font.slice(-18)} ${l.text.slice(0, 50)}`).join("\n"));
  }
  if (next !== expected.length) throw new Error(`${c.name}: matched ${next}/${expected.length} entries (stopped before "${expected[next]?.name}")`);
  return { entries: expected, extras };
}

const values = JSON.parse(readFileSync(path.join(FIX, "better-undead.values.json"), "utf8"));
const truth = { source: values.source, creatures: [], items: [] };

for (const c of values.creatures) {
  const lines = await pageLines(c.page);
  const { entries, extras } = readCreature(lines, c);
  const counts = { trait: 0, action: 0, bonus: 0, reaction: 0, legendary: 0 };
  for (const e of entries) counts[e.section]++;
  const out = { ...c, entries: entries.map((e) => ({ name: e.name, section: e.section, ...fingerprint(e.text) })), counts };
  if (extras.length) out.extras = extras.map((e) => ({ name: e.name, section: e.section, ...fingerprint(e.text) }));
  truth.creatures.push(out);
}

for (const it of values.items) {
  const lines = await pageLines(it.page);
  const head = lines.findIndex((l) => /^Wondrous Item/.test(l.text));
  let intro = "";
  for (let i = head + 1; i < lines.length; i++) { if (lines[i].h !== 9.6) break; intro += " " + lines[i].text; }
  // first paragraph: until the first heading-sized line (h13) after the header, which starts the first spell
  truth.items.push({ ...it, headerLine: lines[head].text.replace(/\s+/g, " "), intro: fingerprint(intro) });
}

writeFileSync(path.join(FIX, "better-undead.truth.json"), JSON.stringify(truth, null, 1) + "\n");
console.log(`truth: ${truth.creatures.length} creatures, ${truth.creatures.reduce((n, c) => n + c.entries.length, 0)} entries, ${truth.items.length} items`);

// Metrics M2 (creatures extracted / present), M3 (field accuracy) and M4 (magic item accuracy) of the PDF import.
// MEASURES AND REPORTS; never fails. Not part of `npm test`.
//
//   node tests/metrics/pdf-extraction.mjs [--control=<folder of synthetic documents>] [--out=<folder>]
//
// Sets: Better Undead (real book, truth annotated by hand), the synthetic reference set (tests/fixtures/pdf/synthetic,
// visible to the developers) and, when --control is given, a control set of the same kind that the developers have
// not seen. The control set is what counts for the generalisation; the two values are reported side by side.
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { BETTER_UNDEAD_PDF, FIXTURES, hasBetterUndead, hasFoundryPdfjs, loadDocs, pagesOfDoc, runExtract } from "../support/pdf-env.mjs";
import { readPages } from "../support/pdfjs-node.mjs";
import { expectedOf } from "../support/pdf-env.mjs";
import {
  CREATURE_FIELDS, ITEM_FIELDS, aggregate, commonFromSpec, commonFromTruth, pairByName, readActor, readItem, scoreCreature, scoreItem
} from "../support/score.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const outDir = args.out ?? null;

function measure(label, result, wantCreatures, wantItems) {
  const gotActors = result.actors.map(readActor);
  const pairs = pairByName(gotActors, wantCreatures.map((c) => c.common));
  const found = pairs.filter((p) => p.got).length;
  const scores = pairs.map((p) => scoreCreature(p.got, p.want));
  const m3 = aggregate(scores, CREATURE_FIELDS);
  const itemPairs = pairByName(result.items.map(readItem), wantItems);
  const m4 = aggregate(itemPairs.map((p) => scoreItem(p.got, p.want)), ITEM_FIELDS);
  const wrongFields = [];
  pairs.forEach((p, i) => { for (const f of CREATURE_FIELDS) if (!scores[i][f]) wrongFields.push(`${p.want.name}: ${f}`); });
  const wrongItems = [];
  itemPairs.forEach((p) => { const s = scoreItem(p.got, p.want); for (const f of ITEM_FIELDS) if (!s[f]) wrongItems.push(`${p.want.name}: ${f}`); });
  return {
    label,
    m2: { extracted: found, present: wantCreatures.length, spurious: gotActors.length - found, ratio: wantCreatures.length ? found / wantCreatures.length : null },
    m3: { ok: m3.ok, total: m3.total, ratio: m3.ratio, byField: m3.byField, wrong: wrongFields },
    m4: { ok: m4.ok, total: m4.total, ratio: m4.total ? m4.ratio : null, byField: m4.byField, wrong: wrongItems, itemsFound: itemPairs.filter((p) => p.got).length, itemsPresent: wantItems.length, spuriousItems: result.items.length - itemPairs.filter((p) => p.got).length },
    problems: result.problems.length
  };
}

async function syntheticSet(label, dir, filter) {
  const docs = loadDocs(dir, filter);
  const wantC = [];
  const wantI = [];
  const merged = { actors: [], items: [], problems: [] };
  for (const { doc } of docs) {
    const exp = expectedOf(doc);
    wantC.push(...exp.creatures.map((c) => ({ common: commonFromSpec(c) })));
    wantI.push(...exp.items);
    const { pages } = await pagesOfDoc(doc);
    const r = await runExtract(pages, { fileName: `${doc.id}.pdf` });
    merged.actors.push(...r.actors); merged.items.push(...r.items); merged.problems.push(...r.problems);
  }
  return measure(label, merged, wantC, wantI);
}

const results = [];
if (!hasFoundryPdfjs()) {
  console.log("pdf.js of Foundry not found: nothing measured");
  process.exit(0);
}
if (hasBetterUndead()) {
  const truth = JSON.parse(readFileSync(path.join(FIXTURES, "better-undead.truth.json"), "utf8"));
  const { pages } = await readPages(BETTER_UNDEAD_PDF);
  const r = await runExtract(pages, { fileName: "Better Undead Compendium.pdf" });
  results.push(measure("Better Undead (real book)", r, truth.creatures.map((c) => ({ common: commonFromTruth(c) })), truth.items.map((i) => ({ name: i.name, docType: "equipment", typeValue: "wondrous", rarity: i.rarity, attunement: i.attunement }))));
} else {
  console.log("Better Undead Compendium.pdf not found: skipped");
}
results.push(await syntheticSet("Synthetic reference set", path.join(FIXTURES, "synthetic"), (f) => f.startsWith("ref-") && !/scanned|partial|unreadable/.test(f)));
if (args.control) results.push(await syntheticSet("Synthetic control set (unseen by the developers)", path.resolve(args.control), () => true));

const pct = (x) => (x === null ? "n/a" : `${(x * 100).toFixed(1)} %`);
const lines = ["| Set | M2 creatures | M3 fields | M4 items |", "|---|---|---|---|"];
for (const r of results) {
  lines.push(`| ${r.label} | ${r.m2.extracted}/${r.m2.present} (${pct(r.m2.ratio)}), ${r.m2.spurious} spurious | ${r.m3.ok}/${r.m3.total} (${pct(r.m3.ratio)}) | ${r.m4.ok}/${r.m4.total} (${pct(r.m4.ratio)}) |`);
}
for (const r of results) {
  if (r.m3.wrong.length) lines.push("", `Wrong creature fields, ${r.label}:`, ...r.m3.wrong.map((w) => `- ${w}`));
  if (r.m4.wrong.length) lines.push("", `Wrong item fields, ${r.label}:`, ...r.m4.wrong.map((w) => `- ${w}`));
}
console.log(lines.join("\n"));
if (outDir) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "pdf-extraction.json"), JSON.stringify(results, null, 2));
  writeFileSync(path.join(outDir, "pdf-extraction.md"), lines.join("\n") + "\n");
}

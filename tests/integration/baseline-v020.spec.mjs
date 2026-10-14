// T0 / C1 / C16: with enrichment off (default, or enrich: false) api.analyze behaves like v0.2.0.
// The snapshot tests/fixtures/baseline-v0.2.0.json was recorded on the unmodified 0.2.0 code:
//   CJI_BASELINE=write node test-env/run.mjs compendium-json-importer --files=baseline-v020
// Normal runs only compare against it.
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { expect, test } from "../../../../test-env/fixtures.mjs";
import { BASELINE_FILES, BASELINE_PATH, digest, readSource } from "../support/baseline.mjs";
import { evidence } from "./helpers.mjs";

async function clientAnalyze({ text, fileName, documentName, options }) {
  const { parseImportFile } = await import("/modules/compendium-json-importer/scripts/core/parse.mjs");
  const api = game.modules.get("compendium-json-importer").api;
  let n = 0;
  const idGen = () => `ID${String(++n).padStart(14, "0")}`;
  const migrationData = await dnd5e.migrations.getMigrationData();
  const { entries } = parseImportFile(text, fileName);
  const result = await api.analyze(entries, documentName, { migrationData, idGen, ...options });
  return {
    documentName: result.documentName,
    accepted: result.accepted,
    rejected: result.rejected.map((r) => ({ name: r.name, type: r.type, reasons: r.reasons })),
    other: result.other
  };
}

const writing = process.env.CJI_BASELINE === "write";

async function snapshot(foundry, options) {
  const out = {};
  for (const [id, rel, documentName] of BASELINE_FILES) {
    const result = await foundry(clientAnalyze, { text: readSource(rel), fileName: rel.split("/").pop(), documentName, options });
    out[id] = digest(result);
  }
  return out;
}

if (writing) {
  test("T0: record the v0.2.0 baseline", async ({ foundry }) => {
    const files = await snapshot(foundry, {});
    writeFileSync(BASELINE_PATH, JSON.stringify({ recordedWith: "compendium-json-importer 0.2.0 (before activity-enrichment)", files }, null, 1));
  });
} else {
  const baseline = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")) : null;
  for (const [label, options] of [["C1: option absent", {}], ["C1/C16: enrich: false", { enrich: false }]]) {
    test(`${label}: analysis equals the v0.2.0 snapshot`, async ({ foundry }) => {
      expect(baseline, "baseline snapshot missing").not.toBeNull();
      const now = await snapshot(foundry, options);
      const diffs = [];
      for (const id of Object.keys(baseline.files)) {
        const a = baseline.files[id], b = now[id];
        if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push(id);
      }
      evidence(`C1-baseline-${options.enrich === false ? "enrich-false" : "default"}.json`, {
        compared: Object.keys(baseline.files).length, differing: diffs,
        accepted: Object.fromEntries(Object.entries(now).map(([k, v]) => [k, v.accepted.length]))
      });
      expect(diffs).toEqual([]);
    });
  }
}

// Replay of the reference set (and of the hold-out control set when it is committed) of the text-parser library
// through api.analyze in a real Foundry: C4-C13 per formulation, M2 (recall) and M3 (precision).
// The reference set was seen by the developers; the control set was not: the control values make the metric.
// M2/M3 are measured and recorded, never asserted. The formulation criteria are asserted on the tagged cases.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { expect, test } from "../../../../test-env/fixtures.mjs";
import { evidence } from "./helpers.mjs";
import { LIB, buildFeature, idMaker, loadSet, normRange, scoreActors, scoreFeatures } from "../support/replay.mjs";
import { compare, expectedFeatureTokens, filterTokens } from "../../../dnd5e-text-parser/tests/support/canon.mjs";
import { itemTokens, minus } from "../support/canon.mjs";

test.describe.configure({ timeout: 300_000 });

/** Runs inside Foundry. */
async function clientAnalyze({ entries, documentName, options }) {
  const api = game.modules.get("compendium-json-importer").api;
  let n = 0;
  const idGen = () => `GEN${String(++n).padStart(13, "0")}`;
  const migrationData = await dnd5e.migrations.getMigrationData();
  const r = await api.analyze(entries, documentName, { migrationData, idGen, ...options });
  return {
    counts: r.enrichment?.counts, unavailable: r.enrichment?.unavailable,
    rejected: r.rejected.map((x) => ({ name: x.name, reasons: x.reasons.map((q) => q.key) })),
    accepted: r.accepted.map((a) => ({ data: a.data, enrichment: a.enrichment }))
  };
}

const gitHead = (dir) => {
  try { return execFileSync("git", ["-C", dir, "log", "-1", "--format=%h"], { encoding: "utf8" }).trim(); } catch { return "?"; }
};

async function replay(foundry, setDir) {
  const set = loadSet(setDir);
  const newId = idMaker(setDir === "control" ? 99 : 7);
  const inputs = new Map();
  const entries = set.features.map((c) => {
    const item = buildFeature(c, set.real, newId);
    inputs.set(c.id, item);
    return JSON.parse(JSON.stringify(item));
  });
  const feat = await foundry(clientAnalyze, { entries, documentName: "Item", options: { enrich: true } });
  const byId = new Map(feat.accepted.map((a) => [a.data._id, a]));
  const out = new Map(set.features.map((c) => {
    const input = inputs.get(c.id);
    return [c.id, { input, output: byId.get(input._id)?.data ?? null, enrichment: byId.get(input._id)?.enrichment }];
  }));
  const actorOut = new Map();
  if (set.actors.length) {
    const cleaned = set.actors.map((c) => ({
      ...JSON.parse(JSON.stringify(c.actor)), _id: newId(),
      items: (c.actor.items ?? []).map((it) => ({ ...it, _id: newId() }))
    }));
    const res = await foundry(clientAnalyze, { entries: cleaned, documentName: "Actor", options: { enrich: true, compendiums: false } });
    const byActor = new Map(res.accepted.map((a) => [a.data._id, a]));
    set.actors.forEach((c, i) => actorOut.set(c.id, {
      input: cleaned[i], output: byActor.get(cleaned[i]._id)?.data ?? null, enrichment: byActor.get(cleaned[i]._id)?.enrichment
    }));
  }
  return { set, out, actorOut, feat };
}

for (const label of ["reference", "control"]) {
  test(`M2/M3 (${label} set): replay through api.analyze, recorded`, async ({ foundry }) => {
    const root = path.join(LIB, "tests/fixtures", label);
    test.skip(!existsSync(root), `${label} set not committed in the library`);
    const { set, out, actorOut, feat } = await replay(foundry, label);
    const features = scoreFeatures(set.features, out);
    const actors = scoreActors(set.actors, actorOut);
    evidence(`M2-M3-${label}-lib-${gitHead(LIB)}.json`, {
      set: label, libraryCommit: gitHead(LIB), cases: set.features.length, actorCases: set.actors.length,
      rejectedByImporter: feat.rejected, counts: feat.counts, features, actors
    });
    test.info().annotations.push({
      type: `M2/M3 ${label}`,
      description: ["en", "fr"].map((l) => `${l}: recall ${features[l].recallPct} % precision ${features[l].precisionPct} % critical ${features[l].criticalErrors}`).join(" | ")
    });
    expect(feat.rejected, "no document rejected because of the enrichment (C2)").toEqual([]);
  });
}

// ---- criteria by formulation (reference set: the cases tagged C5..C12)
const CRITERIA = {
  C5: { tags: ["C5"], tokens: /^attack=/ },
  C6: { tags: ["C6"], tokens: /^(range|target)=/ },
  C7: { tags: ["C7"], tokens: /^damage=/ },
  C8: { tags: ["C8"], tokens: /^(save|saveDamage|template)=/ },
  C9: { tags: ["C9"], tokens: /^(uses|recharge)=/ },
  C10: { tags: ["C10"], tokens: /^activation=/ },
  C12: { tags: ["C12"], tokens: /^legendaryResistance=/ }
};

for (const [criterion, { tags, tokens }] of Object.entries(CRITERIA)) {
  test(`${criterion}: every tagged formulation (EN and FR) gives the expected facts`, async ({ foundry }) => {
    const { set, out } = await replay(foundry, "reference");
    const cases = set.features.filter((c) => c.tags?.some((t) => tags.includes(t)) && !c.onlySkip);
    expect(cases.length).toBeGreaterThan(0);
    const rows = [];
    for (const c of cases) {
      const o = out.get(c.id);
      const before = itemTokens(o.input).map(normRange);
      const expected = minus(expectedFeatureTokens(c).map(normRange), before).filter((x) => tokens.test(x));
      const produced = minus(o.output ? filterTokens(itemTokens(o.output), c).map(normRange) : [], before).filter((x) => tokens.test(x));
      const r = compare(expected, produced);
      const ok = !r.missing.length && !r.wrong.length;
      rows.push({
        id: c.id, lang: c.lang, ok, missing: r.missing, wrong: r.wrong,
        ...(ok ? {} : { debug: { identifier: o.output?.system?.identifier, uses: o.output?.system?.uses, activities: Object.values(o.output?.system?.activities ?? {}).map((a) => ({ type: a.type, activation: a.activation, consumption: a.consumption?.targets })) } })
      });
    }
    evidence(`${criterion}-formulations.json`, { cases: rows.length, ok: rows.filter((r) => r.ok).length, rows });
    const bad = rows.filter((r) => !r.ok);
    expect(bad, JSON.stringify(bad.slice(0, 5))).toEqual([]);
  });
}

test("C4: texts without a recognized formulation, and ambiguous ones, leave the document as it is", async ({ foundry }) => {
  const { set, out } = await replay(foundry, "reference");
  const cases = set.features.filter((c) => c.tags?.includes("negative") || c.expectAmbiguous);
  expect(cases.length).toBeGreaterThan(5);
  const rows = cases.map((c) => {
    const o = out.get(c.id);
    const before = itemTokens(o.input);
    const added = minus(o.output ? itemTokens(o.output) : [], before).filter((x) => /^(attack|save|saveDamage|damage|template|uses|recharge)=/.test(x));
    return { id: c.id, added, status: o.enrichment?.status ?? "none", expected: c.expected };
  });
  evidence("C4-sans-formulation.json", rows);
  const filled = (e) => Object.entries(e ?? {}).some(([k, v]) => k !== "skip" && v != null && (!Array.isArray(v) || v.length));
  const unfair = rows.filter((r) => r.added.length && !filled(r.expected));
  expect(unfair).toEqual([]);
  expect(rows.some((r) => r.status === "notEnriched" || r.status === "unchanged")).toBe(true);
});

test("C11/C12/C13: legendary counters and trait lines of the actors of the reference set (EN and FR)", async ({ foundry }) => {
  const { set, actorOut } = await replay(foundry, "reference");
  const actors = scoreActors(set.actors, actorOut);
  evidence("C11-C13-acteurs.json", actors);
  expect(actors.all.cases).toBeGreaterThan(5);
  expect(actors.all.missing, actors.all.missing.join("\n")).toEqual([]);
  expect(actors.all.wrong, actors.all.wrong.join("\n")).toEqual([]);
});

/* global Actor */
// C25 (challenge rating), C26 (passive effects applied by dnd5e, "Effect added" and "Not automated" in the summary),
// C27 (no double effect, an idempotent re-import) on the real Death Knight of tools/out and on a synthetic actor.
import { readFileSync } from "node:fs";
import { expect, test } from "../../../../test-env/fixtures.mjs";
import { evidence } from "./helpers.mjs";

test.describe.configure({ timeout: 180_000 });

const actors = () => JSON.parse(readFileSync(new URL("../../tools/out/actors.json", import.meta.url), "utf8"));

/** Runs inside Foundry: analysis, summary view, then the created actor (rolled back at the end). */
async function run({ entry, again }) {
  const api = game.modules.get("compendium-json-importer").api;
  const { describeReport } = await import("/modules/compendium-json-importer/scripts/foundry/enrich-summary.mjs");
  const analyze = async (e) => {
    const r = await api.analyze([e], "Actor", { enrich: true, compendiums: false });
    if (!r.accepted.length) return { rejected: r.rejected.map((x) => ({ name: x.name, reasons: x.reasons.map((q) => q.key) })) };
    const acc = r.accepted[0];
    return { data: acc.data, view: describeReport(acc.enrichment) };
  };
  const first = await analyze(entry);
  if (!first.data) return { rejected: first.rejected };
  const res = {
    cr: first.data.system?.details?.cr,
    lines: first.view.lines, notAutomated: first.view.notAutomated,
    effectsByItem: Object.fromEntries(first.data.items.map((i) => [i.name, (i.effects ?? []).map((e) => ({ name: e.name, transfer: e.transfer, changes: (e.changes ?? []).map((c) => `${c.key}|${c.mode}|${c.value}`) }))]))
  };
  const copy = JSON.parse(JSON.stringify(first.data));
  delete copy._id;
  const actor = await Actor.create(copy, { keepId: false });
  try {
    res.created = {
      cr: actor.system.details.cr,
      dm: JSON.parse(JSON.stringify(actor.system.traits.dm?.amount ?? {})),
      effects: actor.items.map((i) => [i.name, i.effects.size])
    };
    if (again) {
      // re-import: the stored actor goes through the importer again
      const stored = actor.toObject();
      stored._id = "REIMPORT00000001";
      const second = await analyze(stored);
      res.second = {
        rejected: second.rejected ?? [],
        lines: second.view?.lines ?? [],
        effectCounts: Object.fromEntries((second.data?.items ?? []).map((i) => [i.name, (i.effects ?? []).length])),
        storedCounts: Object.fromEntries(actor.items.map((i) => [i.name, i.effects.size])),
        cr: second.data?.system?.details?.cr
      };
    }
    return res;
  } finally { await actor.delete(); }
}

test("C25/C26/C27: the real Death Knight has CR 18, an effect on Heavy Armor Master applied by dnd5e, Magic Resistance not automated, and re-imports unchanged", async ({ foundry }) => {
  const dk = actors().find((a) => a.name === "Death Knight");
  expect(dk).toBeTruthy();
  const out = await foundry(run, { entry: dk, again: true });
  evidence("C25-C26-C27-death-knight.json", out);
  expect(out.rejected).toBeUndefined();
  // C25
  expect(out.cr).toBe(18);
  expect(out.created.cr).toBe(18);
  // C26: the effect is on the feature and dnd5e applies it to the actor
  const hm = out.effectsByItem["Heavy Armor Master"];
  expect(hm.length, JSON.stringify(out.effectsByItem)).toBe(1);
  expect(hm[0].transfer).toBe(true);
  for (const type of ["bludgeoning", "piercing", "slashing"]) {
    expect(Math.abs(Number(out.created.dm[type])), `traits.dm.amount.${type}`).toBe(3);
  }
  expect(out.lines.join("\n")).toMatch(/Effect added: Heavy Armor Master|Effet ajouté : Heavy Armor Master/i);
  expect(out.lines.join("\n")).not.toMatch(/dnd5e-text-parser\.|compendium-json-importer\./);
  // what dnd5e cannot express is listed, not invented
  expect(out.notAutomated.some((l) => l.startsWith("Magic Resistance")), JSON.stringify(out.notAutomated)).toBe(true);
  expect(out.effectsByItem["Magic Resistance"]).toEqual([]);
  // C27: the re-import neither doubles nor re-announces the effect, nor changes the cr
  expect(out.second.rejected).toEqual([]);
  expect(out.second.effectCounts["Heavy Armor Master"]).toBe(1);
  expect(out.second.storedCounts["Heavy Armor Master"]).toBe(1);
  expect(out.second.lines.join("\n")).not.toMatch(/Effect added|Effet ajouté/i);
  expect(out.second.cr).toBe(18);
});

test("C25: an actor without a CR in the file takes the one of its text (Challenge 5), and a filled CR stays", async ({ foundry }) => {
  const make = (id, name, system) => ({
    _id: id, name, type: "npc", system,
    items: [{ _id: `${id}ITEM`.padEnd(16, "0").slice(0, 16), name: "Statistics", type: "feat", system: { description: { value: "<p>Challenge 5 (1,800 XP)</p>" }, activities: {} } }]
  });
  const without = await foundry(run, { entry: make("C25NOCR000000001", "C25 Without Cr", {}) });
  const filled = await foundry(run, { entry: make("C25FILLED0000001", "C25 With Cr", { details: { cr: 2 } }) });
  evidence("C25-fp-depuis-le-texte.json", { without, filled });
  expect(without.cr).toBe(5);
  expect(without.created.cr).toBe(5);
  expect(without.lines.join("\n")).toMatch(/Challenge rating filled in: 5|(FP|Facteur de puissance).*5/i);
  expect(filled.cr).toBe(2);
  expect(filled.created.cr).toBe(2);
});

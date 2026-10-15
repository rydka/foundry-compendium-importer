/* global Actor */
// B10: a conditional / alternative result of the text becomes an added activity (never a second damage part),
// also when the existing activity is already filled (C3: nothing of it is modified) and when the feature is taken from a
// compendium (the compendium activity is adjusted, then the variant is added). No duplicate when an equivalent activity exists.
import { expect, test } from "../../../../test-env/fixtures.mjs";
import { evidence } from "./helpers.mjs";

test.describe.configure({ timeout: 240_000 });

const BLOODIED = "9 (2d8) piercing damage, or 11 (2d8 + 2) piercing damage if the target is Bloodied";
const text = (name, extra = "") => `<p><small>Action</small><br/><strong>${name}${extra}.</strong> <em>Melee Attack Roll:</em> +6, reach 5 ft. <em>Hit:</em> ${BLOODIED}.</p>`;
const NOTE_RE = /activity added|activit[ée] ajout[ée]e?/i;

const filledAttack = (id, extra = {}) => ({
  _id: id, type: "attack", name: "", activation: { type: "action", value: 1, condition: "" },
  attack: { bonus: "9", flat: true, type: { value: "melee", classification: "weapon" } },
  damage: { includeBase: false, parts: [{ number: 3, denomination: 6, bonus: "1", types: ["fire"] }] },
  consumption: { targets: [{ type: "itemUses", target: "", value: "1", scaling: {} }], scaling: { allowed: false, max: "" } },
  ...extra
});

/** Runs inside Foundry: analysis, then what the summary says, then the activities of the created actor. */
async function analyze({ actor, compendiums }) {
  const api = game.modules.get("compendium-json-importer").api;
  const { describeReport } = await import("/modules/compendium-json-importer/scripts/foundry/enrich-summary.mjs");
  const r = await api.analyze([actor], "Actor", { enrich: true, compendiums });
  const res = { rejected: r.rejected.map((x) => ({ name: x.name, reasons: x.reasons.map((q) => q.key) })) };
  if (!r.accepted.length) return res;
  const acc = r.accepted[0];
  const view = describeReport(acc.enrichment);
  res.summary = { lines: view.lines, compendium: view.compendium };
  res.origins = Object.fromEntries((acc.enrichment.items ?? []).map((e) => [e.name, e.origin]));
  const dump = (data) => Object.fromEntries((data.items ?? []).map((it) => [it.name, Object.values(it.system?.activities ?? {}).map((a) => JSON.parse(JSON.stringify(a)))]));
  res.activities = dump(acc.data);
  const copy = JSON.parse(JSON.stringify(acc.data));
  delete copy._id;
  const created = await Actor.create(copy, { keepId: false });
  try {
    res.created = Object.fromEntries(created.items.map((i) => [i.name, i.system.activities.map((a) => ({
      type: a.type, name: a.name, bonus: a.attack?.bonus ?? null,
      parts: (a.damage?.parts ?? []).map((p) => `${p.number}d${p.denomination}+${p.bonus || 0} ${[...(p.types ?? [])].join("/")}`),
      consumption: (a.consumption?.targets ?? []).map((t) => `${t.type}:${t.value}`)
    }))]));
  } finally { await created.delete(); }
  return res;
}

const npc = (id, name, items) => ({ _id: id, name, type: "npc", system: { details: { cr: 3 } }, items });
const feature = (id, name, html, activities, uses) => ({ _id: id, name, type: "feat", system: { description: { value: html }, activities, ...(uses ? { uses } : {}) } });
const USES = { max: "3", spent: 0, recovery: [{ period: "day", type: "recoverAll" }] };

test("B10 (1): a filled attack is unchanged and the variant is added with the same consumption; the summary says it", async ({ foundry }) => {
  const input = filledAttack("B10ACTFILLED0001");
  const actor = npc("B10ACTOR00000001", "B10 Filled Beast", [feature("B10ITEMFILLED001", "Gore Filled (3/Day)", text("Gore Filled", " (3/Day)"), { [input._id]: input }, USES)]);
  const out = await foundry(analyze, { actor, compendiums: false });
  evidence("B10-1-attaque-remplie.json", out);
  expect(out.rejected).toEqual([]);
  const acts = out.activities["Gore Filled (3/Day)"];
  expect(acts.length, JSON.stringify(out.created)).toBe(2);
  // C3: the filled activity is the same data as in the file
  const kept = acts.find((a) => a._id === input._id);
  expect(kept.attack.bonus).toBe("9");
  expect(kept.damage.parts).toEqual(input.damage.parts);
  expect(kept.consumption.targets[0].type).toBe("itemUses");
  // the variant
  const added = acts.find((a) => a._id !== input._id);
  expect(added.type).toBe("attack");
  expect(added.name).toMatch(/bloodied/i);
  expect(added.damage.parts.length).toBe(1);
  expect(`${added.damage.parts[0].number}d${added.damage.parts[0].denomination}+${added.damage.parts[0].bonus}`).toBe("2d8+2");
  expect(added.damage.parts[0].types).toEqual(["piercing"]);
  expect(added.consumption.targets.map((t) => t.type)).toEqual(["itemUses"]);
  // summary line
  expect(out.summary.lines.join("\n")).toMatch(NOTE_RE);
  expect(out.summary.lines.join("\n")).toMatch(/bloodied/i);
  expect(out.summary.lines.join("\n")).not.toMatch(/dnd5e-text-parser\.|compendium-json-importer\./);
});

test("B10 (2): a feature taken from a compendium is adjusted, then the variant is added", async ({ foundry }) => {
  // a real monster feature of the dnd5e packs with exactly one attack activity and one damage part (found, not assumed)
  const pick = await foundry(async () => {
    const pack = game.packs.get("dnd5e.monsterfeatures24");
    const docs = await pack.getDocuments({ type: "feat" });
    const names = new Map();
    for (const d of docs) names.set(d.name, (names.get(d.name) ?? 0) + 1);
    const hit = docs.find((d) => names.get(d.name) === 1 && d.system.activities.size === 1
      && d.system.activities.contents[0].type === "attack" && d.system.activities.contents[0].damage?.parts?.length === 1
      && !/[()]/.test(d.name));
    return hit ? { name: hit.name, bonus: hit.system.activities.contents[0].attack.bonus } : null;
  });
  expect(pick, "a single-attack feature exists in dnd5e.monsterfeatures24").not.toBeNull();
  const empty = { B10ACTCOMP000001: { _id: "B10ACTCOMP000001", type: "utility", name: "", activation: { type: "action", value: 1, condition: "" } } };
  const actor = npc("B10ACTORCOMP0001", "B10 Compendium Beast", [feature("B10ITEMCOMP00001", pick.name, text(pick.name), empty)]);
  const out = await foundry(analyze, { actor, compendiums: true });
  evidence("B10-2-compendium.json", { pick, ...out });
  expect(out.rejected).toEqual([]);
  expect(out.origins[pick.name], "the feature is taken from the compendium").toBe("compendium");
  const acts = out.activities[pick.name];
  expect(acts.length, JSON.stringify(out.created)).toBe(2);
  const attacks = acts.filter((a) => a.type === "attack");
  expect(attacks.length).toBe(2);
  // the compendium activity is adjusted to the text (+6, 2d8), the variant carries 2d8+2 and the condition
  const main = attacks.find((a) => !/bloodied/i.test(a.name ?? ""));
  const variant = attacks.find((a) => /bloodied/i.test(a.name ?? ""));
  expect(variant, "a variant named after its condition").toBeTruthy();
  expect(String(main.attack.bonus)).toBe("6");
  expect(main.damage.parts.length).toBe(1);
  expect(`${main.damage.parts[0].number}d${main.damage.parts[0].denomination}`).toBe("2d8");
  expect(variant.damage.parts.length).toBe(1);
  expect(`${variant.damage.parts[0].number}d${variant.damage.parts[0].denomination}+${variant.damage.parts[0].bonus}`).toBe("2d8+2");
  expect(out.summary.compendium.map((c) => c.name)).toContain(pick.name);
  expect(JSON.stringify(out.summary)).toMatch(NOTE_RE);
});

test("B10 (3): an equivalent activity already present is not duplicated, and analysing the result again adds nothing", async ({ foundry }) => {
  const main = filledAttack("B10ACTMAIN000001");
  const variant = filledAttack("B10ACTVARIANT001", {
    name: "Gore Twin (if the target is Bloodied)",
    damage: { includeBase: false, parts: [{ number: 2, denomination: 8, bonus: "2", types: ["piercing"] }] }
  });
  const actor = npc("B10ACTORTWIN0001", "B10 Twin Beast", [feature("B10ITEMTWIN00001", "Gore Twin (3/Day)", text("Gore Twin", " (3/Day)"), { [main._id]: main, [variant._id]: variant }, USES)]);
  const first = await foundry(analyze, { actor, compendiums: false });
  evidence("B10-3-pas-de-doublon.json", first);
  expect(first.rejected).toEqual([]);
  expect(first.activities["Gore Twin (3/Day)"].length, "same condition and same damage: no duplicate").toBe(2);
  expect(first.summary.lines.join("\n")).not.toMatch(NOTE_RE);
  // idempotence: a variant added on the first import is not added again on the second
  const alone = npc("B10ACTORIDEM0001", "B10 Idem Beast", [feature("B10ITEMIDEM00001", "Gore Idem (3/Day)", text("Gore Idem", " (3/Day)"), { B10ACTIDEM000001: filledAttack("B10ACTIDEM000001") }, USES)]);
  const once = await foundry(analyze, { actor: alone, compendiums: false });
  expect(once.activities["Gore Idem (3/Day)"].length).toBe(2);
  const stored = Object.fromEntries(once.activities["Gore Idem (3/Day)"].map((a) => [a._id, a]));
  const again = npc("B10ACTORIDEM0002", "B10 Idem Beast 2", [feature("B10ITEMIDEM00002", "Gore Idem (3/Day)", text("Gore Idem", " (3/Day)"), stored, USES)]);
  const twice = await foundry(analyze, { actor: again, compendiums: false });
  evidence("B10-3-idempotence.json", twice);
  expect(twice.activities["Gore Idem (3/Day)"].length, "second import adds nothing").toBe(2);
});

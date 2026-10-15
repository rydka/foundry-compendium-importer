/* global Actor, Item */
// C2 (never a reason for rejection), C3/M5 (filled fields never modified), C4, C12 exception, C15 (rolls in dnd5e),
// M4 (empty utilities left on the real files), M7 (cost of enriching 500 items).
import { readFileSync } from "node:fs";
import { expect, test } from "../../../../test-env/fixtures.mjs";
import { evidence, fixtureJson } from "./helpers.mjs";
import { changedLeaves, itemTokens } from "../support/canon.mjs";
import { makeItems500 } from "../support/items-500.mjs";
import { LIB, idMaker, loadSet } from "../support/replay.mjs";

test.describe.configure({ timeout: 300_000 });

const OUT = (name) => JSON.parse(readFileSync(new URL(`../../tools/out/${name}`, import.meta.url), "utf8"));
const clone = (v) => JSON.parse(JSON.stringify(v));

/** Runs inside Foundry. */
async function clientAnalyze({ entries, documentName, options }) {
  const api = game.modules.get("compendium-json-importer").api;
  let n = 0;
  const idGen = options?.badIds ? () => "bad id" : () => `GEN${String(++n).padStart(13, "0")}`;
  const migrationData = await dnd5e.migrations.getMigrationData();
  const t0 = performance.now();
  const r = await api.analyze(entries, documentName, { migrationData, idGen, ...options?.analyze });
  return {
    ms: performance.now() - t0, counts: r.enrichment?.counts,
    rejected: r.rejected.map((x) => ({ name: x.name, reasons: x.reasons.map((q) => q.key) })),
    accepted: r.accepted.map((a) => ({ data: a.data, enrichment: a.enrichment }))
  };
}

// ---------------------------------------------------------------- C2

test("C2: with enrichment on, no document is rejected that was accepted without it (real files, compendium-40, spellcasting, reference)", async ({ foundry }) => {
  const reference = loadSet("reference");
  const newId = idMaker(5);
  const refItems = reference.features.slice(0, 80).map((c) => ({
    _id: newId(), name: c.name ?? "x", type: "feat",
    system: { description: { value: c.html ?? reference.real.get(c.ref)?.system.description.value }, activities: {} }
  }));
  const sets = [
    ["tools-out/actors", "Actor", OUT("actors.json")], ["tools-out/items", "Item", OUT("items.json")],
    ["compendium-40", "Actor", fixtureJson("enrichment/compendium-40.json")], ["spellcasting", "Actor", fixtureJson("enrichment/spellcasting.json")],
    ["reference-features", "Item", refItems]
  ];
  const rows = [];
  for (const [label, documentName, entries] of sets) {
    const off = await foundry(clientAnalyze, { entries: clone(entries), documentName, options: {} });
    const on = await foundry(clientAnalyze, { entries: clone(entries), documentName, options: { analyze: { enrich: true } } });
    const offNames = new Set(off.rejected.map((r) => r.name));
    const extra = on.rejected.filter((r) => !offNames.has(r.name));
    rows.push({ set: label, documents: entries.length, rejectedOff: off.rejected.length, rejectedOn: on.rejected.length, newlyRejected: extra, counts: on.counts });
    expect(extra, label).toEqual([]);
  }
  evidence("C2-rejets.json", rows);
});

test("C2: an enrichment that produces an invalid document is reverted, the document is accepted as the file gives it", async ({ foundry }) => {
  const id = "FORCEDITEM000001";
  const item = {
    _id: id, name: "Slam", type: "feat",
    system: { description: { value: "<p><strong>Slam.</strong> Melee Weapon Attack: +6 to hit, reach 5 ft., one target. Hit: 7 (1d4 + 4) bludgeoning damage.</p>" }, activities: {} }
  };
  // The enrichment asks the id generator for the id of the activity it creates: an invalid id makes the enriched document invalid.
  const forced = await foundry(clientAnalyze, { entries: [clone(item)], documentName: "Item", options: { badIds: true, analyze: { enrich: true } } });
  const plain = await foundry(clientAnalyze, { entries: [clone(item)], documentName: "Item", options: { analyze: {} } });
  const out = forced.accepted[0];
  evidence("C2-repli-reverted.json", { counts: forced.counts, rejected: forced.rejected, status: out?.enrichment?.status, reasons: out?.enrichment?.reasons, activities: Object.keys(out?.data?.system?.activities ?? {}), plainActivities: Object.keys(plain.accepted[0].data.system.activities ?? {}) });
  expect(forced.rejected).toEqual([]);
  expect(out.enrichment.status).toBe("reverted");
  expect(Object.keys(out.data.system.activities ?? {})).toEqual(Object.keys(plain.accepted[0].data.system.activities ?? {}));
  expect(forced.counts.reverted).toBe(1);
});

// ---------------------------------------------------------------- C3 / M5

function partialDocs() {
  const set = loadSet("reference");
  const newId = idMaker(11);
  const docs = [];
  const en = set.features.filter((c) => c.lang === "en" && !c.ref && c.expected && !c.onlySkip);
  const item = (c, variant, activity) => {
    const aid = newId();
    docs.push({
      variant, caseId: c.id,
      doc: { _id: newId(), name: c.name, type: "feat", system: { description: { value: c.html }, activities: { [aid]: { _id: aid, name: "", ...activity } } } }
    });
  };
  for (const c of en.filter((x) => x.expected.attack)) {
    item(c, "attack-different-bonus-no-damage", { type: "attack", activation: { type: "action", value: 1 }, attack: { flat: true, bonus: "99", type: { value: "melee", classification: "weapon" } } });
    item(c, "attack-damage-different", { type: "attack", activation: { type: "bonus", value: 1 }, attack: { type: { value: "ranged", classification: "spell" } }, damage: { parts: [{ number: 9, denomination: 12, bonus: "9", types: ["psychic"] }] }, range: { value: "999", units: "ft" } });
  }
  for (const c of en.filter((x) => x.expected.save)) {
    item(c, "save-ability-no-dc", { type: "save", activation: { type: "action", value: 1 }, save: { ability: ["str"] } });
    item(c, "save-dc-no-ability", { type: "save", activation: { type: "reaction", value: 1 }, save: { dc: { calculation: "", formula: "99" } }, damage: { onSave: "none" } });
  }
  for (const c of en.filter((x) => x.expected.uses || x.expected.recharge)) {
    const aid = newId();
    docs.push({
      variant: "uses-already-set", caseId: c.id,
      doc: { _id: newId(), name: c.name, type: "feat", system: { description: { value: c.html }, uses: { max: "9", spent: 2, recovery: [{ period: "lr", type: "recoverAll" }] }, activities: { [aid]: { _id: aid, type: "utility", name: "Kept name", activation: { type: "special", value: 4 }, roll: { formula: "1d6", name: "kept" } } } } }
    });
  }
  return docs;
}

test("C3/M5: a field already filled in the file is never modified (partial activities, 20+ documents)", async ({ foundry }) => {
  const docs = partialDocs();
  expect(docs.length).toBeGreaterThanOrEqual(20);
  const res = await foundry(clientAnalyze, { entries: docs.map((d) => clone(d.doc)), documentName: "Item", options: { analyze: { enrich: true } } });
  expect(res.rejected).toEqual([]);
  const byId = new Map(res.accepted.map((a) => [a.data._id, a]));
  const rows = [];
  let leaves = 0, modified = 0, filledFields = 0;
  for (const d of docs) {
    const out = byId.get(d.doc._id);
    const before = d.doc;
    const diffs = changedLeaves(before.system, out.data.system, "system");
    // the leaves compared: every non-empty leaf of the input
    leaves += changedLeaves(before.system, {}, "system").length;
    modified += diffs.length;
    filledFields += out.enrichment?.items?.reduce((n, i) => n + (i.changes?.length ?? 0), 0) ?? 0;
    rows.push({ case: d.caseId, variant: d.variant, status: out.enrichment?.status, modified: diffs });
  }
  evidence("C3-M5-feuilles-modifiees.json", { documents: docs.length, nonEmptyLeaves: leaves, modified, describedAdditions: filledFields, rows: rows.filter((r) => r.modified.length || /^(attack|save)/.test(r.variant)).slice(0, 60) });
  test.info().annotations.push({ type: "M5", description: `${modified} filled field(s) modified out of ${leaves} (${docs.length} documents)` });
  expect(rows.filter((r) => r.modified.length).map((r) => `${r.case}/${r.variant}: ${JSON.stringify(r.modified)}`)).toEqual([]);
  // the enrichment did something on the partial activities (otherwise the test proves nothing)
  expect(rows.filter((r) => r.status === "enriched").length).toBeGreaterThan(5);
});

test("C3/M5: on the real files, the only modified non-empty fields are the converted empty utilities and the documented exceptions", async ({ foundry }) => {
  const items = OUT("items.json");
  const res = await foundry(clientAnalyze, { entries: clone(items), documentName: "Item", options: { analyze: { enrich: true } } });
  const byId = new Map(res.accepted.map((a) => [a.data._id, a.data]));
  const unexplained = [];
  let total = 0;
  for (const item of items) {
    const out = byId.get(item._id);
    if (!out) continue;
    for (const d of changedLeaves(item.system?.activities, out.system?.activities, "activities")) {
      total++;
      const act = d.path.split(".")[1];
      const input = item.system.activities[act];
      const emptyUtility = input?.type === "utility" && !input.roll?.formula && !input.range?.value && !input.uses?.max;
      const converted = emptyUtility && out.system.activities[act]?.type !== "utility";
      // a converted utility loses the utility-only `roll` defaults (false) with its schema; its type changes by design
      const allowed = (d.path.endsWith(".type") && d.before === "utility" && emptyUtility)
        || (converted && /\.roll\.(prompt|visible)$/.test(d.path) && d.before === false)
        || (d.path.endsWith("activation.value") && input?.activation?.type === "legendary")
        || (d.path.endsWith("activation.type") && d.before === "legendary" && /resistance/i.test(item.name));
      if (!allowed) unexplained.push({ item: item.name, ...d });
    }
  }
  evidence("M5-fichiers-reels.json", { items: items.length, changedLeaves: total, unexplained });
  expect(unexplained).toEqual([]);
});

// ---------------------------------------------------------------- C4

test("C4: a text with no recognized formulation leaves the activity and counts the document as not enriched", async ({ foundry }) => {
  const mk = (n, text, act) => ({ _id: `C4ITEM${String(n).padStart(10, "0")}`, name: `Feature ${n}`, type: "feat", system: { description: { value: `<p><strong>Feature ${n}.</strong> ${text}</p>` }, activities: { [`C4ACT${String(n).padStart(11, "0")}`]: { _id: `C4ACT${String(n).padStart(11, "0")}`, type: "utility", name: "", activation: { type: "action", value: 1, condition: "" }, ...act } } } });
  const entries = [
    mk(1, "The creature glows softly and sheds dim light in a radius.", {}),
    mk(2, "Melee Weapon Attack: +5 to hit. Ranged Weapon Attack: +9 to hit. Hit: some damage.", {}),
    mk(3, "The creature can speak with beasts.", {})
  ];
  const res = await foundry(clientAnalyze, { entries: clone(entries), documentName: "Item", options: { analyze: { enrich: true } } });
  const rows = res.accepted.map((a, i) => ({ name: a.data.name, status: a.enrichment.status, identical: JSON.stringify(Object.values(a.data.system.activities)[0]) === JSON.stringify(Object.values(entries[i].system.activities)[0]) || JSON.stringify(Object.values(a.data.system.activities)[0].type) }));
  evidence("C4-textes-sans-formulation.json", { counts: res.counts, rows });
  for (const a of res.accepted) {
    const act = Object.values(a.data.system.activities)[0];
    expect(act.type).toBe("utility");
    expect(act.attack?.bonus ?? "").toBe("");
    expect(a.enrichment.status).toBe("notEnriched");
  }
  expect(res.counts.notEnriched).toBe(3);
});

// ---------------------------------------------------------------- C15 (rolls)

test("C15: the enriched activities roll with the extracted values in dnd5e (attack +6, damage 1d4+4 bludgeoning, save DC and ability)", async ({ foundry }) => {
  const actors = OUT("actors.json").filter((a) => a.name === "Poltergeist");
  const out = await foundry(async (entries) => {
    const api = game.modules.get("compendium-json-importer").api;
    const r = await api.analyze(entries, "Actor", { enrich: true, compendiums: false });
    const data = r.accepted[0].data;
    delete data._id;
    const actor = await Actor.create(data, { keepId: false });
    try {
      const result = {};
      const slam = actor.items.find((i) => i.name === "Slam");
      const attack = slam.system.activities.find((a) => a.type === "attack");
      result.slamActivities = slam.system.activities.map((a) => a.type);
      result.toHitLabel = attack.labels?.toHit ?? null;
      const roll = (await attack.rollAttack({ advantage: false, disadvantage: false }, { configure: false }, { create: false }))?.[0];
      result.attackFormula = roll?.formula ?? null;
      result.attackTotalMinusD20 = roll ? roll.total - roll.dice[0].total : null;
      const dmg = (await attack.rollDamage({}, { configure: false }, { create: false })) ?? [];
      result.damage = dmg.map((d) => ({ formula: d.formula, type: d.options?.type ?? d.options?.types ?? null }));
      // a save activity of the same file
      const withSave = actor.items.map((i) => ({ i, a: i.system.activities?.find((x) => x.type === "save" && x.save?.dc?.formula) })).find((x) => x.a);
      if (withSave) result.save = { item: withSave.i.name, dc: withSave.a.save.dc.value, formula: withSave.a.save.dc.formula, ability: [...withSave.a.save.ability] };
      return result;
    } finally {
      await actor.delete();
    }
  }, actors);
  evidence("C15-jets-poltergeist.json", out);
  expect(out.slamActivities).toContain("attack");
  expect(out.toHitLabel).toBe("+6");
  expect(out.attackTotalMinusD20).toBe(6);
  expect(out.damage.length).toBeGreaterThan(0);
  expect(out.damage[0].formula.replace(/\s+/g, "")).toBe("1d4+4");
  expect(JSON.stringify(out.damage[0].type)).toContain("bludgeoning");
});

test("C15: a save activity created from the text asks the right ability at the right DC", async ({ foundry }) => {
  const item = {
    _id: "C15SAVEITEM00001", name: "Fire Breath (Recharge 5-6)", type: "feat",
    system: { description: { value: "<p><small>Action</small><br/><strong>Fire Breath (Recharge 5-6).</strong> The dragon exhales fire in a 15-foot cone. Each creature in that area must make a DC 13 Wisdom saving throw, taking 22 (5d8) fire damage on a failed save, or half as much damage on a successful one.</p>" }, activities: { C15SAVEACT000001: { _id: "C15SAVEACT000001", type: "utility", name: "", activation: { type: "action", value: 1, condition: "" } } } }
  };
  const out = await foundry(async (entry) => {
    const api = game.modules.get("compendium-json-importer").api;
    const r = await api.analyze([entry], "Item", { enrich: true });
    const data = r.accepted[0].data;
    delete data._id;
    const doc = await Item.create(data);
    try {
      const act = doc.system.activities.find((a) => a.type === "save");
      const dmg = await act.rollDamage({}, { configure: false }, { create: false });
      return { dc: act.save.dc.value, ability: [...act.save.ability], onSave: act.damage.onSave, damage: dmg?.map((d) => d.formula), template: act.target?.template?.type, size: act.target?.template?.size };
    } finally { await doc.delete(); }
  }, item);
  evidence("C15-sauvegarde.json", out);
  expect(out.dc).toBe(13);
  expect(out.ability).toEqual(["wis"]);
  expect(out.onSave).toBe("half");
  expect(out.damage?.[0].replace(/\s+/g, "")).toBe("5d8");
});

// ---------------------------------------------------------------- M4

const FORMULATION = [/\bto hit\b/i, /au toucher/i, /\bHit:/, /Touch[ée]\s*:/, /\breach \d+ ?ft/i, /\brange \d+(\/\d+)? ?ft/i, /allonge \d/i, /portée \d/i,
  /\bDC \d+ \w+ saving throw/i, /saving throw\b.*\bDC \d+/i, /DD \d+/, /\(Recharge \d/i, /\b\d+\/Day\b/i, /\b\d+\/jour\b/i, /Recharges? after/i, /\d+ \(\d+d\d+( ?[+-] ?\d+)?\)/];

test("M4: empty utility activities left on the real files whose text contains a C5-C9 formulation", async ({ foundry }) => {
  const rows = [];
  const count = (label, docs, outDocs) => {
    const byId = new Map(outDocs.map((d) => [d._id, d]));
    let before = 0, after = 0;
    const left = [];
    const check = (item, outItem) => {
      if (/multiattack|attaques multiples/i.test(item.name)) return;
      const text = (item.system?.description?.value ?? "").replace(/<[^>]+>/g, " ");
      if (!FORMULATION.some((re) => re.test(text))) return;
      for (const [id, act] of Object.entries(item.system?.activities ?? {})) {
        if (act.type !== "utility" || act.roll?.formula || act.range?.value || act.uses?.max) continue;
        before++;
        const now = outItem?.system?.activities?.[id];
        // still empty = still a utility AND nothing actionable gained by the item (uses, recharge, legendary resistance)
        const gained = itemTokens(outItem).filter((t) => !itemTokens(item).includes(t) && !t.startsWith("activation="));
        if ((!now || now.type === "utility") && !gained.length) { after++; left.push(item.name); }
      }
    };
    for (const d of docs) {
      if (d.items) for (const it of d.items) check(it, byId.get(d._id)?.items?.find((x) => x._id === it._id));
      else check(d, byId.get(d._id));
    }
    rows.push({ file: label, emptyUtilitiesWithFormulation: before, left: after, names: left });
    return after;
  };
  const items = OUT("items.json"), actors = OUT("actors.json");
  const ri = await foundry(clientAnalyze, { entries: clone(items), documentName: "Item", options: { analyze: { enrich: true } } });
  const ra = await foundry(clientAnalyze, { entries: clone(actors), documentName: "Actor", options: { analyze: { enrich: true, compendiums: false } } });
  const a = count("tools/out/items.json", items, ri.accepted.map((x) => x.data));
  const b = count("tools/out/actors.json", actors, ra.accepted.map((x) => x.data));
  evidence("M4-utilitaires-restants.json", { before: rows.reduce((n, r) => n + r.emptyUtilitiesWithFormulation, 0), left: a + b, rows });
  test.info().annotations.push({ type: "M4", description: `${a + b} empty utility activities with a formulation left (initial ${rows.reduce((n, r) => n + r.emptyUtilitiesWithFormulation, 0)})` });
});

// ---------------------------------------------------------------- M7

test("M7: analysis time of 500 items, enrichment on versus off (3 passes each, median)", async ({ foundry }) => {
  const reference = loadSet("reference");
  const extra = reference.features.slice(0, 20).map((c) => c.html).filter(Boolean);
  const items = makeItems500(extra);
  const run = async (enrich) => {
    const times = [];
    for (let i = 0; i < 3; i++) {
      const r = await foundry(clientAnalyze, { entries: clone(items), documentName: "Item", options: { analyze: { enrich } } });
      times.push(r.ms);
    }
    return times.sort((x, y) => x - y);
  };
  const off = await run(false), on = await run(true);
  const one = await foundry(clientAnalyze, { entries: clone(items), documentName: "Item", options: { analyze: { enrich: true } } });
  const median = (a) => a[1];
  const overhead = (median(on) - median(off)) / 1000;
  evidence("M7-surcout-500.json", { items: items.length, offMs: off, onMs: on, overheadSeconds: Math.round(overhead * 100) / 100, target: 2, counts: one.counts, libraryDir: LIB });
  test.info().annotations.push({ type: "M7", description: `overhead ${overhead.toFixed(2)} s for 500 items (target 2 s)` });
});

// ---------------------------------------------------------------- C12 exception

test("C12: Legendary Resistance is no longer a legendary action; the exception is the only filled field changed", async ({ foundry }) => {
  const actors = OUT("actors.json");
  const holders = actors.filter((a) => a.items.some((i) => /legendary resistance/i.test(i.name)));
  const res = await foundry(clientAnalyze, { entries: clone(holders), documentName: "Actor", options: { analyze: { enrich: true, compendiums: false } } });
  const rows = [];
  for (const a of res.accepted) {
    const lr = a.data.items.find((i) => /legendary resistance/i.test(i.name));
    const types = Object.values(lr.system.activities).map((x) => x.activation?.type);
    rows.push({ actor: a.data.name, types, replacedNote: a.enrichment.items.some((e) => e.notes?.some((n) => /LegendaryResistanceReplaced/.test(n.key))), legres: a.data.system.resources?.legres?.max });
  }
  evidence("C12-resistance-legendaire.json", rows);
  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) {
    expect(r.types).not.toContain("legendary");
    expect(r.types).toContain("special");
  }
});

// ---------------------------------------------------------------- B8: damage type choices and conditional second result

const util = (id) => ({ [id]: { _id: id, type: "utility", name: "", activation: { type: "action", value: 1, condition: "" }, roll: { formula: "" } } });
const feat = (id, actId, name, html) => ({ _id: id, name, type: "feat", img: "icons/svg/aura.svg", system: { description: { value: html }, activities: util(actId) } });

test("B8: a 'X or Y' damage type and a conditional second result are written without inventing anything", async ({ foundry }) => {
  const actorData = {
    _id: "B8ACTOR000000001", name: "B8 Test Beast", type: "npc",
    system: { details: { cr: 3 } },
    items: [
      feat("B8ITEMCHOICE0001", "B8ACTCHOICE00001", "Storm Bite",
        "<p><small>Action</small><br/><strong>Storm Bite.</strong> <em>Melee Attack Roll:</em> +5, reach 5 ft. <em>Hit:</em> 9 (2d8) lightning or thunder damage.</p>"),
      feat("B8ITEMCOND000001", "B8ACTCOND0000001", "Gore",
        "<p><small>Action</small><br/><strong>Gore.</strong> <em>Melee Attack Roll:</em> +6, reach 5 ft. <em>Hit:</em> 9 (2d8) piercing damage, or 11 (2d8 + 2) piercing damage if the target is Bloodied.</p>")
    ]
  };
  const out = await foundry(async (entry) => {
    const api = game.modules.get("compendium-json-importer").api;
    const r = await api.analyze([entry], "Actor", { enrich: true, compendiums: false });
    const res = { rejected: r.rejected.map((x) => ({ name: x.name, reasons: x.reasons.map((q) => q.key) })), accepted: r.accepted.length };
    if (!r.accepted.length) return res;
    res.enrichment = r.accepted[0].enrichment;
    const data = r.accepted[0].data;
    delete data._id;
    const actor = await Actor.create(data, { keepId: false });
    try {
      res.valid = actor.validate({ strict: false }) !== false;
      res.invalid = actor.validate?.({ strict: false, fallback: false }) === false;
      res.items = {};
      for (const item of actor.items) {
        res.items[item.name] = item.system.activities.map((a) => ({
          type: a.type, attack: a.attack ? { bonus: a.attack.bonus, flat: a.attack.flat } : null,
          damage: (a.damage?.parts ?? []).map((p) => ({ number: p.number, denomination: p.denomination, bonus: p.bonus, types: [...(p.types ?? [])], custom: p.custom?.enabled ? p.custom.formula : null })),
          description: a.description?.chatFlavor ?? ""
        }));
      }
      return res;
    } finally { await actor.delete(); }
  }, actorData);
  evidence("B8-choix-et-condition.json", out);
  expect(out.rejected, "the actor is accepted").toEqual([]);
  expect(out.invalid, "the created actor is valid").toBeFalsy();
  const types = (name) => out.items[name].flatMap((a) => a.damage.flatMap((p) => p.types));
  // (a) choice: dnd5e needs one or no type; whatever the importer writes must be one of the two listed, or none
  const choice = out.items["Storm Bite"].flatMap((a) => a.damage);
  expect(choice.length, "the dice are written").toBeGreaterThan(0);
  expect(`${choice[0].number}d${choice[0].denomination}`).toBe("2d8");
  expect(types("Storm Bite").every((t) => ["lightning", "thunder"].includes(t)), JSON.stringify(types("Storm Bite"))).toBe(true);
  expect(types("Storm Bite").length, "no type is chosen for the user (at most one of the listed)").toBeLessThanOrEqual(1);
  // (b) conditional second result: only piercing, no extra invented type, the base hit is kept
  const gore = out.items["Gore"].flatMap((a) => a.damage);
  expect(gore.length).toBeGreaterThanOrEqual(1);
  expect(types("Gore").every((t) => t === "piercing")).toBe(true);
  expect(`${gore[0].number}d${gore[0].denomination}`).toBe("2d8");
  const attack = out.items["Gore"].find((a) => a.type === "attack");
  expect(attack?.attack.bonus ?? null).not.toBeNull();
});

// C18-C24 (compendium lookup, reuse, adjustment, spells of the casting traits, summary data, sources) and
// M9 (matches), M10 (adjustment), M11 (spells). Data sets: tests/fixtures/enrichment/{compendium-40,spellcasting}.json
// with hand-written expectations in the *-expected.json files.
import { expect, test } from "../../../../test-env/fixtures.mjs";
import { evidence, fixtureJson } from "./helpers.mjs";
import { itemTokens } from "../support/canon.mjs";

test.describe.configure({ timeout: 240_000 });

/** Runs inside Foundry: analysis plus the identity of every compendium source found on the result. */
async function clientAnalyze({ entries, options }) {
  const api = game.modules.get("compendium-json-importer").api;
  let n = 0;
  const idGen = () => `GEN${String(++n).padStart(13, "0")}`;
  const migrationData = await dnd5e.migrations.getMigrationData();
  const watched = new Set();
  const before = {};
  const packs = (options?.watch ?? ["dnd5e.spells24", "dnd5e.equipment24", "dnd5e.monsterfeatures24", "dnd5e.monsterfeatures", "dnd5e.spells"]);
  for (const id of packs) {
    const idx = await game.packs.get(id).getIndex({ fields: ["_stats.modifiedTime"] });
    before[id] = JSON.stringify(Array.from(idx).map((e) => [e._id, e._stats?.modifiedTime]));
  }
  const r = await api.analyze(entries, "Actor", { migrationData, idGen, enrich: true, ...options?.analyze });
  const after = {};
  for (const id of packs) {
    const idx = await game.packs.get(id).getIndex({ fields: ["_stats.modifiedTime"] });
    after[id] = JSON.stringify(Array.from(idx).map((e) => [e._id, e._stats?.modifiedTime]));
  }
  const source = (uuid) => {
    if (!uuid) return null;
    const p = uuid.split(".");
    const pack = game.packs.get(`${p[1]}.${p[2]}`);
    const name = pack?.index.get(p[4])?.name ?? null;
    return { uuid, pack: `${p[1]}.${p[2]}`, name, key: `${p[1]}.${p[2]}|${name}` };
  };
  for (const id of packs) watched.add(id);
  return {
    counts: r.enrichment?.counts, skipped: r.enrichment?.skipped,
    rejected: r.rejected.map((x) => ({ name: x.name, reasons: x.reasons.map((q) => q.key) })),
    packsUnchanged: Object.fromEntries(packs.map((id) => [id, before[id] === after[id]])),
    accepted: r.accepted.map((a) => ({
      data: a.data, enrichment: a.enrichment,
      sources: Object.fromEntries((a.data.items ?? []).map((i) => [i._id, source(i._stats?.compendiumSource)]))
    }))
  };
}

const idOf = (actor, item) => item._id;

// ---------------------------------------------------------------- compendium-40 (C18-C21, C23, M9, M10)

const FACT_TOKEN = {
  attack: (v) => ({ kind: "regex", re: new RegExp(`^attack=.*${v.replace(/^.*?(\+\d+)$/, "$1").replace("+", "\\+")}$`) }),
  range: (v) => ({ kind: "eq", token: `range=${v}` }),
  save: (v) => ({ kind: "eq", token: `save=${v}` }),
  activation: (v) => ({ kind: "eq", token: `activation=${v.replace(/ 1$/, "")}` })
};

function expectedFactTokens(facts) {
  const out = [];
  for (const [k, v] of Object.entries(facts ?? {})) {
    if (k === "attack" || k === "range" || k === "save" || k === "activation") out.push({ field: k, ...FACT_TOKEN[k](v) });
    else if (k === "damage") for (const d of v) out.push({ field: "damage", kind: "any", tokens: [`damage=${d}`, `saveDamage=${d}`] });
    else if (k === "uses") {
      out.push({ field: "uses", kind: "eq", token: /^recharge /.test(v) ? `recharge=${v.replace("recharge ", "")}` : `uses=${v}` });
    } else if (k === "quantity") out.push({ field: "quantity", kind: "quantity", value: v });
  }
  return out;
}

test.describe("compendium-40", () => {
  let result;
  let fixture;
  let expected;

  test.beforeAll(() => {
    fixture = fixtureJson("enrichment/compendium-40.json");
    expected = fixtureJson("enrichment/compendium-40-expected.json");
  });

  const run = async (foundry, options) => {
    return foundry(clientAnalyze, { entries: JSON.parse(JSON.stringify(fixture)), options });
  };

  test("C18/C19/C23/M9: every item is looked up in the right compendium; the sources are not modified", async ({ foundry }) => {
    result = await run(foundry);
    expect(result.rejected).toEqual([]);
    const rows = [];
    let present = 0, found = 0, falseMatches = 0, expectedNone = 0;
    for (const [ai, actor] of expected.actors.entries()) {
      const out = result.accepted.find((a) => a.data._id === fixture[ai]._id);
      expect(out, actor.name).toBeTruthy();
      for (const [ii, exp] of actor.items.entries()) {
        const input = fixture[ai].items[ii];
        const item = out.data.items.find((i) => i._id === input._id);
        const src = out.sources[input._id];
        const report = out.enrichment.items.find((e) => e.name === input.name && ((e.uuid && e.uuid === src?.uuid) || (!e.uuid)));
        let verdict;
        if (exp.expect === "none" || exp.expect === "skip") {
          verdict = !src ? "ok" : "false-match";
          expectedNone++;
          if (src) falseMatches++;
        } else if (exp.expect === "ambiguous") {
          const amb = out.enrichment.items.some((e) => e.name === input.name && e.origin === "ambiguous");
          verdict = !src && amb ? "ok" : "wrong";
          if (src) falseMatches++;
        } else {
          present++;
          if (src?.key === exp.expect) { verdict = "ok"; found++; } else if (src) { verdict = "false-match"; falseMatches++; } else verdict = "missed";
        }
        rows.push({ actor: actor.name, type: input.type, name: input.name, expect: exp.expect, got: src?.key ?? null, uuid: src?.uuid ?? null, verdict, link: item?._stats?.compendiumSource ?? null, reportedPack: report?.pack ?? null });
      }
    }
    const summary = { present, found, recallPct: Math.round((found / present) * 10000) / 100, falseMatches, expectedNone, items: rows.length, packsUnchanged: result.packsUnchanged };
    evidence("C18-C19-M9-correspondances.json", { summary, rows });
    test.info().annotations.push({ type: "M9", description: `${found}/${present} found (${summary.recallPct} %), ${falseMatches} false match(es)` });
    expect(Object.values(result.packsUnchanged).every(Boolean), "C19: the source compendiums are not modified").toBe(true);
    expect(rows.filter((r) => r.verdict !== "ok").map((r) => `${r.name} (${r.type}): ${r.verdict} expected ${r.expect} got ${r.got}`)).toEqual([]);
  });

  test("C19: a reused item has the activities, effects, image and link of the compendium document and keeps the file name", async ({ foundry }) => {
    result ??= await run(foundry);
    const out = result.accepted.find((a) => a.data._id === fixture[0]._id);
    const input = fixture[0].items.find((i) => i.name === "Fireball" && i.type === "spell");
    const item = out.data.items.find((i) => i._id === input._id);
    const uuid = item._stats.compendiumSource;
    const sample = await foundry(async (u) => {
      const d = await fromUuid(u);
      const o = d.toObject();
      return { name: d.name, img: d.img, activityIds: Object.keys(o.system.activities ?? {}), effects: d.effects.size };
    }, uuid);
    const outcome = { uuid, name: item.name, img: item.img, activityIds: Object.keys(item.system.activities ?? {}), effects: item.effects?.length ?? 0, compendium: sample };
    evidence("C19-reprise-fireball.json", outcome);
    expect(uuid).toMatch(/^Compendium\.dnd5e\.spells24\.Item\./);
    expect(item.name).toBe("Fireball");
    expect(item.img).toBe(sample.img);
    expect(outcome.activityIds).toEqual(sample.activityIds);
    expect(outcome.activityIds.length).toBeGreaterThan(0);
    expect(outcome.effects).toBe(sample.effects);
  });

  test("C20/M10: the extracted values replace those of the compendium on the actor item; the description gets a PDF note", async ({ foundry }) => {
    result ??= await run(foundry);
    const rows = [];
    let total = 0, ok = 0;
    for (const [ai, actor] of expected.actors.entries()) {
      const out = result.accepted.find((a) => a.data._id === fixture[ai]._id);
      for (const [ii, exp] of actor.items.entries()) {
        if (!Object.keys(exp.facts ?? {}).length || !/\|/.test(exp.expect)) continue;
        const input = fixture[ai].items[ii];
        const item = out.data.items.find((i) => i._id === input._id);
        const tokens = itemTokens(item);
        for (const f of expectedFactTokens(exp.facts)) {
          total++;
          let good;
          if (f.kind === "eq") good = tokens.includes(f.token);
          else if (f.kind === "regex") good = tokens.some((t) => f.re.test(t));
          else if (f.kind === "any") good = f.tokens.some((t) => tokens.includes(t));
          else good = Number(item.system?.quantity) === Number(f.value);
          if (good) ok++;
          rows.push({ actor: actor.name, item: input.name, field: f.field, ok: good, expected: f.token ?? f.tokens ?? f.value, tokens: good ? undefined : tokens });
        }
        if (exp.hasText) {
          const desc = item.system?.description?.value ?? "";
          rows.push({ actor: actor.name, item: input.name, field: "pdfNote", ok: /Version du PDF|PDF version/i.test(desc) || desc.includes(input.system.description.value) });
        }
      }
      // legendary resistance count on the actor
      const lr = actor.items.find((i) => i.facts?.legres);
      if (lr) {
        total++;
        const good = Number(out.data.system?.resources?.legres?.max) === lr.facts.legres;
        if (good) ok++;
        rows.push({ actor: actor.name, item: lr.name, field: "legres", ok: good, got: out.data.system?.resources?.legres?.max });
      }
    }
    const pct = Math.round((ok / total) * 10000) / 100;
    evidence("C20-M10-ajustement.json", { total, ok, pct, rows });
    test.info().annotations.push({ type: "M10", description: `${ok}/${total} adjusted values correct (${pct} %)` });
    expect(rows.filter((r) => !r.ok)).toEqual([]);
  });

  test("C21/C23: items without a match are built from the file and the summary names the compendium items, the text-built, the ambiguous", async ({ foundry }) => {
    result ??= await run(foundry);
    const lines = [];
    for (const [ai, actor] of expected.actors.entries()) {
      const out = result.accepted.find((a) => a.data._id === fixture[ai]._id);
      for (const [ii, exp] of actor.items.entries()) {
        if (exp.expect !== "none") continue;
        const input = fixture[ai].items[ii];
        const item = out.data.items.find((i) => i._id === input._id);
        expect(item, input.name).toBeTruthy();
        expect(item.name).toBe(input.name);
        expect(item._stats?.compendiumSource ?? null).toBeNull();
        const entry = out.enrichment.items.find((e) => e.name === input.name);
        lines.push({ actor: actor.name, name: input.name, type: input.type, hasText: exp.hasText, reported: entry ? entry.origin : null, changes: entry?.changes?.length ?? 0 });
      }
      const origins = out.enrichment.items.reduce((m, e) => ({ ...m, [e.origin]: (m[e.origin] ?? 0) + 1 }), {});
      lines.push({ actor: actor.name, origins });
    }
    evidence("C21-C23-sans-correspondance.json", lines);
    // C23: compendium entries carry the pack label and uuid; the ambiguous one is listed
    const first = result.accepted.find((a) => a.data._id === fixture[0]._id);
    const comp = first.enrichment.items.filter((e) => e.origin === "compendium");
    expect(comp.length).toBeGreaterThan(10);
    expect(comp.every((e) => e.pack && e.uuid)).toBe(true);
    expect(first.enrichment.items.some((e) => e.origin === "ambiguous" && e.name === "Torch")).toBe(true);
    const fireball = comp.find((e) => e.name === "Fireball");
    expect(fireball.adjusted.length).toBeGreaterThan(0);
    // C21: an item without a match whose text gives something is reported as built from the text
    const textBuilt = lines.filter((l) => l.reported === "text");
    expect(textBuilt.length).toBeGreaterThan(0);
    // C21: the French name and the homonym of another type are not taken from the English compendium
    const boule = first.data.items.find((i) => i.name === "Boule de feu");
    expect(boule._stats?.compendiumSource ?? null).toBeNull();
  });

  test("C24: the order and the choice of the sources change the match; the import window can switch the compendiums off", async ({ foundry }) => {
    const pick = async (settingValue, analyzeOptions) => {
      await foundry((v) => game.settings.set("compendium-json-importer", "compendiumSources", v), settingValue);
      const r = await run(foundry, { analyze: analyzeOptions });
      const out = r.accepted.find((a) => a.data._id === fixture[0]._id);
      const fb = fixture[0].items.find((i) => i.name === "Fireball" && i.type === "spell");
      return { source: out.sources[fb._id]?.key ?? null, fromCompendium: out.enrichment.items.filter((e) => e.origin === "compendium").length };
    };
    try {
      const byDefault = await pick([], undefined);
      const legacyFirst = await pick([{ pack: "dnd5e.spells", enabled: true }], undefined);
      const spellsOff = await pick([{ pack: "dnd5e.spells24", enabled: false }, { pack: "dnd5e.spells", enabled: false }], undefined);
      const switchedOff = await pick([], { compendiums: false });
      const defaults = await foundry(async () => {
        const m = await import("/modules/compendium-json-importer/scripts/foundry/enrichment.mjs");
        const sources = m.resolveSources();
        return { first: sources[0], excluded: sources.filter((s) => !s.enabled).map((s) => s.pack), worldAndModules: sources.filter((s) => !s.pack.startsWith("dnd5e.")).map((s) => s.enabled) };
      });
      evidence("C24-sources.json", { byDefault, legacyFirst, spellsOff, switchedOff, defaults });
      expect(byDefault.source).toBe("dnd5e.spells24|Fireball");
      expect(legacyFirst.source).toBe("dnd5e.spells|Fireball");
      expect(spellsOff.source).toBeNull();
      expect(switchedOff.fromCompendium).toBe(0);
      expect(defaults.first.pack.startsWith("dnd5e.")).toBe(true);
      expect(defaults.excluded.sort()).toEqual(expect.arrayContaining(["dnd5e.classfeatures", "dnd5e.classes", "dnd5e.subclasses"]));
    } finally {
      await foundry(() => game.settings.set("compendium-json-importer", "compendiumSources", []));
    }
  });
});

// ---------------------------------------------------------------- spellcasting (C22, M11)

test("C22/M11: the spells of the casting traits are added with mode, level, uses, DC, attack bonus and slots (EN and FR)", async ({ foundry }) => {
  const fixture = fixtureJson("enrichment/spellcasting.json");
  const expected = fixtureJson("enrichment/spellcasting-expected.json");
  const result = await foundry(clientAnalyze, { entries: JSON.parse(JSON.stringify(fixture)), options: {} });
  expect(result.rejected).toEqual([]);
  const rows = [];
  const tally = { spells: 0, spellsOk: 0, dc: 0, dcOk: 0, bonus: 0, bonusOk: 0, actors: 0, actorsOk: 0 };
  const norm = (s) => String(s).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
  for (const [ai, actor] of expected.actors.entries()) {
    const out = result.accepted.find((a) => a.data._id === fixture[ai]._id);
    const spells = out.data.items.filter((i) => i.type === "spell");
    const actorRow = { actor: actor.name, language: actor.language, spells: spells.length, expected: actor.spells.length };
    tally.actors++;
    const slotsOk = Object.entries(actor.slots).every(([lvl, n]) => Number(out.data.system?.spells?.[`spell${lvl}`]?.override) === n);
    const abilityOk = out.data.system?.attributes?.spellcasting === actor.ability;
    actorRow.slotsOk = slotsOk; actorRow.abilityOk = abilityOk;
    if (slotsOk && abilityOk) tally.actorsOk++;
    for (const exp of actor.spells) {
      tally.spells++;
      const item = spells.find((s) => norm(s.name) === norm(exp.name));
      const src = item ? out.sources[item._id] : null;
      // an "(at will)" cantrip list is accepted as method "atwill" (level 0) or "spell" (level 0); the EN/FR difference is reported
      const mode = { cantrip: ["spell", "atwill"], slots: ["spell"], atwill: ["atwill"], innate: ["innate"] }[exp.method];
      const checks = {
        present: !!item,
        method: mode.includes(item?.system?.method),
        uses: exp.uses === null || String(item?.system?.uses?.max) === String(exp.uses),
        level: exp.level === null || item?.system?.level === exp.level,
        source: exp.expect === "none" ? !src : src?.key === exp.expect
      };
      const ok = Object.values(checks).every(Boolean);
      if (ok) tally.spellsOk++;
      const acts = Object.values(item?.system?.activities ?? {});
      for (const a of acts) {
        if (a.type === "save") {
          tally.dc++;
          if (String(a.save?.dc?.formula) === String(actor.dc) && !a.save?.dc?.calculation) tally.dcOk++;
          else rows.push({ actor: actor.name, spell: exp.name, dc: a.save?.dc });
        }
        if (a.type === "attack") {
          tally.bonus++;
          if (a.attack.flat === true && String(a.attack.bonus) === String(actor.attack)) tally.bonusOk++;
          else rows.push({ actor: actor.name, spell: exp.name, attack: a.attack });
        }
      }
      if (ok && exp.method === "cantrip" && item?.system?.method !== "spell") rows.push({ actor: actor.name, spell: exp.name, note: "cantrip list read as at-will", language: actor.language, got: item.system.method });
      if (!ok) rows.push({ actor: actor.name, spell: exp.name, checks, got: item ? { method: item.system.method, level: item.system.level, uses: item.system.uses?.max, source: src?.key ?? null } : null });
    }
    rows.push(actorRow);
  }
  const pct = (a, b) => (b ? Math.round((a / b) * 10000) / 100 : null);
  const summary = { ...tally, spellsPct: pct(tally.spellsOk, tally.spells), dcPct: pct(tally.dcOk, tally.dc), bonusPct: pct(tally.bonusOk, tally.bonus) };
  evidence("C22-M11-sorts.json", { summary, rows });
  test.info().annotations.push({ type: "M11", description: `spells ${summary.spellsPct} %, DC ${summary.dcPct} % (${tally.dc}), bonus ${summary.bonusPct} % (${tally.bonus})` });
  expect.soft(tally.actorsOk, "ability and slots of every actor").toBe(tally.actors);
  expect.soft(tally.spellsOk, "every listed spell has the right mode, level, uses and source").toBe(tally.spells);
  expect.soft(tally.dcOk).toBe(tally.dc);
  expect.soft(tally.bonusOk).toBe(tally.bonus);
});

test("C22: the real Death Knight (truncated trait, no spell list) gets no spell and no invention", async ({ foundry }) => {
  const { readFileSync } = await import("node:fs");
  const actors = JSON.parse(readFileSync(new URL("../../tools/out/actors.json", import.meta.url), "utf8"));
  const dk = actors.find((a) => /death knight/i.test(a.name));
  expect(dk).toBeTruthy();
  const result = await foundry(clientAnalyze, { entries: [dk], options: {} });
  const out = result.accepted[0];
  evidence("C22-death-knight.json", { spellsAdded: out.data.items.filter((i) => i.type === "spell").length, status: out.enrichment.status, notes: out.enrichment.notes });
  expect(out.data.items.filter((i) => i.type === "spell")).toHaveLength(dk.items.filter((i) => i.type === "spell").length);
});

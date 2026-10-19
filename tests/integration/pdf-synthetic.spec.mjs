// PDF import on the synthetic reference books, in the real Foundry (EN / FR, 2014 / 2024): C2, C3, C6 and the
// document type of the target. Quick (small files); no external PDF needed.
import path from "node:path";
import { expect, test } from "../../../../test-env/fixtures.mjs";
import { clientDeletePacks, clientReadPack, evidence, uniqueName } from "./helpers.mjs";
import { SYNTHETIC, WIN, analyze, canonical, chooseFile, confirm, fillNewPack, openWindow, readLang, syntheticFile, watchConsole } from "./pdf-helpers.mjs";
import { expectedOfDoc, loadDoc } from "../support/synth.mjs";
import { nameKey } from "../support/score.mjs";
import { fingerprintOf } from "../support/fingerprint.mjs";

const created = [];
test.afterEach(async ({ foundry }) => {
  await foundry(async (id) => { await foundry.applications.instances.get(id)?.close(); }, "compendium-json-importer");
  if (created.length) await foundry(clientDeletePacks, created.splice(0));
});

const doc = (name) => loadDoc(path.join(SYNTHETIC, `${name}.json`));

async function importInto(page, foundry, { file, filter, name }) {
  const pack = uniqueName(name);
  created.push(pack);
  await openWindow(page);
  await page.selectOption(`${WIN} select[name=typeFilter]`, filter);
  await chooseFile(page, await syntheticFile(file));
  await fillNewPack(page, `PDF ${pack}`, pack);
  await analyze(page);
  await expect(page.locator(`${WIN} .cji-summary`)).toBeVisible({ timeout: 60_000 });
  await confirm(page);
  const count = filter === "actors" ? expectedOfDoc(doc(file)).creatures.length : expectedOfDoc(doc(file)).items.length;
  await expect.poll(async () => (await foundry(clientReadPack, `world.${pack}`))?.length ?? 0, { timeout: 60_000 }).toBe(count);
  return { pack, docs: await foundry(clientReadPack, `world.${pack}`) };
}

for (const file of ["ref-2014-en", "ref-2014-fr", "ref-2024-en", "ref-2024-fr"]) {
  test(`C2: ${file} imports its creatures as NPC actors with the exact text of their abilities`, async ({ gamePage, foundry }, testInfo) => {
    const con = watchConsole(gamePage);
    const { docs } = await importInto(gamePage, foundry, { file, filter: "actors", name: file });
    const want = expectedOfDoc(doc(file));
    const report = [];
    for (const exp of want.creatures) {
      const actor = docs.find((d) => nameKey(d.name) === nameKey(exp.name));
      expect(actor, exp.name).toBeTruthy();
      expect(actor.type).toBe("npc");
      expect(actor.system.details.cr).toBe(exp.cr);
      expect(actor.system.attributes.hp.max).toBe(exp.hp.value);
      expect(actor.system.traits.size).toBe(exp.size);
      for (const [k, v] of Object.entries(exp.abilities)) expect(actor.system.abilities[k].value, `${exp.name} ${k}`).toBe(v);
      for (const e of exp.entries) {
        const item = actor.items.find((i) => nameKey(i.name) === nameKey(e.name) && (i.system.description?.value ?? "").length);
        expect(item, `${exp.name}: ${e.name}`).toBeTruthy();
      }
      // exact text: every expected fingerprint is found among the items' descriptions
      const missing = exp.entries.filter((e) => !actor.items.some((i) => { const f = fingerprintOf(i.system.description?.value ?? ""); return f.sha1 === e.sha1 && f.length === e.length; }));
      report.push({ creature: exp.name, items: actor.items.length, textsNotIdentical: missing.map((m) => m.name) });
    }
    evidence(`C2-${file}.json`, report);
    await gamePage.screenshot({ path: testInfo.outputPath(`C2-${file}-apres-import.png`) });
    expect(report.flatMap((r) => r.textsNotIdentical), "entries whose text is not the one of the book").toEqual([]);
    expect(con.attributed()).toEqual([]);
  });
}

for (const file of ["ref-items-en", "ref-items-fr"]) {
  test(`C3: ${file} imports its magic items with type, rarity and attunement`, async ({ gamePage, foundry }, testInfo) => {
    const { docs } = await importInto(gamePage, foundry, { file, filter: "items", name: file });
    const want = expectedOfDoc(doc(file)).items;
    const report = [];
    for (const exp of want) {
      const item = docs.find((d) => nameKey(d.name) === nameKey(exp.name));
      expect(item, exp.name).toBeTruthy();
      report.push({ name: item.name, type: item.type, typeValue: item.system.type?.value ?? null, rarities: item.system.rarities, attunement: item.system.attunement });
      expect(item.type).toBe(exp.docType);
      if (exp.typeValue) expect(item.system.type?.value).toBe(exp.typeValue);
      expect(item.system.rarities).toEqual([exp.rarity]);
      expect(item.system.attunement || "").toBe(exp.attunement);
    }
    evidence(`C3-${file}.json`, report);
    await gamePage.screenshot({ path: testInfo.outputPath(`C3-${file}-apres-import.png`) });
  });
}

test("target type: an item PDF into an actor compendium imports nothing and says so", async ({ gamePage }) => {
  const pack = uniqueName("tt-none");
  created.push(pack);
  await openWindow(gamePage);
  await gamePage.selectOption(`${WIN} select[name=typeFilter]`, "actors");
  await chooseFile(gamePage, await syntheticFile("ref-items-en"));
  await fillNewPack(gamePage, `TT ${pack}`, pack);
  await analyze(gamePage);
  await expect(gamePage.locator(`${WIN} .cji-summary`)).toBeVisible({ timeout: 60_000 });
  const text = await gamePage.locator(`${WIN} .cji-summary`).innerText();
  expect(text).toContain(readLang("en").Pdf.IgnoredItems.replace("{count}", "5"));
  await expect(gamePage.locator(`${WIN} button[data-action=confirmImport]`)).toBeDisabled();
});

test("C6: importing the same PDF twice, into two compendiums, gives the same documents (names, CR, texts, formulas)", async ({ gamePage, foundry }) => {
  const a = await importInto(gamePage, foundry, { file: "ref-2014-en", filter: "actors", name: "c6-a" });
  const b = await importInto(gamePage, foundry, { file: "ref-2014-en", filter: "actors", name: "c6-b" });
  const ca = a.docs.map(canonical).sort((x, y) => x.name.localeCompare(y.name));
  const cb = b.docs.map(canonical).sort((x, y) => x.name.localeCompare(y.name));
  evidence("C6-comparaison.json", { names: ca.map((d) => d.name), identical: JSON.stringify(ca) === JSON.stringify(cb), itemsPerActor: ca.map((d) => d.items.length) });
  expect(cb).toEqual(ca);
});

test("C6: the same PDF read twice through api.readPdf gives identical entries, ids included", async ({ foundry }) => {
  const f = await syntheticFile("ref-2024-fr");
  const bytes = [...f.buffer];
  const one = await foundry(async (arg) => {
    const api = game.modules.get("compendium-json-importer").api;
    const r = await api.readPdf(new Uint8Array(arg.bytes), { fileName: arg.fileName, documentName: "Actor" });
    return JSON.stringify(r.entries);
  }, { bytes, fileName: "ref-2024-fr.pdf" });
  const two = await foundry(async (arg) => {
    const api = game.modules.get("compendium-json-importer").api;
    const r = await api.readPdf(new Uint8Array(arg.bytes), { fileName: arg.fileName, documentName: "Actor" });
    return JSON.stringify(r.entries);
  }, { bytes, fileName: "ref-2024-fr.pdf" });
  expect(JSON.parse(one).length).toBeGreaterThan(0);
  expect(two).toBe(one);
});

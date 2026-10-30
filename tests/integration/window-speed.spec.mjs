/* global document, MutationObserver, window */
// Window behaviour added by the speed work: a taken compendium name is shown next to the field (no analysis),
// the progress line and the disabled buttons, the error line and the form usable again, the index cache and the
// sources, and the time of the review step (M7).
import { expect, test } from "../../../../test-env/fixtures.mjs";
import { MODULE_ID, clientDeletePacks, clientReadPack, clientSeedPack, evidence, fixturePath, uniqueName } from "./helpers.mjs";

test.describe.configure({ timeout: 240_000 });

const WIN = "#compendium-json-importer";
const created = [];

test.afterEach(async ({ foundry }) => {
  await foundry(async (id) => {
    await foundry.applications.instances.get(id)?.close();
    await game.settings.set(id, "compendiumSources", []);
    await game.settings.set(id, "lastEnrich", true);
    await game.settings.set(id, "lastUseCompendiums", true);
  }, MODULE_ID);
  if (created.length) await foundry(clientDeletePacks, created.splice(0));
});

async function openWindow(page) {
  await page.evaluate(() => game.modules.get("compendium-json-importer").api.open());
  await page.locator(WIN).waitFor();
}
const choose = (page, name) => page.locator(`${WIN} input[name=sourceFile]`).setInputFiles(fixturePath(name));
const submit = (page) => page.locator(`${WIN} footer button[type=submit]`);

async function fillNewPack(page, label, name) {
  await page.fill(`${WIN} input[name=newPackLabel]`, label);
  await page.locator(`${WIN} input[name=newPackLabel]`).blur();
  await expect(page.locator(`${WIN} input[name=newPackName]`)).not.toHaveValue("");
  await page.fill(`${WIN} input[name=newPackName]`, name);
  await page.locator(`${WIN} input[name=newPackName]`).blur();
  await expect(page.locator(`${WIN} input[name=newPackName]`)).toHaveValue(name);
}

test("speed (1): a taken compendium name shows a message and a button, no analysis starts; the button lets the import go on", async ({ gamePage, foundry }) => {
  const name = uniqueName("taken");
  created.push(name);
  await foundry(clientSeedPack, { name, type: "Item" });
  await openWindow(gamePage);
  await gamePage.selectOption(`${WIN} select[name=typeFilter]`, "items");
  await choose(gamePage, "formats/array.json");
  await fillNewPack(gamePage, "Another label", name);
  const problem = gamePage.locator(`${WIN} .cji-target-problem`);
  await expect(problem).toBeVisible();
  await expect(problem).toContainText(`world.${name}`);
  const button = problem.locator("[data-action=useExistingPack]");
  await expect(button).toBeVisible();
  await gamePage.screenshot({ path: test.info().outputPath("speed1-nom-pris.png") });

  // An observer on the status line: it must never show a progress step
  await gamePage.evaluate(() => {
    window.__statusSeen = [];
    const line = document.querySelector("#compendium-json-importer .cji-status");
    new MutationObserver(() => { if (line.textContent) window.__statusSeen.push(line.textContent); })
      .observe(line, { childList: true, characterData: true, subtree: true, attributes: true });
  });
  await submit(gamePage).click();
  await gamePage.waitForTimeout(1500);
  await expect(gamePage.locator(`${WIN} .cji-summary`)).toBeHidden();
  expect(await gamePage.evaluate(() => window.__statusSeen), "no analysis step shown").toEqual([]);
  expect((await foundry(clientReadPack, `world.${name}`)).length, "nothing written").toBe(0);
  await expect(problem).toBeVisible();

  // "Import into this compendium": the target becomes the existing pack, the problem disappears, the import works
  await button.click();
  await expect(gamePage.locator(`${WIN} select[name=targetPack]`)).toHaveValue(`world.${name}`);
  await expect(gamePage.locator(`${WIN} .cji-target-problem`)).toBeHidden();
  await submit(gamePage).click();
  await expect(gamePage.locator(`${WIN} .cji-summary`)).toBeVisible({ timeout: 60_000 });
  await gamePage.locator(`${WIN} button[data-action=confirmImport]`).click();
  await expect.poll(async () => (await foundry(clientReadPack, `world.${name}`)).length, { timeout: 30_000 }).toBe(3);
  await gamePage.screenshot({ path: test.info().outputPath("speed1-import-dans-existant.png") });
});

test("speed (2): progress is shown during the analysis with the buttons disabled; the review time is recorded (M7)", async ({ gamePage, foundry }) => {
  const times = [];
  for (const run of ["cold", "warm"]) {
    const name = uniqueName(`prog${run}`);
    created.push(name);
    await openWindow(gamePage);
    await gamePage.selectOption(`${WIN} select[name=typeFilter]`, "actors");
    await choose(gamePage, "enrichment/compendium-40.json");
    await fillNewPack(gamePage, `Progress ${name}`, name);
    await gamePage.evaluate(() => {
      window.__seen = [];
      const line = document.querySelector("#compendium-json-importer .cji-status");
      new MutationObserver(() => {
        if (!line.textContent) return;
        // the Cancel button of the analysis (PDF import, C1) is active by design: the others must be disabled
        const buttons = Array.from(document.querySelectorAll("#compendium-json-importer footer button:not([data-action=cancelAnalysis])"));
        window.__seen.push({ text: line.textContent, hidden: line.hidden, allDisabled: buttons.length > 0 && buttons.every((b) => b.disabled) });
      }).observe(line, { childList: true, characterData: true, subtree: true, attributes: true });
    });
    const t0 = Date.now();
    await submit(gamePage).click();
    await expect(gamePage.locator(`${WIN} .cji-summary`)).toBeVisible({ timeout: 120_000 });
    const ms = Date.now() - t0;
    const seen = await gamePage.evaluate(() => window.__seen);
    times.push({ run, ms });
    if (run === "cold") {
      await gamePage.screenshot({ path: test.info().outputPath("speed2-resume.png") });
      expect(seen.some((s) => /^Analy[sz]ing \d+\/\d+/.test(s.text)), JSON.stringify(seen.slice(0, 5))).toBe(true);
      expect(seen.some((s) => /^Reading compendiums/.test(s.text)), "compendium reading step").toBe(true);
      expect(seen.filter((s) => /^(Analy|Reading)/.test(s.text)).every((s) => s.allDisabled && !s.hidden), "buttons disabled while a step is shown").toBe(true);
      evidence("speed2-progression.json", { steps: seen });
    }
    await foundry(async (id) => { await foundry.applications.instances.get(id)?.close(); }, MODULE_ID);
  }
  evidence("M7-revue-fenetre.json", { file: "enrichment/compendium-40.json", runs: times });
  test.info().annotations.push({ type: "M7 review", description: times.map((x) => `${x.run} ${x.ms} ms`).join(" | ") });
});

test("speed (3): a broken file shows an error in the window, the form is usable again and a valid file then goes through", async ({ gamePage }) => {
  const name = uniqueName("recover");
  created.push(name);
  await openWindow(gamePage);
  await gamePage.selectOption(`${WIN} select[name=typeFilter]`, "items");
  await choose(gamePage, "formats/broken.json");
  await fillNewPack(gamePage, `Recover ${name}`, name);
  await submit(gamePage).click();
  const status = gamePage.locator(`${WIN} .cji-status.cji-error`);
  await expect(status).toBeVisible();
  await expect(status).not.toHaveText("");
  await expect(gamePage.locator(`${WIN} .cji-summary`)).toBeHidden();
  await expect(submit(gamePage)).toBeEnabled();
  await gamePage.screenshot({ path: test.info().outputPath("speed3-erreur.png") });
  await choose(gamePage, "formats/array.json");
  await submit(gamePage).click();
  await expect(gamePage.locator(`${WIN} .cji-summary`)).toBeVisible({ timeout: 60_000 });
  await expect(gamePage.locator(`${WIN} .cji-status.cji-error`)).toBeHidden();
});

test("speed (4): the index cache is reused, read without request, dropped on a pack change, and a disabled source is no longer consulted", async ({ foundry }) => {
  const out = await foundry(async ({ id, entries }) => {
    const mod = await import(`/modules/${id}/scripts/foundry/enrichment.mjs`);
    const res = {};
    // spy on the requests of two sources
    const spies = {};
    for (const pack of ["dnd5e.spells24", "dnd5e.equipment24"]) {
      const p = game.packs.get(pack);
      const original = p.getIndex.bind(p);
      spies[pack] = { n: 0, original };
      p.getIndex = (...args) => { spies[pack].n++; return original(...args); };
    }
    try {
      mod.invalidateIndexes();
      const first = mod.preloadIndexes();
      res.sameWhileCached = first === mod.preloadIndexes();
      const r1 = await first;
      res.sources = r1.order.length;
      res.requests = Object.fromEntries(Object.entries(spies).map(([k, v]) => [k, v.n]));
      res.hasSpells24 = r1.indexes.has("dnd5e.spells24");
      Hooks.callAll("updateCompendium");
      res.refreshedAfterUpdate = mod.preloadIndexes() !== first;
      // a source switched off: new read without it, and the analysis no longer takes from it
      await game.settings.set(id, "compendiumSources", [{ pack: "dnd5e.spells24", enabled: false }]);
      const off = await mod.preloadIndexes();
      res.disabledOrderHasSpells24 = off.order.includes("dnd5e.spells24");
      res.disabledIndexHasSpells24 = off.indexes.has("dnd5e.spells24");
      const r = await game.modules.get(id).api.analyze(entries, "Actor", { enrich: true, compendiums: true });
      const uuids = r.accepted.flatMap((a) => (a.enrichment.items ?? []).map((i) => i.uuid)).filter(Boolean);
      res.uuidsFromDisabled = uuids.filter((u) => u.startsWith("Compendium.dnd5e.spells24.")).length;
      res.uuidsTotal = uuids.length;
      return res;
    } finally {
      for (const [k, v] of Object.entries(spies)) game.packs.get(k).getIndex = v.original;
      await game.settings.set(id, "compendiumSources", []);
      mod.invalidateIndexes();
    }
  }, { id: MODULE_ID, entries: JSON.parse((await import("node:fs")).readFileSync(fixturePath("enrichment/compendium-40.json"), "utf8")) });
  evidence("speed4-cache-index.json", out);
  expect(out.sameWhileCached).toBe(true);
  expect(out.hasSpells24).toBe(true);
  expect(out.requests, "the index is read without request when the pack already holds it").toEqual({ "dnd5e.spells24": 0, "dnd5e.equipment24": 0 });
  expect(out.refreshedAfterUpdate).toBe(true);
  expect(out.disabledOrderHasSpells24).toBe(false);
  expect(out.disabledIndexHasSpells24).toBe(false);
  expect(out.uuidsTotal).toBeGreaterThan(0);
  expect(out.uuidsFromDisabled).toBe(0);
});

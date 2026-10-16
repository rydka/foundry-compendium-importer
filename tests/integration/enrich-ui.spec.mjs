// UI-level criteria of activity-enrichment: C1 (checkbox), C14 / C23 (summary), C16 (window = API), C17 (EN / FR),
// C24 (sources window and the "use compendiums" checkbox). Captures are named by criterion.
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, waitForGame } from "../../../../test-env/fixtures.mjs";
import { MODULE_ID, clientDeletePacks, clientReadPack, evidence, fixturePath, uniqueName } from "./helpers.mjs";
import { itemTokens } from "../support/canon.mjs";

test.describe.configure({ timeout: 300_000 });

const WIN = "#compendium-json-importer";
const ROOT = new URL("../../", import.meta.url);
const OUT_FILE = (name) => path.join(new URL("tools/out/", ROOT).pathname.replace(/^\/(\w:)/, "$1"), name);
const LIB_LANG = (code) => JSON.parse(readFileSync(new URL(`../../../dnd5e-text-parser/lang/${code}.json`, import.meta.url), "utf8"));
const lang = (code) => JSON.parse(readFileSync(new URL(`../../lang/${code}.json`, import.meta.url), "utf8"))[MODULE_ID];
const created = [];

test.afterEach(async ({ foundry }) => {
  await foundry(async (id) => {
    await foundry.applications.instances.get(id)?.close();
    await foundry.applications.instances.get(`${id}-sources`)?.close();
    await game.settings.set(id, "lastEnrich", true);
    await game.settings.set(id, "lastUseCompendiums", true);
    await game.settings.set(id, "compendiumSources", []);
  }, MODULE_ID);
  if (created.length) await foundry(clientDeletePacks, created.splice(0));
});

async function openWindow(page) {
  await page.evaluate(() => game.modules.get("compendium-json-importer").api.open());
  await page.locator(WIN).waitFor();
}
const choose = (page, file) => page.locator(`${WIN} input[name=sourceFile]`).setInputFiles(file);

async function fillNewPack(page, label, name) {
  await page.fill(`${WIN} input[name=newPackLabel]`, label);
  await page.locator(`${WIN} input[name=newPackLabel]`).blur();
  await expect(page.locator(`${WIN} input[name=newPackName]`)).not.toHaveValue("");
  await page.fill(`${WIN} input[name=newPackName]`, name);
  await page.locator(`${WIN} input[name=newPackName]`).blur();
  await expect(page.locator(`${WIN} input[name=newPackName]`)).toHaveValue(name);
}

/** Opens the window on a file and runs the analysis; returns the pack name. */
async function analyzeFile(page, { filter, file }) {
  const name = uniqueName("enrich");
  created.push(name);
  await openWindow(page);
  await page.selectOption(`${WIN} select[name=typeFilter]`, filter);
  await choose(page, file);
  await fillNewPack(page, `Enrich ${name}`, name);
  await page.locator(`${WIN} footer button[type=submit]`).click();
  await expect(page.locator(`${WIN} .cji-summary`)).toBeVisible({ timeout: 90_000 });
  return name;
}

const RAW_KEY = /\b(?:compendium-json-importer|dnd5e-text-parser)\.(?:Enrich|Describe|Note|Options|Summary)\b/;

// ---------------------------------------------------------------- C1

test("C1: the window shows the checkbox, ticked by default, remembered, and unticked gives the plain analysis", async ({ gamePage, foundry }) => {
  const t = lang("en");
  await openWindow(gamePage);
  const box = gamePage.locator(`${WIN} input[name=enrich]`);
  await expect(box).toBeVisible();
  await expect(box).toBeChecked();
  await expect(gamePage.locator(`${WIN}`)).toContainText(t.Options.Enrich);
  await expect(gamePage.locator(`${WIN} input[name=useCompendiums]`)).toBeChecked();
  await gamePage.screenshot({ path: test.info().outputPath("C1-case-completer-activites.png") });

  // C24: the compendium box depends on the enrichment box
  await box.uncheck();
  await expect(gamePage.locator(`${WIN} input[name=useCompendiums]`)).toBeDisabled();
  await gamePage.screenshot({ path: test.info().outputPath("C24-case-compendiums-grisee.png") });

  // unticked: the analysis has no enrichment section and its counts are those of the API without the option
  await gamePage.selectOption(`${WIN} select[name=typeFilter]`, "items");
  await choose(gamePage, OUT_FILE("items.json"));
  const name = uniqueName("c1");
  created.push(name);
  await fillNewPack(gamePage, `C1 ${name}`, name);
  await gamePage.locator(`${WIN} footer button[type=submit]`).click();
  await expect(gamePage.locator(`${WIN} .cji-summary`)).toBeVisible({ timeout: 90_000 });
  const counts = await gamePage.locator(`${WIN} .cji-counts li`).allTextContents();
  expect(await gamePage.locator(`${WIN} .cji-enrich`).count()).toBe(0);
  expect(counts.join(" ")).not.toContain(t.Enrich.Title);
  await gamePage.screenshot({ path: test.info().outputPath("C1-resume-sans-enrichissement.png") });
  const api = await foundry(async (entries) => {
    const r = await game.modules.get("compendium-json-importer").api.analyze(entries, "Item", {});
    return { accepted: r.accepted.length, enrichment: r.enrichment ?? null };
  }, JSON.parse(readFileSync(OUT_FILE("items.json"), "utf8")));
  expect(api.enrichment).toBeNull();
  expect(counts.some((c) => c.includes(String(api.accepted)))).toBe(true);

  // remembered
  await foundry((id) => foundry.applications.instances.get(id).close(), MODULE_ID);
  await openWindow(gamePage);
  await expect(gamePage.locator(`${WIN} input[name=enrich]`)).not.toBeChecked();
  await gamePage.screenshot({ path: test.info().outputPath("C1-choix-memorise.png") });
  evidence("C1-fenetre.json", { counts, apiAccepted: api.accepted, enrichSettingAfterReopen: await foundry((id) => game.settings.get(id, "lastEnrich"), MODULE_ID) });
});

// ---------------------------------------------------------------- C14 / C23

test("C14/C23: the summary lists counts, one readable line per added field, the compendium items and the ambiguities", async ({ gamePage }) => {
  await analyzeFile(gamePage, { filter: "actors", file: OUT_FILE("actors.json") });
  const t = lang("en");
  const counts = await gamePage.locator(`${WIN} .cji-counts li`).allTextContents();
  const text = await gamePage.locator(`${WIN} .cji-summary`).innerText();
  await gamePage.screenshot({ path: test.info().outputPath("C14-resume-actors.png") });
  const details = gamePage.locator(`${WIN} .cji-enrich details`);
  expect(await details.count()).toBeGreaterThan(5);
  await details.first().evaluate((d) => { d.open = true; });
  await gamePage.screenshot({ path: test.info().outputPath("C14-resume-un-acteur-deplie.png") });
  const lines = await gamePage.locator(`${WIN} .cji-enrich li`).allTextContents();
  evidence("C14-lignes-du-resume.json", { counts, lines: lines.slice(0, 80), details: await details.count() });
  expect(counts.join(" | ")).toMatch(/\d/);
  expect(counts.some((c) => c.includes(t.Enrich.Enriched.replace("{count}", "")))).toBe(true);
  expect(RAW_KEY.test(text), "no raw translation key in the summary").toBe(false);
  expect(lines.some((l) => /Slam/.test(l) || /\+6/.test(l))).toBe(true);
});

test("C23: compendium-40 summary names the compendium, the adjusted values, the text-built items and the ambiguity", async ({ gamePage }) => {
  await analyzeFile(gamePage, { filter: "actors", file: fixturePath("enrichment/compendium-40.json") });
  const t = lang("en");
  await gamePage.locator(`${WIN} .cji-enrich details`).evaluateAll((ds) => ds.forEach((d) => { d.open = true; }));
  const text = await gamePage.locator(`${WIN} .cji-summary`).innerText();
  await gamePage.screenshot({ path: test.info().outputPath("C23-resume-correspondances.png"), fullPage: false });
  evidence("C23-texte-du-resume.txt", text);
  expect(text).toContain(t.Enrich.FromCompendium);
  expect(text).toMatch(/Spells|Equipment|Monster Features/);
  expect(text).toContain("Torch");
  expect(text).toContain(t.Enrich.Ambiguous.replace(/[:：]\s*$/, "").trim());
  expect(RAW_KEY.test(text)).toBe(false);
});

// ---------------------------------------------------------------- C24

test("C24: the import window can switch the compendiums off for one import", async ({ gamePage }) => {
  await openWindow(gamePage);
  await gamePage.setChecked(`${WIN} input[name=useCompendiums]`, false);
  await gamePage.selectOption(`${WIN} select[name=typeFilter]`, "actors");
  await choose(gamePage, fixturePath("enrichment/compendium-40.json"));
  const name = uniqueName("c24");
  created.push(name);
  await fillNewPack(gamePage, `C24 ${name}`, name);
  await gamePage.locator(`${WIN} footer button[type=submit]`).click();
  await expect(gamePage.locator(`${WIN} .cji-summary`)).toBeVisible({ timeout: 90_000 });
  await gamePage.locator(`${WIN} .cji-enrich details`).evaluateAll((ds) => ds.forEach((d) => { d.open = true; }));
  const text = await gamePage.locator(`${WIN} .cji-summary`).innerText();
  await gamePage.screenshot({ path: test.info().outputPath("C24-import-sans-compendiums.png") });
  expect(text).not.toContain(lang("en").Enrich.FromCompendium);
});

test("C24: the sources window lists the item compendiums; ticking, unticking and reordering are saved", async ({ gamePage, foundry }) => {
  await foundry(async () => {
    const menu = game.settings.menus.get("compendium-json-importer.sources");
    await new menu.type().render({ force: true });
  });
  const win = gamePage.locator("#compendium-json-importer-sources");
  await win.waitFor();
  const rows = win.locator(".cji-source-list li");
  expect(await rows.count()).toBeGreaterThan(5);
  const firstPack = await rows.first().locator("input[name=enabled]").getAttribute("value");
  await gamePage.screenshot({ path: test.info().outputPath("C24-fenetre-sources.png") });
  // default: character option packs are excluded
  const classes = win.locator("input[name=enabled][value='dnd5e.classes']");
  if (await classes.count()) await expect(classes).not.toBeChecked();
  // untick the first pack, move the second one up
  await rows.first().locator("input[name=enabled]").uncheck();
  const secondPack = await rows.nth(1).locator("input[name=enabled]").getAttribute("value");
  await rows.nth(1).locator("[data-action=moveUp]").click();
  await expect(win.locator(".cji-source-list li").first().locator("input[name=enabled]")).toHaveAttribute("value", secondPack);
  await gamePage.screenshot({ path: test.info().outputPath("C24-sources-modifiees.png") });
  await win.locator("button[type=submit]").click();
  await expect(win).toHaveCount(0);
  const saved = await foundry((id) => game.settings.get(id, "compendiumSources"), MODULE_ID);
  evidence("C24-reglage-enregistre.json", { firstPackBefore: firstPack, secondPack, saved: saved.slice(0, 6) });
  expect(saved[0].pack).toBe(secondPack);
  expect(saved.find((s) => s.pack === firstPack).enabled).toBe(false);
  // reopened: the choice is shown
  await foundry(async () => { await new (game.settings.menus.get("compendium-json-importer.sources").type)().render({ force: true }); });
  const again = gamePage.locator("#compendium-json-importer-sources");
  await again.waitFor();
  await expect(again.locator(".cji-source-list li").first().locator("input[name=enabled]")).toHaveAttribute("value", secondPack);
  await expect(again.locator(`input[name=enabled][value='${firstPack}']`)).not.toBeChecked();
});

// ---------------------------------------------------------------- C16

test("C16: the window and api.analyze(entries, type, { enrich: true }) give the same documents", async ({ gamePage, foundry }) => {
  const file = OUT_FILE("items.json");
  const name = await analyzeFile(gamePage, { filter: "items", file });
  await gamePage.locator(`${WIN} button[data-action=confirmImport]`).click();
  await expect(gamePage.locator(".notification").first()).toBeVisible({ timeout: 90_000 });
  await expect.poll(async () => (await foundry(clientReadPack, `world.${name}`))?.length ?? 0, { timeout: 90_000 }).toBeGreaterThan(80);
  const imported = await foundry(clientReadPack, `world.${name}`);
  const viaApi = await foundry(async (entries) => {
    const r = await game.modules.get("compendium-json-importer").api.analyze(entries, "Item", { enrich: true });
    return { counts: r.enrichment.counts, docs: r.accepted.map((a) => a.data) };
  }, JSON.parse(readFileSync(file, "utf8")));
  // names are not unique (several "Slam"): compare the multisets of "name | facts"
  // a weapon range is read back as `reach` or `range` depending on the weapon type once stored (dnd5e): compared as one distance
  const sig = (docs) => docs.map((d) => `${d.name} | ${itemTokens(d).map((t) => t.replace(/^range=(reach|range) /, "range=")).sort().join(" ; ")}`).sort();
  const a = sig(imported), b = sig(viaApi.docs);
  const differing = a.map((x, i) => (x === b[i] ? null : { window: x, api: b[i] })).filter(Boolean);
  evidence("C16-fenetre-vs-api.json", { imported: imported.length, api: viaApi.docs.length, counts: viaApi.counts, differing });
  expect(imported.length).toBe(viaApi.docs.length);
  expect(differing).toEqual([]);
  expect(a.some((x) => x.includes("attack="))).toBe(true);
});

// ---------------------------------------------------------------- C17

for (const code of ["fr", "en"]) {
  test(`C17: checkbox, summary and enrichment remarks are in ${code}`, async ({ gamePage, foundry }) => {
    const t = lang(code);
    const lib = LIB_LANG(code)["dnd5e-text-parser"];
    await foundry((l) => game.settings.set("core", "language", l), code);
    try {
      await gamePage.reload();
      await waitForGame(gamePage);
      expect(await foundry(() => game.i18n.lang)).toBe(code);
      await analyzeFile(gamePage, { filter: "actors", file: OUT_FILE("actors.json") });
      await gamePage.locator(`${WIN} .cji-enrich details`).evaluateAll((all) => all.forEach((d) => { d.open = true; }));
      const text = await gamePage.locator(WIN).innerText();
      await gamePage.screenshot({ path: test.info().outputPath(`C17-resume-${code}.png`) });
      const optionsText = t.Options.Enrich;
      // the checkbox lives in the options part, still in the DOM after the analysis
      const optionsLabel = await gamePage.locator(`${WIN} fieldset.cji-section label`, { hasText: optionsText }).count();
      expect(optionsLabel + (text.includes(optionsText) ? 1 : 0)).toBeGreaterThan(0);
      expect(text).toContain(t.Enrich.Title);
      expect(RAW_KEY.test(text)).toBe(false);
      // a sentence of the library (attack line) in this language
      const sample = (lib.Describe.Attack ?? "").split("{")[0].trim();
      evidence(`C17-${code}.json`, { title: t.Enrich.Title, optionsLabel: optionsText, librarySamplePrefix: sample, textStart: text.slice(0, 600) });
      if (sample) expect(text).toContain(sample);
      if (code === "fr") {
        // The sentences of the module in French: the first item block (as before). Later blocks quote the English source
        // text of the file on purpose ("Phrase non reconnue : ...", the "not automated" list), which is not a module sentence.
        const first = await gamePage.locator(`${WIN} .cji-enrich details`).first().evaluate((d) => { const c = d.cloneNode(true); c.querySelectorAll(".cji-not-automated").forEach((n) => n.remove()); return c.textContent; });
        const own = first.replace(/Phrase non reconnue : [^.]*./g, "");
        const hit = /.{0,80}(Melee Weapon Attack|Hit:|saving throw).{0,80}/.exec(own);
        expect(hit?.[0] ?? null).toBeNull();
      }
    } finally {
      await foundry((l) => game.settings.set("core", "language", l), "en");
      if (code !== "en") {
        await gamePage.reload();
        await waitForGame(gamePage);
      }
    }
  });
}

// ---------------------------------------------------------------- C1 / C17 : files of translations

test("C17: the English and French translations of the module have the same keys, including the enrichment ones", async () => {
  const flat = (o, p = "") => Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" ? flat(v, `${p}${k}.`) : [`${p}${k}`]));
  const en = flat(lang("en")).sort(), fr = flat(lang("fr")).sort();
  evidence("C17-cles.json", { en: en.length, fr: fr.length, onlyEn: en.filter((k) => !fr.includes(k)), onlyFr: fr.filter((k) => !en.includes(k)) });
  expect(fr).toEqual(en);
  expect(en.some((k) => k.startsWith("Enrich."))).toBe(true);
});

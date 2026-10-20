/* global document */
// PDF import: size and page limits, the file field while reading, closing the window during the reading,
// stat blocks over two pages (imported whole, or reported when cut), text that looks like enrichers.
import path from "node:path";
import { expect, test } from "../../../../test-env/fixtures.mjs";
import { clientDeletePacks, clientSnapshot, evidence, uniqueName } from "./helpers.mjs";
import {
  BETTER_UNDEAD_PDF, SYNTHETIC, WIN, analyze, chooseFile, fillNewPack, hasBetterUndead, importPdfDoc, openWindow, readLang,
  startStatusSampler, startWorkerProbe, stopWorkerProbe, syntheticFile, watchConsole, workerCounts
} from "./pdf-helpers.mjs";
import { commonFromSpec, nameKey, scoreEntries, readActor } from "../support/score.mjs";
import { containsFingerprint } from "../support/fingerprint.mjs";
import { expectedOfDoc, loadDoc } from "../support/synth.mjs";

const MODULE = "compendium-json-importer";
const en = readLang("en");
const created = [];
const doc = (name) => loadDoc(path.join(SYNTHETIC, `${name}.json`));
const prefix = (text) => text.split("{")[0].trim().slice(0, 24);

test.afterEach(async ({ foundry }) => {
  await foundry(async (id) => {
    await foundry.applications.instances.get(id)?.close();
    await game.settings.set(id, "pdfMaxSizeMb", 500);
    await game.settings.set(id, "pdfMaxPages", 400);
  }, MODULE);
  if (created.length) await foundry(clientDeletePacks, created.splice(0));
});

async function prepare(page, { name }) {
  await openWindow(page);
  await page.selectOption(`${WIN} select[name=typeFilter]`, "actors");
  const pack = uniqueName(name);
  created.push(pack);
  return pack;
}

test.describe("limits", () => {
  test("a PDF with more pages than pdfMaxPages is refused with a clear message, nothing is imported", async ({ gamePage, foundry }, testInfo) => {
    await foundry((id) => game.settings.set(id, "pdfMaxPages", 1), MODULE);
    const pack = await prepare(gamePage, { name: "lim-pages" });
    await chooseFile(gamePage, await syntheticFile("ref-2014-fr")); // 2 pages
    await fillNewPack(gamePage, `L ${pack}`, pack);
    const before = await foundry(clientSnapshot);
    await analyze(gamePage);
    await expect(gamePage.locator("body")).toContainText(prefix(en.Error.Pdf.tooManyPages), { timeout: 20_000 });
    await expect(gamePage.locator("body")).toContainText("limit of 1");
    await expect(gamePage.locator(`${WIN} footer button[type=submit]`)).toBeEnabled();
    await gamePage.screenshot({ path: testInfo.outputPath("L-trop-de-pages.png") });
    expect(await foundry(clientSnapshot)).toEqual(before);
  });

  test("a PDF larger than pdfMaxSizeMb is refused before it is read", async ({ gamePage, foundry }, testInfo) => {
    await foundry((id) => game.settings.set(id, "pdfMaxSizeMb", 0.005), MODULE);
    const pack = await prepare(gamePage, { name: "lim-size" });
    await chooseFile(gamePage, await syntheticFile("ref-2014-fr"));
    await fillNewPack(gamePage, `L ${pack}`, pack);
    const before = await foundry(clientSnapshot);
    await startWorkerProbe(gamePage);
    await analyze(gamePage);
    await expect(gamePage.locator("body")).toContainText(prefix(en.Error.Pdf.tooLarge), { timeout: 20_000 });
    await expect(gamePage.locator(`${WIN} footer button[type=submit]`)).toBeEnabled();
    const workers = await workerCounts(gamePage);
    await stopWorkerProbe(gamePage);
    await gamePage.screenshot({ path: testInfo.outputPath("L-trop-gros.png") });
    evidence("L-trop-gros.json", { workers });
    expect(workers.created, "refused before any Worker is started").toBe(0);
    expect(await foundry(clientSnapshot)).toEqual(before);
  });

  test("0 means no limit", async ({ gamePage, foundry }) => {
    await foundry(async (id) => { await game.settings.set(id, "pdfMaxSizeMb", 0); await game.settings.set(id, "pdfMaxPages", 0); }, MODULE);
    const { docs } = await importPdfDoc(gamePage, foundry, created, { file: "ref-2014-fr", filter: "actors", name: "lim-zero", want: 2 });
    expect(docs).toHaveLength(2);
  });
});

test.describe("closing and the file field (Better Undead, CPU slowed to keep the reading going)", () => {
  test.skip(!hasBetterUndead(), "Better Undead Compendium.pdf is not on this machine");
  test.setTimeout(120_000);

  async function startSlowReading(page) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 6 });
    await startStatusSampler(page);
    await analyze(page);
    await page.waitForFunction(() => /\d+\s*\/\s*35/.test(document.querySelector("#compendium-json-importer .cji-status")?.textContent ?? ""), null, { timeout: 30_000, polling: 10 });
    return cdp;
  }

  test("the file field is disabled while the PDF is read and enabled again after a cancel", async ({ gamePage, foundry }) => {
    const pack = await prepare(gamePage, { name: "close-field" });
    await chooseFile(gamePage, BETTER_UNDEAD_PDF);
    await fillNewPack(gamePage, `F ${pack}`, pack);
    const before = await foundry(clientSnapshot);
    const cdp = await startSlowReading(gamePage);
    const during = await gamePage.locator(`${WIN} input[name=sourceFile]`).isDisabled();
    await gamePage.locator(`${WIN} [data-action=cancelAnalysis]`).click();
    await expect(gamePage.locator(`${WIN} footer button[type=submit]`)).toBeEnabled({ timeout: 20_000 });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    const after = await gamePage.locator(`${WIN} input[name=sourceFile]`).isDisabled();
    evidence("F-champ-fichier.json", { disabledDuringReading: during, disabledAfterCancel: after });
    expect(during).toBe(true);
    expect(after).toBe(false);
    expect(await foundry(clientSnapshot)).toEqual(before);
  });

  for (const how of ["app.close()", "the close button of the window"]) {
    test(`closing the window (${how}) during the reading cancels it: Worker terminated, nothing written, no error`, async ({ gamePage, foundry }, testInfo) => {
      const con = watchConsole(gamePage);
      await startWorkerProbe(gamePage);
      const pack = await prepare(gamePage, { name: "close-read" });
      await chooseFile(gamePage, BETTER_UNDEAD_PDF);
      await fillNewPack(gamePage, `C ${pack}`, pack);
      const before = await foundry(clientSnapshot);
      const cdp = await startSlowReading(gamePage);
      const creating = await workerCounts(gamePage);
      const t0 = Date.now();
      if (how === "app.close()") await foundry(async (id) => { await foundry.applications.instances.get(id).close(); }, MODULE);
      else await gamePage.locator(`${WIN} .window-header [data-action=close]`).click();
      await expect(gamePage.locator(WIN)).toHaveCount(0, { timeout: 5000 });
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
      await expect.poll(async () => (await workerCounts(gamePage)).alive, { timeout: 5000 }).toBe(0);
      const ms = Date.now() - t0;
      const api = await foundry(() => game.modules.get("compendium-json-importer").api.pdfWorkerCount?.());
      await gamePage.waitForTimeout(1500); // a reading that went on would end in a review or an error by now
      const reappeared = await gamePage.evaluate(() => document.querySelector("#compendium-json-importer") !== null);
      await stopWorkerProbe(gamePage);
      evidence(`F-fermeture-${how.startsWith("app") ? "api" : "bouton"}.json`, { workersBefore: creating, msToNoWorker: ms, apiPdfWorkerCount: api, windowReappeared: reappeared, console: con.logs });
      await gamePage.screenshot({ path: testInfo.outputPath("F-fermeture.png") });
      expect(creating.created).toBeGreaterThanOrEqual(1);
      expect(api ?? 0, "api.pdfWorkerCount()").toBe(0);
      expect(reappeared, "the window does not come back after the reading").toBe(false);
      expect(await foundry(clientSnapshot), "nothing created").toEqual(before);
      expect(con.logs.filter((l) => !/Failed to load resource/.test(l)), "no error").toEqual([]);
      // a new window starts from the form
      await openWindow(gamePage);
      await expect(gamePage.locator(`${WIN} footer button[type=submit]`)).toBeEnabled();
    });
  }
});

test.describe("a stat block over two pages", () => {
  for (const file of ["ref-span-2col", "ref-span-1col"]) {
    test(`${file}: imported whole, with every ability and its exact text`, async ({ gamePage, foundry }, testInfo) => {
      const want = expectedOfDoc(doc(file)).creatures[0];
      const { docs, reviewText } = await importPdfDoc(gamePage, foundry, created, { file, filter: "actors", name: file });
      evidence(`S-${file}-revue.txt`, reviewText);
      await gamePage.screenshot({ path: testInfo.outputPath(`S-${file}.png`) });
      expect(docs.map((d) => d.name)).toEqual([want.name]);
      const htmls = docs[0].items.map((i) => i.system.description.value);
      const missing = want.entries.filter((e) => !htmls.some((h) => containsFingerprint(h, { sha1: e.sha1, length: e.length })));
      expect(missing.map((e) => e.name), "entries whose text is not the one of the book").toEqual([]);
      expect(docs[0].items.length).toBe(want.entries.length);
      expect(await gamePage.locator(`${WIN} .cji-pdf-problems li`).count()).toBe(0);
    });
  }

  test("blockCut: a block cut short and not continued is listed in the review with its name and page, and the creature is imported anyway", async ({ gamePage, foundry }, testInfo) => {
    const { reviewText, docs } = await importPdfDoc(gamePage, foundry, created, { file: "ref-span-cut", filter: "actors", name: "span-cut" });
    evidence("S-cut-revue.txt", reviewText);
    await gamePage.screenshot({ path: testInfo.outputPath("S-bloc-coupe.png") });
    expect(reviewText).toContain("Cut Bearer");
    expect(reviewText).toMatch(/p. 1/);
    expect(reviewText).toContain(prefix(en.Pdf.Reason.blockCut));
    expect(docs.map((d) => d.name)).toEqual(["Cut Bearer"]);
    evidence("S-cut-acteur.json", { items: docs[0].items.map((i) => i.name) });
    expect(docs[0].items.length).toBeGreaterThan(0);
  });

  test("blockCut is listed in .cji-pdf-problems with the name and the page", async ({ gamePage, foundry }) => {
    await importPdfDoc(gamePage, foundry, created, { file: "ref-span-cut", filter: "actors", name: "span-cut2", confirmImport: false });
    const lines = await gamePage.locator(`${WIN} .cji-pdf-problems li`).allInnerTexts();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/Cut Bearer/);
    expect(lines[0]).toMatch(/p. 1/);
  });

  test("an attack entry cut over the page break still gets its attack activity (enrichment on)", async ({ gamePage, foundry }, testInfo) => {
    const { docs } = await importPdfDoc(gamePage, foundry, created, { file: "ref-attack-span", filter: "actors", name: "atk-span", enrich: true });
    await gamePage.screenshot({ path: testInfo.outputPath("G-attaque-a-cheval.png") });
    const swing = docs[0].items.find((i) => i.name === "Lantern Swing");
    const acts = Object.values(swing.system.activities ?? {});
    evidence("G-activites.json", acts.map((a) => ({ type: a.type, attack: a.attack, damage: a.damage })));
    expect(acts.some((a) => a.type === "attack"), "an attack activity").toBe(true);
    const parts = acts.flatMap((a) => (a.damage?.parts ?? []));
    expect(JSON.stringify(parts), "the damage written on the second page is read").toMatch(/1d10|10/);
  });
});

test.describe("text that looks like Foundry enrichers stays text", () => {
  test("in the stored descriptions of a creature and of an item: no @UUID, no [[/r]] left to execute", async ({ gamePage, foundry }, testInfo) => {
    const wantActor = expectedOfDoc(doc("ref-enrichers")).creatures[0];
    const a = await importPdfDoc(gamePage, foundry, created, { file: "ref-enrichers", filter: "actors", name: "enr-a" });
    const i = await importPdfDoc(gamePage, foundry, created, { file: "ref-enrichers", filter: "items", name: "enr-i" });
    const htmls = [...a.docs[0].items.map((x) => x.system.description.value), ...i.docs.map((x) => x.system.description.value)];
    const rendered = await foundry(async (list) => {
      const out = [];
      for (const html of list) {
        const el = document.createElement("div");
        el.innerHTML = await foundry.applications.ux.TextEditor.implementation.enrichHTML(html);
        out.push({ links: el.querySelectorAll("a.content-link, a.inline-roll, [data-uuid]").length, text: el.textContent });
      }
      return out;
    }, htmls);
    evidence("E-enrichers.json", { stored: htmls.filter((h) => /UUID|\/r/.test(h)), rendered: rendered.filter((r) => /UUID|\/r/.test(r.text)) });
    await gamePage.screenshot({ path: testInfo.outputPath("E-enrichers.png") });
    for (const h of htmls) {
      expect(h).not.toMatch(/@\w+\[/);
      expect(h).not.toContain("[[");
    }
    expect(rendered.reduce((n, r) => n + r.links, 0), "links or inline rolls created by the enrichers").toBe(0);
    expect(rendered.some((r) => r.text.includes("@UUID[Compendium.dnd5e.spells.Item.abcdef123456]{Fireball}")), "the text is shown as written").toBe(true);
    expect(rendered.some((r) => r.text.includes("[[/r 2d6]]"))).toBe(true);
    const s = scoreEntries(readActor({ ...a.docs[0], items: a.docs[0].items }), commonFromSpec(wantActor));
    expect(s.missing).toEqual([]);
    expect(nameKey(a.docs[0].name)).toBe(nameKey(wantActor.name));
    expect(i.docs.map((x) => x.name)).toEqual(["Quill of Marginalia"]);
  });
});

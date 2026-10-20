// PDF import, window flows: C1 (progress, no external server, cancel), C4 (review lists the problems), C7 (scanned,
// invalid), C8 (a .json after a .pdf in the same window), partial import, type of the target.
// Better Undead Compendium.pdf (212 MB, local) is used where noted; those tests are skipped when it is absent.
import { expect, test } from "../../../../test-env/fixtures.mjs";
import { clientDeletePacks, clientReadPack, clientSnapshot, evidence, fixturePath, uniqueName } from "./helpers.mjs";
import {
  BETTER_UNDEAD_PDF, WIN, analyze, chooseFile, confirm, fillNewPack, hasBetterUndead, openWindow, readLang, readStatuses,
  startStatusSampler, startWorkerProbe, stopWorkerProbe, syntheticFile, watchConsole, watchExternalRequests, workerCounts
} from "./pdf-helpers.mjs";

const created = [];
const en = readLang("en");

test.afterEach(async ({ foundry }) => {
  await foundry(async (id) => { await foundry.applications.instances.get(id)?.close(); }, "compendium-json-importer");
  if (created.length) await foundry(clientDeletePacks, created.splice(0));
});

async function prepare(page, { filter, name }) {
  await openWindow(page);
  await page.selectOption(`${WIN} select[name=typeFilter]`, filter);
  const pack = uniqueName(name);
  created.push(pack);
  return pack;
}

test("C1: a .pdf is accepted by the file field", async ({ gamePage }) => {
  await openWindow(gamePage);
  const accept = await gamePage.locator(`${WIN} input[name=sourceFile]`).getAttribute("accept");
  expect(accept).toMatch(/\.pdf/);
  expect(accept).toMatch(/\.json/);
  await chooseFile(gamePage, await syntheticFile("ref-2014-en"));
  await expect(gamePage.locator(`${WIN} .cji-file-name`)).toHaveText("ref-2014-en.pdf");
});

test.describe("Better Undead Compendium.pdf (35 pages)", () => {
  test.skip(!hasBetterUndead(), "Better Undead Compendium.pdf is not on this machine");
  test.setTimeout(180_000);

  test("C1: progress by page, no request outside Foundry, window usable, worker terminated", async ({ gamePage }, testInfo) => {
    const net = watchExternalRequests(gamePage, testInfo.project.use.baseURL ?? "http://localhost:30013");
    const con = watchConsole(gamePage);
    await startWorkerProbe(gamePage);
    const pack = await prepare(gamePage, { filter: "actors", name: "c1-bu" });
    await chooseFile(gamePage, BETTER_UNDEAD_PDF);
    await fillNewPack(gamePage, `C1 ${pack}`, pack);
    await startStatusSampler(gamePage);
    await analyze(gamePage);
    await expect(gamePage.locator(`${WIN} .cji-summary`)).toBeVisible({ timeout: 120_000 });

    const statuses = await readStatuses(gamePage);
    const pageValues = new Set(statuses.map((s) => /(\d+)\s*\/\s*35\b/.exec(s)?.[1]).filter(Boolean));
    const workers = await workerCounts(gamePage);
    await stopWorkerProbe(gamePage);
    evidence("C1-progression.json", { statuses, distinctPageValues: [...pageValues], workers, externalRequests: net.urls, consoleAttributed: con.attributed() });
    await gamePage.screenshot({ path: testInfo.outputPath("C1-revue-better-undead.png") });

    expect(pageValues.size, `distinct "n/35" values in ${JSON.stringify(statuses)}`).toBeGreaterThanOrEqual(3);
    expect(net.stop(), "requests to another origin").toEqual([]);
    expect(workers.created, "the PDF is read in a Web Worker").toBeGreaterThanOrEqual(1);
    expect(workers.alive, "no Worker left alive after the analysis").toBe(0);
    expect(con.attributed()).toEqual([]);
  });

  test("C1: cancel during the reading returns to the form within a second, writes nothing", async ({ gamePage, foundry }, testInfo) => {
    const con = watchConsole(gamePage);
    await startWorkerProbe(gamePage);
    const pack = await prepare(gamePage, { filter: "actors", name: "c1-cancel" });
    await chooseFile(gamePage, BETTER_UNDEAD_PDF);
    await fillNewPack(gamePage, `C1 cancel ${pack}`, pack);
    const before = await foundry(clientSnapshot);

    // Reading takes ~0.8 s on this machine: slow the CPU down so that the cancel lands during the reading.
    const cdp = await gamePage.context().newCDPSession(gamePage);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 10 });
    let ms = null;
    let cancelled = false;
    for (let attempt = 0; attempt < 3 && !cancelled; attempt++) {
      await startStatusSampler(gamePage);
      await analyze(gamePage);
      const cancel = gamePage.locator(`${WIN} [data-action=cancelAnalysis]`);
      await expect(cancel).toBeVisible({ timeout: 15_000 });
      await expect(gamePage.locator(`${WIN} .cji-status`)).toContainText(/\d/, { timeout: 15_000 });
      const t0 = Date.now();
      await cancel.click();
      await expect(gamePage.locator(`${WIN} footer button[type=submit]`)).toBeVisible({ timeout: 3000 });
      await expect(gamePage.locator(`${WIN} footer button[type=submit]`)).toBeEnabled();
      ms = Date.now() - t0;
      cancelled = !(await gamePage.locator(`${WIN} .cji-summary`).isVisible());
    }
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await gamePage.waitForTimeout(500);
    const workers = await workerCounts(gamePage);
    await stopWorkerProbe(gamePage);
    await gamePage.screenshot({ path: testInfo.outputPath("C1-annulation-formulaire.png") });
    evidence("C1-annulation.json", { cancelled, msFromClickToForm: ms, workers, consoleAttributed: con.attributed(), allConsole: con.logs });

    expect(cancelled, "the cancel landed during the reading (the analysis did not finish first)").toBe(true);
    expect(ms).toBeLessThan(1000);
    expect(await foundry(clientSnapshot), "no document or compendium created").toEqual(before);
    expect(workers.alive).toBe(0);
    expect(con.attributed()).toEqual([]);
  });

  test("Q1: review of Better Undead lists the creatures read and the magic items (capture)", async ({ gamePage }, testInfo) => {
    const pack = await prepare(gamePage, { filter: "all", name: "q1-bu" });
    await chooseFile(gamePage, BETTER_UNDEAD_PDF);
    await gamePage.selectOption(`${WIN} select[name=newPackType]`, "Actor");
    await fillNewPack(gamePage, `Q1 ${pack}`, pack);
    await analyze(gamePage);
    await expect(gamePage.locator(`${WIN} .cji-summary`)).toBeVisible({ timeout: 120_000 });
    const text = await gamePage.locator(`${WIN} .cji-summary`).innerText();
    await gamePage.screenshot({ path: testInfo.outputPath("Q1-revue-better-undead.png") });
    evidence("Q1-texte-revue-better-undead.txt", text);
    for (const name of ["Poltergeist", "Lich", "Death Knight"]) expect(text).toContain(name);
  });
});

test("C7: a scanned PDF is announced clearly, nothing is imported, the window returns to the form", async ({ gamePage, foundry }, testInfo) => {
  const pack = await prepare(gamePage, { filter: "actors", name: "c7-scan" });
  await chooseFile(gamePage, await syntheticFile("ref-scanned"));
  await fillNewPack(gamePage, `C7 ${pack}`, pack);
  const before = await foundry(clientSnapshot);
  await analyze(gamePage);

  const scannedText = Object.entries(en.Error?.Pdf ?? {}).find(([, v]) => /scan/i.test(v))?.[1];
  expect(scannedText, "an Error.Pdf string mentions a scanned PDF").toBeTruthy();
  await expect(gamePage.locator("body")).toContainText(scannedText.replace(/\{[^}]+\}/g, "").trim().slice(0, 30), { timeout: 20_000 });
  await expect(gamePage.locator(`${WIN} footer button[type=submit]`)).toBeEnabled();
  await expect(gamePage.locator(`${WIN} .cji-summary`)).toBeHidden();
  await gamePage.screenshot({ path: testInfo.outputPath("C7-pdf-scanne.png") });
  expect(await foundry(clientSnapshot)).toEqual(before);
  expect(await foundry(clientReadPack, `world.${pack}`)).toBeNull();
});

test("C7: a file that is not a PDF gets a clear error and the window stays usable", async ({ gamePage, foundry }, testInfo) => {
  const pack = await prepare(gamePage, { filter: "actors", name: "c7-bad" });
  await chooseFile(gamePage, { name: "broken.pdf", mimeType: "application/pdf", buffer: Buffer.from("this is not a pdf at all, just text") });
  await fillNewPack(gamePage, `C7 bad ${pack}`, pack);
  const before = await foundry(clientSnapshot);
  const con = watchConsole(gamePage);
  await analyze(gamePage);
  const invalid = Object.entries(en.Error?.Pdf ?? {}).find(([k]) => /invalid|corrupt|damaged/i.test(k))?.[1];
  expect(invalid, "an Error.Pdf string for an invalid PDF").toBeTruthy();
  await expect(gamePage.locator("body")).toContainText(invalid.replace(/\{[^}]+\}/g, "").trim().slice(0, 25), { timeout: 20_000 });
  await expect(gamePage.locator(`${WIN} footer button[type=submit]`)).toBeEnabled();
  await gamePage.screenshot({ path: testInfo.outputPath("C7-pdf-invalide.png") });
  expect(await foundry(clientSnapshot)).toEqual(before);
  expect(con.stop().filter((l) => l.startsWith("pageerror")), "no uncaught error").toEqual([]);
});

test.describe("partial import and the review (C4)", () => {
  test("C4: the review lists the unreadable block with name, page and reason, and the readable one can still be imported", async ({ gamePage, foundry }, testInfo) => {
    const pack = await prepare(gamePage, { filter: "actors", name: "c4-partial" });
    await chooseFile(gamePage, await syntheticFile("ref-partial"));
    await fillNewPack(gamePage, `C4 ${pack}`, pack);
    await analyze(gamePage);
    const summary = gamePage.locator(`${WIN} .cji-summary`);
    await expect(summary).toBeVisible({ timeout: 30_000 });
    const text = await summary.innerText();
    await gamePage.screenshot({ path: testInfo.outputPath("C4-revue-problemes.png") });
    evidence("C4-texte-revue.txt", text);

    expect(text, "name of the block that failed").toMatch(/Smudged Reeve/);
    expect(text, "its page").toMatch(/\b2\b/);
    const reasons = Object.values(en.Pdf?.Reason ?? {}).map((v) => v.replace(/\{[^}]*\}/g, "").trim()).filter((v) => v.length > 5);
    expect(reasons.length, "Pdf.Reason strings exist").toBeGreaterThan(0);
    expect(reasons.some((r) => text.includes(r.slice(0, 25))), `one of the reasons is shown: ${reasons.join(" | ")}`).toBe(true);
    expect(text, "the readable block is listed").toMatch(/Bone Piper/);

    // partial import: the button stays active for the readable document
    const button = gamePage.locator(`${WIN} button[data-action=confirmImport]`);
    await expect(button).toBeEnabled();
    await confirm(gamePage);
    await expect.poll(async () => (await foundry(clientReadPack, `world.${pack}`))?.length ?? 0, { timeout: 30_000 }).toBe(1);
    const docs = await foundry(clientReadPack, `world.${pack}`);
    expect(docs.map((d) => d.name)).toEqual(["Bone Piper"]);
  });

  test("Q1: capture of the review of a PDF with problems (synthetic)", async ({ gamePage }, testInfo) => {
    await prepare(gamePage, { filter: "all", name: "q1-syn" });
    await chooseFile(gamePage, await syntheticFile("ref-unreadable"));
    await gamePage.selectOption(`${WIN} select[name=newPackType]`, "Actor");
    const pack = uniqueName("q1-syn2");
    created.push(pack);
    await fillNewPack(gamePage, `Q1 ${pack}`, pack);
    await analyze(gamePage);
    await expect(gamePage.locator(`${WIN} .cji-summary`)).toBeVisible({ timeout: 30_000 });
    await gamePage.screenshot({ path: testInfo.outputPath("Q1-revue-pdf-synthetique-problemes.png") });
    const text = await gamePage.locator(`${WIN} .cji-summary`).innerText();
    for (const name of ["Faded Scribe", "Faded Porter", "Faded Ferryman", "Faded Gaoler"]) expect(text).toContain(name);
  });

  test("target type: a PDF with creatures and an item gives only the type of the target, and says how many were ignored", async ({ gamePage, foundry }, testInfo) => {
    // Actor target: the whistle is ignored. Item target: the Bone Piper is ignored (the unreadable block is a problem either way).
    const packA = await prepare(gamePage, { filter: "actors", name: "tt-actor" });
    await chooseFile(gamePage, await syntheticFile("ref-partial"));
    await fillNewPack(gamePage, `TT ${packA}`, packA);
    await analyze(gamePage);
    await expect(gamePage.locator(`${WIN} .cji-summary`)).toBeVisible({ timeout: 30_000 });
    const textA = await gamePage.locator(`${WIN} .cji-summary`).innerText();
    await gamePage.screenshot({ path: testInfo.outputPath("TT-cible-acteurs.png") });
    const ignoredItems = en.Pdf?.IgnoredItems;
    expect(ignoredItems, "Pdf.IgnoredItems string").toBeTruthy();
    expect(textA).toContain(ignoredItems.replace("{count}", "1"));
    await gamePage.locator(`${WIN} button[data-action=backToForm]`).click();

    await gamePage.selectOption(`${WIN} select[name=typeFilter]`, "items");
    const packI = uniqueName("tt-item");
    created.push(packI);
    await fillNewPack(gamePage, `TT ${packI}`, packI);
    await analyze(gamePage);
    await expect(gamePage.locator(`${WIN} .cji-summary`)).toBeVisible({ timeout: 30_000 });
    const textI = await gamePage.locator(`${WIN} .cji-summary`).innerText();
    await gamePage.screenshot({ path: testInfo.outputPath("TT-cible-objets.png") });
    expect(textI).toContain(en.Pdf.IgnoredActors.replace("{count}", "1"));
    await confirm(gamePage);
    await expect.poll(async () => (await foundry(clientReadPack, `world.${packI}`))?.length ?? 0, { timeout: 30_000 }).toBe(1);
    const docs = await foundry(clientReadPack, `world.${packI}`);
    expect(docs.map((d) => d.name)).toEqual(["Whistle of the Marsh Warden"]);
    expect(docs[0].type).toBe("equipment");
  });
});

test("C8: a .json chosen after a .pdf in the same window is analyzed as before", async ({ gamePage, foundry }, testInfo) => {
  const pack = await prepare(gamePage, { filter: "items", name: "c8-mixed" });
  await chooseFile(gamePage, await syntheticFile("ref-items-en"));
  await expect(gamePage.locator(`${WIN} .cji-file-name`)).toHaveText("ref-items-en.pdf");
  await chooseFile(gamePage, fixturePath("formats/array.json"));
  await expect(gamePage.locator(`${WIN} .cji-file-name`)).toHaveText("array.json");
  await fillNewPack(gamePage, `C8 ${pack}`, pack);
  await analyze(gamePage);
  await expect(gamePage.locator(`${WIN} .cji-summary`)).toBeVisible({ timeout: 30_000 });
  await gamePage.screenshot({ path: testInfo.outputPath("C8-json-apres-pdf.png") });
  await confirm(gamePage);
  await expect.poll(async () => (await foundry(clientReadPack, `world.${pack}`))?.length ?? 0, { timeout: 30_000 }).toBe(3);
  const stored = await foundry(clientReadPack, `world.${pack}`);
  evidence("C8-json-apres-pdf.json", stored.map((d) => d.name));
  expect(stored).toHaveLength(3);
  expect(stored.some((d) => /ring of whispering/i.test(d.name))).toBe(false);
});

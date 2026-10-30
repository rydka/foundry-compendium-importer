/* global document */
// PDF import on the real book (Better Undead Compendium.pdf, 35 pages, 212 MB, local file, ignored by git):
// C2 (12 enriched actors), C3 (3 items), M1 (console), C6 (same result twice), M5 (time, measured and reported).
// Skipped when the PDF is absent. The PDF is chosen with setInputFiles(path): Playwright hands the local path to the
// browser, the 212 MB are not copied through the test.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "../../../../test-env/fixtures.mjs";
import { clientDeletePacks, clientReadPack, evidence, uniqueName } from "./helpers.mjs";
import {
  BETTER_UNDEAD_PDF, WIN, analyze, bigFileInPage, chooseFile, confirm, fillNewPack, hasBetterUndead, openWindow, readLang, watchConsole
} from "./pdf-helpers.mjs";

const truth = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "pdf", "better-undead.truth.json"), "utf8"));
const created = [];

test.skip(!hasBetterUndead(), "Better Undead Compendium.pdf is not on this machine");
test.setTimeout(240_000);

test.afterEach(async ({ foundry }) => {
  await foundry(async (id) => { await foundry.applications.instances.get(id)?.close(); }, "compendium-json-importer");
  if (created.length) await foundry(clientDeletePacks, created.splice(0));
});

/** Full UI import of the book into a new compendium of the given type; returns the stored documents. */
async function importBook(page, foundry, { filter, name, enrich = true }) {
  await openWindow(page);
  await page.selectOption(`${WIN} select[name=typeFilter]`, filter);
  const pack = uniqueName(name);
  created.push(pack);
  await chooseFile(page, BETTER_UNDEAD_PDF);
  await fillNewPack(page, `BU ${pack}`, pack);
  const enrichBox = page.locator(`${WIN} input[name=enrich]`);
  if (await enrichBox.count()) await enrichBox.setChecked(enrich);
  await analyze(page);
  await expect(page.locator(`${WIN} .cji-summary`)).toBeVisible({ timeout: 150_000 });
  return { pack, summary: () => page.locator(`${WIN} .cji-summary`).innerText() };
}

test("C2/M1: import into a new actor compendium gives the 12 creatures, enriched, with a clean console", async ({ gamePage, foundry }, testInfo) => {
  const con = watchConsole(gamePage);
  await foundry(() => {
    CONFIG.compatibility.mode = CONST.COMPATIBILITY_MODES.ERROR;
    CONFIG.compatibility.includePatterns.push(/compendium-json-importer/);
  });
  const { pack, summary } = await importBook(gamePage, foundry, { filter: "actors", name: "bu-actors" });
  const text = await summary();
  await gamePage.screenshot({ path: testInfo.outputPath("C2-revue-12-creatures.png") });
  await confirm(gamePage);
  await expect.poll(async () => (await foundry(clientReadPack, `world.${pack}`))?.length ?? 0, { timeout: 120_000 }).toBe(12);
  const actors = await foundry(clientReadPack, `world.${pack}`);

  const names = actors.map((a) => a.name).sort();
  const wantNames = truth.creatures.map((c) => c.name).sort();
  const phantom = actors.find((a) => a.name === "Phantom");
  const soulDrain = phantom?.items.find((i) => i.name === "Soul Drain");
  const acts = Object.values(soulDrain?.system?.activities ?? {});
  const summaryOfItems = actors.map((a) => ({ name: a.name, type: a.type, items: a.items.length, cr: a.system.details.cr }));
  evidence("C2-acteurs.json", { names, summaryOfItems, soulDrainActivities: acts.map((a) => ({ type: a.type, dc: a.save?.dc, ability: a.save?.ability })) });
  evidence("M1-console-import-better-undead.json", { all: con.logs, attributed: con.attributed() });
  evidence("C2-texte-revue.txt", text);

  expect(names).toEqual(wantNames);
  expect(actors.every((a) => a.type === "npc")).toBe(true);
  expect(acts.some((a) => a.type === "attack"), "Soul Drain has an attack activity").toBe(true);
  expect(acts.some((a) => a.type === "save" && String(a.save?.dc?.formula ?? a.save?.dc?.value) === "16"), "Soul Drain has a save activity, DC 16").toBe(true);
  expect(text, "no conformity rejection").toContain(readLang("en").Summary.Rejected.replace("{count}", "0"));
  expect(con.attributed(), "console errors or warnings attributable to the module or pdf.js").toEqual([]);
});

test("C3: import into a new item compendium gives the 3 tomes (wondrous, legendary, no attunement)", async ({ gamePage, foundry }, testInfo) => {
  const { pack } = await importBook(gamePage, foundry, { filter: "items", name: "bu-items" });
  await gamePage.screenshot({ path: testInfo.outputPath("C3-revue-3-objets.png") });
  await confirm(gamePage);
  await expect.poll(async () => (await foundry(clientReadPack, `world.${pack}`))?.length ?? 0, { timeout: 120_000 }).toBe(3);
  const items = await foundry(clientReadPack, `world.${pack}`);
  evidence("C3-objets.json", items.map((i) => ({ name: i.name, type: i.type, subtype: i.system.type?.value, rarities: i.system.rarities, attunement: i.system.attunement })));
  expect(items.map((i) => i.name).sort()).toEqual(truth.items.map((i) => i.name).sort());
  for (const i of items) {
    expect(i.type).toBe("equipment");
    expect(i.system.type?.value).toBe("wondrous");
    expect(i.system.rarities).toEqual(["legendary"]);
    expect(i.system.attunement || "").toBe("");
  }
});

test("target type: the creatures are ignored for an item compendium and the items for an actor compendium, with the count", async ({ gamePage, foundry }) => {
  const a = await importBook(gamePage, foundry, { filter: "actors", name: "bu-tt-a" });
  const textA = await a.summary();
  await gamePage.locator(`${WIN} button[data-action=backToForm]`).click();
  const b = await importBook(gamePage, foundry, { filter: "items", name: "bu-tt-i" });
  const textB = await b.summary();
  const lang = readLang("en");
  evidence("TT-textes.json", { actors: textA, items: textB });
  expect(textA).toContain(lang.Pdf.IgnoredItems.replace("{count}", "3"));
  expect(textB).toContain(lang.Pdf.IgnoredActors.replace("{count}", "12"));
});

test("C6: reading the book twice gives the same entries, byte for byte", async ({ gamePage, foundry }) => {
  await bigFileInPage(gamePage, BETTER_UNDEAD_PDF);
  const read = () => foundry(async () => {
    const api = game.modules.get("compendium-json-importer").api;
    const file = document.getElementById("cji-big-file").files[0];
    const out = {};
    for (const documentName of ["Actor", "Item"]) {
      const r = await api.readPdf(file, { fileName: "Better Undead Compendium.pdf", documentName });
      out[documentName] = JSON.stringify(r.entries);
    }
    return out;
  });
  const first = await read();
  const second = await read();
  expect(JSON.parse(first.Actor)).toHaveLength(12);
  expect(JSON.parse(first.Item)).toHaveLength(3);
  expect(second.Actor === first.Actor, "actors identical").toBe(true);
  expect(second.Item === first.Item, "items identical").toBe(true);
});

test("M5: time to read the 35 pages (measured and reported, median of 3; not an assertion)", async ({ gamePage, foundry }) => {
  await bigFileInPage(gamePage, BETTER_UNDEAD_PDF);
  const runs = await foundry(async () => {
    const api = game.modules.get("compendium-json-importer").api;
    const buf = document.getElementById("cji-big-file").files[0];
    const longTasks = [];
    const observer = new PerformanceObserver((list) => { for (const e of list.getEntries()) longTasks.push(Math.round(e.duration)); });
    try { observer.observe({ entryTypes: ["longtask"] }); } catch { /* not supported */ }
    const out = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      const r = await api.readPdf(buf, { fileName: "Better Undead Compendium.pdf", documentName: "Actor" });
      out.push({ wallMs: Math.round(performance.now() - t0), timings: r.report?.timings ?? null, pages: r.report?.pages ?? null });
    }
    observer.disconnect();
    return { out, longTasks };
  });
  const walls = runs.out.map((r) => r.wallMs).sort((a, b) => a - b);
  const median = walls[1];
  const sum = (t) => (t ? Object.entries(t).filter(([k]) => k !== "ai").reduce((n, [, v]) => n + v, 0) : null);
  evidence("M5-temps.json", {
    target: "<= 15000 ms for 32 pages (the book has 35), without AI",
    pages: runs.out[0].pages, wallMsRuns: runs.out.map((r) => r.wallMs), medianWallMs: median,
    reportTimingsRuns: runs.out.map((r) => ({ ...r.timings, totalExceptAi: sum(r.timings) })),
    longestTaskMs: Math.max(0, ...runs.longTasks), longTasksMs: runs.longTasks, longTaskTarget: "< 200 ms (indicative)"
  });
  test.info().annotations.push({ type: "M5", description: `median ${median} ms for ${runs.out[0].pages} pages` });
});

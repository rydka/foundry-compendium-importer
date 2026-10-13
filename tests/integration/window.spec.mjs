// Window flows: C2/M2 (no deprecation during a full import), C7, C8, C10 (UI message), C11, C12 (scenario 2),
// C16, C17, C21, C22, C14 (sheet capture), Q2 captures, scenario 1.
// Skeleton: not yet run in a real Foundry. Selectors come from templates/importer/*.hbs.
/* global document, Option */
import { readFileSync } from "node:fs";
import { expect, test, waitForGame } from "../../../../test-env/fixtures.mjs";
import {
  MODULE_ID, clientDeletePacks, clientReadPack, clientSeedPack, clientSnapshot, fixtureJson, fixturePath, uniqueName
} from "./helpers.mjs";

const WIN = "#compendium-json-importer";
const created = [];

test.afterEach(async ({ foundry }) => {
  await foundry(async (id) => {
    await foundry.applications.instances.get(id)?.close();
  }, MODULE_ID);
  if (created.length) await foundry(clientDeletePacks, created.splice(0));
});

const lang = (code) => JSON.parse(readFileSync(new URL(`../../lang/${code}.json`, import.meta.url), "utf8"))[MODULE_ID];

async function openWindow(page) {
  await page.evaluate(() => game.modules.get("compendium-json-importer").api.open());
  await page.locator(WIN).waitFor();
}

async function chooseFile(page, name) {
  await page.locator(`${WIN} input[name=sourceFile]`).setInputFiles(fixturePath(name));
}

async function analyze(page) {
  await page.locator(`${WIN} footer button[type=submit]`).click();
}

async function confirm(page) {
  await page.locator(`${WIN} button[data-action=confirmImport]`).click();
}

const counts = (page) => page.locator(`${WIN} .cji-counts li`).allTextContents();

test("C7: the target list only offers compendiums of the filtered type; the new compendium gets that type", async ({ gamePage, foundry }) => {
  const actorPack = uniqueName("c7-actors");
  const itemPack = uniqueName("c7-items");
  created.push(actorPack, itemPack);
  await foundry(clientSeedPack, { name: actorPack, type: "Actor" });
  await foundry(clientSeedPack, { name: itemPack, type: "Item" });
  await openWindow(gamePage);

  const optionTypes = async () => gamePage.evaluate(() => Array.from(document.querySelectorAll("#compendium-json-importer select[name=targetPack] option"))
    .map((o) => o.value).filter((v) => v !== "new").map((v) => game.packs.get(v).documentName));

  await gamePage.selectOption(`${WIN} select[name=typeFilter]`, "actors");
  await expect.poll(async () => (await optionTypes()).every((t) => t === "Actor") && (await optionTypes()).length > 0).toBe(true);
  expect(await gamePage.locator(`${WIN} select[name=targetPack] option[value="world.${actorPack}"]`).count()).toBe(1);
  expect(await gamePage.locator(`${WIN} select[name=targetPack] option[value="world.${itemPack}"]`).count()).toBe(0);

  await gamePage.selectOption(`${WIN} select[name=typeFilter]`, "items");
  await expect.poll(async () => (await optionTypes()).every((t) => t === "Item") && (await optionTypes()).length > 0).toBe(true);
  expect(await gamePage.locator(`${WIN} select[name=targetPack] option[value="world.${itemPack}"]`).count()).toBe(1);

  await gamePage.selectOption(`${WIN} select[name=typeFilter]`, "all");
  await expect.poll(async () => new Set(await optionTypes()).size).toBeGreaterThan(1);
  await expect(gamePage.locator(`${WIN} select[name=newPackType]`)).toBeEnabled();
  const types = await gamePage.locator(`${WIN} select[name=newPackType] option`).evaluateAll((os) => os.map((o) => o.value));
  expect(types).toEqual(expect.arrayContaining(["Actor", "Item", "JournalEntry"]));
  await gamePage.screenshot({ path: test.info().outputPath("c7-filter-all.png") });
});

test("scenario 1 / C9 / C11 / C2 / M2: import a file into a new compendium from the window, with no deprecation warning", async ({ gamePage, foundry }) => {
  const logs = [];
  gamePage.on("console", (msg) => {
    if (["warning", "error"].includes(msg.type())) logs.push(`${msg.type()}: ${msg.text()}`);
  });
  gamePage.on("pageerror", (err) => logs.push(`pageerror: ${err.message}`));
  // Make any deprecation attributed to the module visible and fatal during the import.
  await foundry(() => {
    CONFIG.compatibility.mode = CONST.COMPATIBILITY_MODES.ERROR;
    CONFIG.compatibility.includePatterns.push(/compendium-json-importer/);
  });

  const name = uniqueName("scenario1");
  created.push(name);
  await openWindow(gamePage);
  await gamePage.selectOption(`${WIN} select[name=typeFilter]`, "items");
  await chooseFile(gamePage, "formats/array.json");
  // Label and name are proposed from the file name.
  await expect(gamePage.locator(`${WIN} input[name=newPackLabel]`)).not.toHaveValue("");
  await expect(gamePage.locator(`${WIN} input[name=newPackName]`)).toHaveValue("array");
  await gamePage.fill(`${WIN} input[name=newPackLabel]`, `Scenario ${name}`);
  await gamePage.fill(`${WIN} input[name=newPackName]`, name);
  await gamePage.screenshot({ path: test.info().outputPath("scenario1-1-form.png") });

  const before = await foundry(clientSnapshot);
  await analyze(gamePage);
  await expect(gamePage.locator(`${WIN} .cji-summary`)).toBeVisible();
  expect(await foundry(clientSnapshot), "nothing written before confirmation (C21)").toEqual(before);
  await gamePage.screenshot({ path: test.info().outputPath("scenario1-2-summary.png") });

  await confirm(gamePage);
  await expect(gamePage.locator(".notification", { hasText: /3/ }).first()).toBeVisible();
  await gamePage.screenshot({ path: test.info().outputPath("scenario1-3-done.png") });

  const stored = await foundry(clientReadPack, `world.${name}`);
  expect(stored).toHaveLength(3);
  expect(await foundry((id) => game.packs.get(id).metadata.label, `world.${name}`)).toBe(`Scenario ${name}`);

  const mine = logs.filter((l) => l.includes(MODULE_ID) || /deprecat/i.test(l));
  expect(mine, logs.join("\n")).toEqual([]);
});

test("C10: a broken file shows an error message and writes nothing", async ({ gamePage, foundry }) => {
  await openWindow(gamePage);
  await gamePage.fill(`${WIN} input[name=newPackLabel]`, "Broken");
  await chooseFile(gamePage, "formats/broken.json");
  const before = await foundry(clientSnapshot);
  await analyze(gamePage);
  await expect(gamePage.locator(".notification.error, .notification[data-type=error], .notification").first()).toBeVisible();
  await expect(gamePage.locator(`${WIN} .cji-summary`)).toBeHidden();
  expect(await foundry(clientSnapshot)).toEqual(before);
  await gamePage.screenshot({ path: test.info().outputPath("c10-broken-file.png") });
});

test("C8: a file declaring another document type than the compendium raises a warning", async ({ gamePage, foundry }) => {
  const actorPack = uniqueName("c8-actors");
  created.push(actorPack);
  await foundry(clientSeedPack, { name: actorPack, type: "Actor" });
  await openWindow(gamePage);
  await gamePage.selectOption(`${WIN} select[name=typeFilter]`, "actors");
  await gamePage.selectOption(`${WIN} select[name=targetPack]`, `world.${actorPack}`);
  await chooseFile(gamePage, "formats/entries.json"); // declares type "Item"
  await analyze(gamePage);
  await expect(gamePage.locator(`${WIN} .cji-warning`).first()).toBeVisible();
  await gamePage.screenshot({ path: test.info().outputPath("c8-type-warning.png") });
});

test("C8: a compendium of another type than the filter is refused", async ({ gamePage, foundry }) => {
  const itemPack = uniqueName("c8-items");
  created.push(itemPack);
  await foundry(clientSeedPack, { name: itemPack, type: "Item" });
  await openWindow(gamePage);
  // The list never offers it (C7): force the value into the select, as a stale choice would.
  await gamePage.selectOption(`${WIN} select[name=typeFilter]`, "actors");
  await gamePage.evaluate((id) => {
    const select = document.querySelector("#compendium-json-importer select[name=targetPack]");
    select.append(new Option(id, id));
    select.value = id;
  }, `world.${itemPack}`);
  await chooseFile(gamePage, "formats/array.json");
  const before = await foundry(clientSnapshot);
  await analyze(gamePage);
  await expect(gamePage.locator(".notification").first()).toBeVisible();
  await expect(gamePage.locator(`${WIN} .cji-summary`)).toBeHidden();
  expect(await foundry(clientSnapshot)).toEqual(before);
});

test("C21: Cancel in the summary writes nothing and other types are counted apart", async ({ gamePage, foundry }) => {
  await openWindow(gamePage);
  await gamePage.selectOption(`${WIN} select[name=typeFilter]`, "all");
  await gamePage.selectOption(`${WIN} select[name=newPackType]`, "JournalEntry");
  await gamePage.fill(`${WIN} input[name=newPackLabel]`, "Cancelled");
  await gamePage.fill(`${WIN} input[name=newPackName]`, uniqueName("cancelled"));
  await chooseFile(gamePage, "formats/mixed-types.json");
  const before = await foundry(clientSnapshot);
  await analyze(gamePage);
  await expect(gamePage.locator(`${WIN} .cji-summary`)).toBeVisible();
  const lines = await counts(gamePage);
  expect(lines.join(" | ")).toContain("4"); // "other types" counter
  await gamePage.screenshot({ path: test.info().outputPath("c21-summary.png") });
  await gamePage.locator(`${WIN} button[data-action=backToForm]`).click();
  await expect(gamePage.locator(`${WIN} .cji-summary`)).toBeHidden();
  expect(await foundry(clientSnapshot)).toEqual(before);
});

test("C21/C20: the summary lists each rejected document with name, type and reasons; confirming imports the others", async ({ gamePage, foundry }) => {
  const name = uniqueName("c20");
  created.push(name);
  await openWindow(gamePage);
  await gamePage.selectOption(`${WIN} select[name=typeFilter]`, "items");
  await gamePage.fill(`${WIN} input[name=newPackLabel]`, "Conformity UI");
  await gamePage.fill(`${WIN} input[name=newPackName]`, name);
  await chooseFile(gamePage, "conformity-items.json");
  await analyze(gamePage);
  await expect(gamePage.locator(`${WIN} .cji-rejected > li`).first()).toBeVisible();

  const truth = fixtureJson("conformity-expected.json").documents.filter((d) => d.documentName === "Item");
  const bad = truth.filter((t) => !t.conform);
  const rejectedItems = await gamePage.locator(`${WIN} .cji-rejected > li`).count();
  expect(rejectedItems).toBe(bad.length);
  const text = await gamePage.locator(`${WIN} .cji-rejected`).innerText();
  for (const t of bad) expect(text).toContain(t.name);
  expect(text).not.toMatch(/compendium-json-importer\.reason/);
  await gamePage.screenshot({ path: test.info().outputPath("c20-rejected-list.png") });

  await confirm(gamePage);
  await expect.poll(() => foundry((id) => game.packs.get(id)?.index.size ?? 0, `world.${name}`)).toBe(truth.filter((t) => t.conform).length);
});

test("C12/scenario 2: re-importing with Overwrite replaces the documents and reports the count", async ({ gamePage, foundry }) => {
  const name = uniqueName("c12ui");
  created.push(name);
  await foundry(clientSeedPack, { name, type: "Item" });
  for (let round = 0; round < 2; round++) {
    await openWindow(gamePage);
    await gamePage.selectOption(`${WIN} select[name=typeFilter]`, "items");
    await gamePage.selectOption(`${WIN} select[name=targetPack]`, `world.${name}`);
    await gamePage.setChecked(`${WIN} input[name=overwrite]`, true);
    await chooseFile(gamePage, "formats/array.json");
    await analyze(gamePage);
    await expect(gamePage.locator(`${WIN} .cji-summary`)).toBeVisible();
    if (round === 1) {
      expect((await counts(gamePage)).join(" | ")).toContain("3"); // documents to replace
      await gamePage.screenshot({ path: test.info().outputPath("c12-overwrite-summary.png") });
    }
    await confirm(gamePage);
    await expect.poll(() => foundry((id) => game.packs.get(id).index.size, `world.${name}`)).toBe(3);
    await expect(gamePage.locator(WIN)).toHaveCount(0);
  }
  expect(await foundry(clientReadPack, `world.${name}`)).toHaveLength(3);
});

test("C16: the last choices are restored when the importer is reopened", async ({ gamePage, foundry }) => {
  const name = uniqueName("c16");
  created.push(name);
  await foundry(clientSeedPack, { name, type: "Item" });
  await openWindow(gamePage);
  await gamePage.selectOption(`${WIN} select[name=typeFilter]`, "items");
  await gamePage.selectOption(`${WIN} select[name=targetPack]`, `world.${name}`);
  await gamePage.setChecked(`${WIN} input[name=overwrite]`, false);
  await gamePage.setChecked(`${WIN} input[name=stripIds]`, false);
  await chooseFile(gamePage, "formats/array.json");
  await analyze(gamePage);
  await expect(gamePage.locator(`${WIN} .cji-summary`)).toBeVisible();
  await foundry(() => foundry.applications.instances.get("compendium-json-importer").close());

  await openWindow(gamePage);
  await expect(gamePage.locator(`${WIN} select[name=typeFilter]`)).toHaveValue("items");
  await expect(gamePage.locator(`${WIN} select[name=targetPack]`)).toHaveValue(`world.${name}`);
  await expect(gamePage.locator(`${WIN} input[name=overwrite]`)).not.toBeChecked();
  await expect(gamePage.locator(`${WIN} input[name=stripIds]`)).not.toBeChecked();
  await gamePage.screenshot({ path: test.info().outputPath("c16-restored.png") });
});

for (const code of ["fr", "en"]) {
  test(`C17: the whole window is in ${code}`, async ({ gamePage, foundry }) => {
    const t = lang(code);
    await foundry((l) => game.settings.set("core", "language", l), code);
    try {
      await gamePage.reload();
      await waitForGame(gamePage);
      expect(await foundry(() => game.i18n.lang)).toBe(code);
      await openWindow(gamePage);
      const title = await gamePage.locator(`${WIN} .window-title`).innerText();
      expect(title.trim()).toBe(t.Title);
      const text = await gamePage.locator(WIN).innerText();
      for (const key of [t.Filter.Label, t.Target.Label, t.Options.Overwrite, t.Options.StripIds, t.Button.Analyze]) expect(text).toContain(key);
      await gamePage.screenshot({ path: test.info().outputPath(`c17-window-${code}.png`) });
      // An error message is translated too.
      await chooseFile(gamePage, "formats/broken.json");
      await analyze(gamePage);
      await expect(gamePage.locator(".notification").first()).toBeVisible();
      await gamePage.screenshot({ path: test.info().outputPath(`c17-error-${code}.png`) });
      const messages = (await gamePage.locator(".notification").allInnerTexts()).join(" ");
      expect(messages).not.toContain("compendium-json-importer.");
    } finally {
      await foundry((l) => game.settings.set("core", "language", l), "en");
      if (code !== "en") {
        await gamePage.reload();
        await waitForGame(gamePage);
      }
    }
  });
}

test.describe("C22: identifiers already used in the target compendium", () => {
  const ids = fixtureJson("id-conflicts.json").map((d) => d._id);

  async function seeded(foundry) {
    const name = uniqueName("c22");
    created.push(name);
    const seed = fixtureJson("id-conflicts.json").map((d) => ({ ...d, name: `Existing ${d.name}`, system: { quantity: 99 } }));
    await foundry(clientSeedPack, { name, type: "Item", documents: seed });
    return name;
  }

  async function reviewConflicts(page, name) {
    await openWindow(page);
    await page.selectOption(`${WIN} select[name=typeFilter]`, "items");
    await page.selectOption(`${WIN} select[name=targetPack]`, `world.${name}`);
    await page.setChecked(`${WIN} input[name=overwrite]`, false);
    await page.setChecked(`${WIN} input[name=stripIds]`, false);
    await chooseFile(page, "id-conflicts.json");
    await analyze(page);
    await expect(page.locator(`${WIN} .cji-conflicts > li`)).toHaveCount(3);
  }

  test("the summary lists the conflicts with a checkbox each and 'select all'; replace swaps the existing documents", async ({ gamePage, foundry }) => {
    const name = await seeded(foundry);
    await reviewConflicts(gamePage, name);
    await expect(gamePage.locator(`${WIN} input[name=selectAll]`)).toBeVisible();
    const listed = await gamePage.locator(`${WIN} .cji-conflicts`).innerText();
    expect(listed).toContain("Conflict Item 1");
    expect(listed).toContain("Existing Conflict Item 1");
    await gamePage.screenshot({ path: test.info().outputPath("c22-conflicts.png") });

    await gamePage.check(`${WIN} input[name=selectAll]`);
    await gamePage.selectOption(`${WIN} select[name=conflictAction]`, "replace");
    await confirm(gamePage);
    await expect.poll(async () => (await foundry(clientReadPack, `world.${name}`)).map((d) => d.name).sort().join()).toBe("Conflict Item 1,Conflict Item 2,Conflict Item 3");
    const stored = await foundry(clientReadPack, `world.${name}`);
    expect(stored.map((d) => d._id).sort()).toEqual([...ids].sort());
  });

  test("'new identifier' keeps the existing documents and adds the selected ones under new ids", async ({ gamePage, foundry }) => {
    const name = await seeded(foundry);
    await reviewConflicts(gamePage, name);
    await gamePage.check(`${WIN} input[name=selectAll]`);
    await gamePage.selectOption(`${WIN} select[name=conflictAction]`, "newId");
    await confirm(gamePage);
    await expect.poll(() => foundry((id) => game.packs.get(id).index.size, `world.${name}`)).toBe(6);
    const stored = await foundry(clientReadPack, `world.${name}`);
    expect(stored.filter((d) => d.name.startsWith("Existing")).map((d) => d._id).sort()).toEqual([...ids].sort());
    const added = stored.filter((d) => d.name.startsWith("Conflict"));
    expect(added).toHaveLength(3);
    for (const d of added) expect(ids).not.toContain(d._id);
  });

  test("only the checked conflicts are imported; the others are ignored and counted as such", async ({ gamePage, foundry }) => {
    const name = await seeded(foundry);
    await reviewConflicts(gamePage, name);
    await gamePage.locator(`${WIN} input[name=conflictSelected]`).first().check();
    await gamePage.selectOption(`${WIN} select[name=conflictAction]`, "replace");
    await confirm(gamePage);
    await expect(gamePage.locator(".notification", { hasText: /2/ }).first()).toBeVisible(); // "2 ignored"
    const stored = await foundry(clientReadPack, `world.${name}`);
    expect(stored).toHaveLength(3);
    expect(stored.filter((d) => d.name.startsWith("Existing"))).toHaveLength(2);
    expect(stored.filter((d) => d.name.startsWith("Conflict"))).toHaveLength(1);
  });
});

test("C14: the sheet of an imported item shows its activities (capture)", async ({ gamePage, foundry }) => {
  const name = uniqueName("c14");
  created.push(name);
  await openWindow(gamePage);
  await gamePage.selectOption(`${WIN} select[name=typeFilter]`, "items");
  await gamePage.fill(`${WIN} input[name=newPackLabel]`, "Activities");
  await gamePage.fill(`${WIN} input[name=newPackName]`, name);
  await chooseFile(gamePage, "legacy-3x.json");
  await analyze(gamePage);
  await confirm(gamePage);
  await expect.poll(() => foundry((id) => game.packs.get(id)?.index.size ?? 0, `world.${name}`)).toBeGreaterThan(0);
  await foundry(async (id) => {
    const docs = await game.packs.get(id).getDocuments();
    const item = docs.find((d) => d.name === "Legacy Longsword");
    await item.sheet.render({ force: true });
  }, `world.${name}`);
  await gamePage.waitForTimeout(1500);
  await gamePage.screenshot({ path: test.info().outputPath("c14-item-sheet.png") });
  const size = await foundry(async (id) => (await game.packs.get(id).getDocuments()).find((d) => d.name === "Legacy Longsword").system.activities.size, `world.${name}`);
  expect(size).toBeGreaterThanOrEqual(1);
});

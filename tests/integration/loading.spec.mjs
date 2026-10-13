// C1 (loading), C3 (runtime), C4 (settings menu), C5 (Compendiums tab button, GM), C24 (api exposed).
// Skeleton written before the code was final: not yet run in a real Foundry.
import { expect, test, waitForGame } from "../../../../test-env/fixtures.mjs";
import { MODULE_ID, evidence } from "./helpers.mjs";

test("C1: loading the world opens no window and logs nothing from the module", async ({ page }) => {
  const logs = [];
  page.on("console", (msg) => {
    if (["warning", "error"].includes(msg.type())) logs.push(`${msg.type()}: ${msg.text()}`);
  });
  page.on("pageerror", (err) => logs.push(`pageerror: ${err.message}`));
  await page.goto("/game");
  await waitForGame(page);
  await page.waitForTimeout(2000);

  const open = await page.evaluate((id) => Array.from(foundry.applications.instances.keys()).filter((k) => k.includes(id)), MODULE_ID);
  evidence("C1-chargement.json", { openWindows: open, importerInDom: await page.locator("#compendium-json-importer").count(), consoleWarningsAndErrors: logs });
  expect(open).toEqual([]);
  expect(await page.locator("#compendium-json-importer").count()).toBe(0);

  const mine = logs.filter((l) => l.includes(MODULE_ID) || /importer\.(js|mjs)|FormApplication|actor-importer|object-importer/.test(l));
  expect(mine, logs.join("\n")).toEqual([]);
});

test("C3: the module is active with version 0.2.0 and dnd5e is the system", async ({ foundry }) => {
  const info = await foundry((id) => {
    const mod = game.modules.get(id);
    return { active: mod.active, version: mod.version, system: game.system.id, hasApi: typeof mod.api?.open === "function" };
  }, MODULE_ID);
  evidence("C3-module-actif.json", info);
  expect(info).toEqual({ active: true, version: "0.2.0", system: "dnd5e", hasApi: true });
});

test("C24: the api exposes open, analyze and runImport", async ({ foundry }) => {
  const api = await foundry((id) => Object.keys(game.modules.get(id).api).sort(), MODULE_ID);
  evidence("C24-api.json", api);
  expect(api).toEqual(["analyze", "open", "runImport"]);
});

test("C4: the settings menu has an 'Open the importer' button that opens the window", async ({ gamePage, foundry }) => {
  await foundry(() => game.settings.sheet.render({ force: true }));
  const sheet = gamePage.locator("#settings-config").first();
  await sheet.waitFor();
  await gamePage.locator(`#settings-config button[data-action="tab"][data-tab="${MODULE_ID}"]`).click();
  const button = gamePage.locator(`button[data-key="${MODULE_ID}.importer"]`).or(gamePage.getByRole("button", { name: /Open the importer|Ouvrir l'importeur/ })).first();
  await expect(button).toBeVisible();
  await button.click();
  await expect(gamePage.locator("#compendium-json-importer")).toBeVisible();
  await gamePage.screenshot({ path: test.info().outputPath("C4-importeur-depuis-reglages.png") });
  await foundry(() => foundry.applications.instances.get("compendium-json-importer")?.close());
});

test("C5: the Compendiums tab shows an Import button for the GM that opens the window", async ({ gamePage, foundry }) => {
  await foundry(async () => {
    ui.sidebar.expand();
    ui.sidebar.changeTab("compendium", "primary");
    await ui.compendium.render({ force: true });
  });
  const button = gamePage.locator("#compendium .cji-open-importer, .compendium-directory .cji-open-importer").first();
  await expect(button).toBeVisible();
  await gamePage.screenshot({ path: test.info().outputPath("C5-bouton-onglet-compendiums.png") });
  await button.click();
  await expect(gamePage.locator("#compendium-json-importer")).toBeVisible();
  await foundry(() => foundry.applications.instances.get("compendium-json-importer")?.close());
});

test("C5/Q2: the button and the window are readable in the light and the dark theme", async ({ gamePage, foundry }) => {
  for (const scheme of ["light", "dark"]) {
    await foundry(async (s) => {
      await game.settings.set("core", "uiConfig", { ...game.settings.get("core", "uiConfig"), colorScheme: { applications: s, interface: s } });
      ui.sidebar.changeTab("compendium", "primary");
      await ui.compendium.render({ force: true });
      await game.modules.get("compendium-json-importer").api.open();
    }, scheme);
    await expect(gamePage.locator("#compendium-json-importer")).toBeVisible();
    await gamePage.screenshot({ path: test.info().outputPath(`Q2-importeur-${scheme}.png`) });
  }
  await foundry(async () => {
    await game.settings.set("core", "uiConfig", { ...game.settings.get("core", "uiConfig"), colorScheme: { applications: "", interface: "" } });
    await foundry.applications.instances.get("compendium-json-importer")?.close();
  });
});

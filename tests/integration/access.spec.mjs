// C5 (no button for players), C6 (players cannot import), C24 (runImport refused for a player).
// Skeleton: not yet run in a real Foundry. The player joins from a second browser context via /join.
import { expect, test, waitForGame } from "../../../../test-env/fixtures.mjs";
import { MODULE_ID, clientDeletePacks, clientSnapshot, fixtureText, uniqueName } from "./helpers.mjs";

const PLAYER_NAME = "CJI Test Player";

async function joinAsPlayer(browser, baseURL) {
  const context = await browser.newContext({ baseURL, viewport: { width: 1600, height: 900 } });
  const page = await context.newPage();
  await page.goto("/join");
  await page.locator('select[name="userid"]').selectOption({ label: PLAYER_NAME });
  await page.locator('button[name="join"]').click();
  await waitForGame(page);
  return { context, page };
}

test.describe("player view", () => {
  test.beforeEach(async ({ foundry }) => {
    await foundry(async (name) => {
      if (!game.users.getName(name)) await CONFIG.User.documentClass.create({ name, role: CONST.USER_ROLES.PLAYER });
    }, PLAYER_NAME);
  });

  test.afterEach(async ({ foundry }) => {
    await foundry(async (name) => game.users.getName(name)?.delete(), PLAYER_NAME);
  });

  test("C5: a player sees no Import button in the Compendiums tab", async ({ browser, baseURL }) => {
    const { context, page } = await joinAsPlayer(browser, baseURL);
    try {
      await page.evaluate(async () => {
        ui.sidebar.changeTab("compendium", "primary");
        await ui.compendium.render({ force: true });
      });
      await page.waitForTimeout(500);
      await expect(page.locator(".cji-open-importer")).toHaveCount(0);
      await page.screenshot({ path: test.info().outputPath("c5-player-no-button.png") });
    } finally {
      await context.close();
    }
  });

  test("C6/C24: a player cannot run an import; nothing is created or deleted", async ({ browser, baseURL, foundry }) => {
    const name = uniqueName("cji-player");
    const snapshot = await foundry(clientSnapshot);
    const { context, page } = await joinAsPlayer(browser, baseURL);
    try {
      const outcome = await page.evaluate(async ({ id, newName, text }) => {
        const api = game.modules.get(id).api;
        const documents = JSON.parse(text);
        try {
          await api.runImport({ newPackSpec: { label: newName, name: newName, type: "Item" }, documents, deleteIds: [] });
          return { refused: false };
        } catch (err) {
          return { refused: true, message: err.message };
        }
      }, { id: MODULE_ID, newName: name, text: fixtureText("formats/array.json") });
      expect(outcome.refused).toBe(true);
      expect(outcome.message).toBeTruthy();

      // The window itself also refuses: open it and press "Analyze".
      await page.evaluate(() => game.modules.get("compendium-json-importer").api.open());
      await page.locator("#compendium-json-importer footer button[type=submit]").click();
      await expect(page.locator(".notification").first()).toBeVisible();
      await page.screenshot({ path: test.info().outputPath("c6-player-refused.png") });
    } finally {
      await context.close();
    }
    const after = await foundry(clientSnapshot);
    expect(after).toEqual(snapshot);
    expect(after.packs).toBe(snapshot.packs);
    await foundry(clientDeletePacks, [name]);
  });
});

/* global document, window */
// The importer window must stay on screen: in a 1160x816 browser, after "Analyze file", the title of the review and the
// Import button are really visible (not hidden behind another element, no manual scrolling).
import { expect, test } from "../../../../test-env/fixtures.mjs";
import { MODULE_ID, clientDeletePacks, evidence, fixturePath, uniqueName } from "./helpers.mjs";

test.describe.configure({ timeout: 180_000 });

const WIN = "#compendium-json-importer";
const created = [];

test.afterEach(async ({ foundry }) => {
  await foundry(async (id) => { await foundry.applications.instances.get(id)?.close(); }, MODULE_ID);
  if (created.length) await foundry(clientDeletePacks, created.splice(0));
});

async function visibleAt(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { found: false };
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const top = document.elementFromPoint(x, y);
    return {
      found: true, rect: { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) },
      inWindow: r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth,
      reachable: !!top && (el === top || el.contains(top) || top.contains(el))
    };
  }, selector);
}

for (const [label, file, filter] of [["items", "formats/array.json", "items"], ["actors-enriched", "enrichment/compendium-40.json", "actors"]]) {
  test(`window fits in 1160x816: the review title and the Import button are visible without scrolling (${label})`, async ({ gamePage }) => {
    await gamePage.setViewportSize({ width: 1160, height: 816 });
    const name = uniqueName(`fit${label.slice(0, 4)}`);
    created.push(name);
    await gamePage.evaluate(() => game.modules.get("compendium-json-importer").api.open());
    await gamePage.locator(WIN).waitFor();
    await gamePage.selectOption(`${WIN} select[name=typeFilter]`, filter);
    await gamePage.locator(`${WIN} input[name=sourceFile]`).setInputFiles(fixturePath(file));
    await gamePage.fill(`${WIN} input[name=newPackLabel]`, `Fit ${name}`);
    await gamePage.locator(`${WIN} input[name=newPackLabel]`).blur();
    await expect(gamePage.locator(`${WIN} input[name=newPackName]`)).not.toHaveValue("");
    await gamePage.fill(`${WIN} input[name=newPackName]`, name);
    await gamePage.locator(`${WIN} input[name=newPackName]`).blur();
    await gamePage.locator(`${WIN} footer button[type=submit]`).click();
    await expect(gamePage.locator(`${WIN} .cji-summary`)).toBeVisible({ timeout: 90_000 });
    await gamePage.waitForTimeout(800); // the scroll into view of the summary

    const windowBox = await visibleAt(gamePage, WIN);
    const title = await visibleAt(gamePage, `${WIN} .cji-summary h3`);
    const button = await visibleAt(gamePage, `${WIN} button[data-action=confirmImport]`);
    await gamePage.screenshot({ path: test.info().outputPath(`fit-${label}-revue-1160x816.png`) });
    evidence(`fit-${label}.json`, { viewport: { width: 1160, height: 816 }, window: windowBox, title, importButton: button });
    expect(windowBox.found && windowBox.inWindow, JSON.stringify(windowBox)).toBe(true);
    expect(title.found && title.inWindow && title.reachable, JSON.stringify(title)).toBe(true);
    expect(button.found && button.inWindow && button.reachable, JSON.stringify(button)).toBe(true);
    await expect(gamePage.locator(`${WIN} button[data-action=confirmImport]`)).toBeInViewport({ ratio: 1 });
    await expect(gamePage.locator(`${WIN} .cji-summary h3`)).toBeInViewport({ ratio: 1 });
  });
}

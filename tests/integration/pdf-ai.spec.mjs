// C5: unreadable blocks given to the local AI (Ollama) when the world setting `pdfAi` is on. Ollama is faked with
// Playwright's page.route on http://localhost:11434 (CORS preflight answered). Nothing leaves the machine.
import path from "node:path";
import { expect, test } from "../../../../test-env/fixtures.mjs";
import { clientDeletePacks, clientReadPack, evidence, uniqueName } from "./helpers.mjs";
import { SYNTHETIC, WIN, analyze, chooseFile, confirm, fakeOllama, fillNewPack, openWindow, readLang, syntheticFile } from "./pdf-helpers.mjs";
import { BLOCK_SCHEMA } from "../../scripts/core/pdf/ai-block.mjs";
import { buildAnswer, factsOf } from "../support/ai-answer.mjs";
import { expectedCreature, loadDoc } from "../support/synth.mjs";

const MODULE = "compendium-json-importer";
const en = readLang("en");
const created = [];

const partial = loadDoc(path.join(SYNTHETIC, "ref-partial.json"));
const reeve = expectedCreature(partial.flow.find((f) => f.creature?.name === "Smudged Reeve").creature, partial);
const honestAnswer = () => buildAnswer(BLOCK_SCHEMA, factsOf(reeve));

const setSetting = (key, value) => async (page) => page.evaluate(([k, v, id]) => game.settings.set(id, k, v), [key, value, MODULE]);

test.afterEach(async ({ gamePage, foundry }) => {
  await foundry(async (id) => { await foundry.applications.instances.get(id)?.close(); }, MODULE);
  await foundry(async (id) => {
    await game.settings.set(id, "pdfAi", false);
    await game.settings.set(id, "aiTimeout", 120);
  }, MODULE);
  await gamePage.unroute("http://localhost:11434/**").catch(() => {});
  if (created.length) await foundry(clientDeletePacks, created.splice(0));
});

async function startAnalysis(page, file) {
  const pack = uniqueName("ai");
  created.push(pack);
  await openWindow(page);
  await page.selectOption(`${WIN} select[name=typeFilter]`, "actors");
  await chooseFile(page, await syntheticFile(file));
  await fillNewPack(page, `AI ${pack}`, pack);
  await analyze(page);
  return pack;
}

test("C5: pdfAi on, the unreadable block is read by the AI, validated, marked 'read by AI' in the review and imported with readBy ai", async ({ gamePage, foundry }, testInfo) => {
  await setSetting("pdfAi", true)(gamePage);
  const ollama = await fakeOllama(gamePage, { answer: honestAnswer });
  const pack = await startAnalysis(gamePage, "ref-partial");
  await expect(gamePage.locator(`${WIN} .cji-summary`)).toBeVisible({ timeout: 60_000 });
  const text = await gamePage.locator(`${WIN} .cji-summary`).innerText();
  await gamePage.screenshot({ path: testInfo.outputPath("C5-revue-lu-par-ia.png") });

  const posts = ollama.posts().filter((c) => c.method === "POST");
  const chat = posts.find((c) => new URL(c.url).pathname === "/api/chat");
  expect(chat, "a chat request reached the (fake) Ollama").toBeTruthy();
  const sent = JSON.parse(chat.body);
  expect(sent.options?.temperature).toBe(0);
  expect(sent.options?.seed).toBe(0);
  expect(sent.format).toBeTruthy();
  await expect(gamePage.locator(`${WIN} .cji-badge-ai`)).toHaveCount(1);
  await expect(gamePage.locator(`${WIN} .cji-badge-ai`)).toContainText(en.Pdf.ReadByAi);
  expect(text).toContain("Smudged Reeve");
  expect(text, "no problem is left for this block").not.toMatch(/aiRejected|aiUnreachable/);

  await confirm(gamePage);
  await expect.poll(async () => (await foundry(clientReadPack, `world.${pack}`))?.length ?? 0, { timeout: 30_000 }).toBe(2);
  const docs = await foundry(clientReadPack, `world.${pack}`);
  const reeveDoc = docs.find((d) => d.name === "Smudged Reeve");
  evidence("C5-acteur-lu-par-ia.json", { flags: reeveDoc.flags[MODULE], ac: reeveDoc.system.attributes.ac, hp: reeveDoc.system.attributes.hp, items: reeveDoc.items.map((i) => i.name), requests: ollama.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`) });
  expect(reeveDoc.flags[MODULE].pdf.readBy).toBe("ai");
  expect(docs.find((d) => d.name === "Bone Piper").flags[MODULE].pdf.readBy).toBe("rules");
  expect(reeveDoc.system.attributes.ac.flat ?? reeveDoc.system.attributes.ac.override).toBe(16);
  expect(reeveDoc.system.attributes.hp.max).toBe(45);
  // the text of the abilities is the one of the source, not the model's
  const cudgel = reeveDoc.items.find((i) => i.name === "Cudgel");
  expect(cudgel.system.description.value).toContain("Melee Weapon Attack: +4 to hit");
  await ollama.stop();
});

test("C5: pdfAi off (default), no request to Ollama and the block is reported as a problem", async ({ gamePage }, testInfo) => {
  const ollama = await fakeOllama(gamePage, { answer: honestAnswer });
  await startAnalysis(gamePage, "ref-partial");
  await expect(gamePage.locator(`${WIN} .cji-summary`)).toBeVisible({ timeout: 30_000 });
  const text = await gamePage.locator(`${WIN} .cji-summary`).innerText();
  await gamePage.screenshot({ path: testInfo.outputPath("C5-sans-ia-bloc-signale.png") });
  expect(ollama.calls, "no request to port 11434").toEqual([]);
  expect(text).toContain("Smudged Reeve");
  await expect(gamePage.locator(`${WIN} .cji-badge-ai`)).toHaveCount(0);
});

test("C5: a model that invents a value (AC 99) is rejected: the block is not imported and the review says why", async ({ gamePage, foundry }, testInfo) => {
  await setSetting("pdfAi", true)(gamePage);
  const ollama = await fakeOllama(gamePage, {
    answer: () => {
      const a = honestAnswer();
      const k = Object.keys(a).find((x) => /^(ac|armorclass)$/i.test(x));
      a[k] = 99;
      return a;
    }
  });
  const pack = await startAnalysis(gamePage, "ref-partial");
  await expect(gamePage.locator(`${WIN} .cji-summary`)).toBeVisible({ timeout: 60_000 });
  const text = await gamePage.locator(`${WIN} .cji-summary`).innerText();
  await gamePage.screenshot({ path: testInfo.outputPath("C5-valeur-inventee-rejetee.png") });
  expect(ollama.posts().length).toBeGreaterThan(0);
  expect(text).toContain("Smudged Reeve");
  expect(text).toContain(en.Pdf.Reason.aiRejected.replace(/\{[^}]*\}.*$/, "").trim().slice(0, 25));
  await expect(gamePage.locator(`${WIN} .cji-badge-ai`)).toHaveCount(0);
  await confirm(gamePage);
  await expect.poll(async () => (await foundry(clientReadPack, `world.${pack}`))?.length ?? 0, { timeout: 30_000 }).toBe(1);
  expect((await foundry(clientReadPack, `world.${pack}`)).map((d) => d.name)).toEqual(["Bone Piper"]);
  await ollama.stop();
});

test("C5: unreachable server: two failures in a row stop the calls, the remaining blocks are reported 'unreachable'", async ({ gamePage }, testInfo) => {
  await setSetting("pdfAi", true)(gamePage);
  const ollama = await fakeOllama(gamePage, { answer: honestAnswer, mode: "unreachable" });
  await startAnalysis(gamePage, "ref-unreadable");
  await expect(gamePage.locator(`${WIN} .cji-summary`)).toBeVisible({ timeout: 60_000 });
  const text = await gamePage.locator(`${WIN} .cji-summary`).innerText();
  await gamePage.screenshot({ path: testInfo.outputPath("C5-ollama-injoignable.png") });
  evidence("C5-injoignable.json", { requests: ollama.calls.map((c) => `${c.method} ${c.url}`) });
  expect(ollama.calls.length, "at most two attempts before giving up").toBeLessThanOrEqual(2);
  expect(ollama.calls.length).toBeGreaterThanOrEqual(1);
  for (const name of ["Faded Scribe", "Faded Porter", "Faded Ferryman", "Faded Gaoler"]) expect(text).toContain(name);
  expect(text).toContain(en.Pdf.Reason.aiUnreachable.replace(/\{[^}]*\}.*$/, "").trim().slice(0, 20));
  await ollama.stop();
});

test("C5: the analysis can be cancelled while the model thinks; the pending request is aborted", async ({ gamePage, foundry }) => {
  await setSetting("pdfAi", true)(gamePage);
  let aborted = false;
  gamePage.on("requestfailed", (req) => { if (req.url().startsWith("http://localhost:11434")) aborted = true; });
  await gamePage.route("http://localhost:11434/**", async (route) => {
    const req = route.request();
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    if (new URL(req.url()).pathname === "/api/generate") return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: "{}" });
    await new Promise((r) => setTimeout(r, 20_000)); // the model never answers in time
    return route.abort().catch(() => {});
  });
  const pack = await startAnalysis(gamePage, "ref-partial");
  const cancel = gamePage.locator(`${WIN} [data-action=cancelAnalysis]`);
  await expect(cancel).toBeVisible({ timeout: 15_000 });
  await expect(gamePage.locator(`${WIN} .cji-status`)).toContainText(en.Progress.pdfAi.replace(/\{[^}]*\}.*$/, "").trim().slice(0, 8), { timeout: 15_000 });
  const t0 = Date.now();
  await cancel.click();
  await expect(gamePage.locator(`${WIN} footer button[type=submit]`)).toBeEnabled({ timeout: 3000 });
  expect(Date.now() - t0).toBeLessThan(1500);
  await expect.poll(() => aborted, { timeout: 3000 }).toBe(true);
  expect(await foundry(clientReadPack, `world.${pack}`)).toBeNull();
});

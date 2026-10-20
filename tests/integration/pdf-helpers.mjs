/* global window, document, MutationObserver */
// Helpers of the PDF import integration specs. Node-side functions build the PDFs (pdf-lib) and drive the window;
// the `client*` functions run INSIDE Foundry through `foundry(fn, arg)` and must stay self-contained.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "../../../../test-env/fixtures.mjs";
import { buildPdf, loadDoc } from "../support/synth.mjs";

export const MODULE_ID = "compendium-json-importer";
export const WIN = "#compendium-json-importer";
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SYNTHETIC = path.join(HERE, "..", "fixtures", "pdf", "synthetic");
export const BETTER_UNDEAD_PDF = path.join(HERE, "..", "..", "tools", "Better Undead Compendium.pdf");
export const hasBetterUndead = () => existsSync(BETTER_UNDEAD_PDF);
export const readLang = (code) => JSON.parse(readFileSync(path.join(HERE, "..", "..", "lang", `${code}.json`), "utf8"))[MODULE_ID];

/** PDF of a synthetic document, as a Playwright file payload. */
export async function syntheticFile(name) {
  const doc = loadDoc(path.join(SYNTHETIC, `${name}.json`));
  return { name: `${name}.pdf`, mimeType: "application/pdf", buffer: Buffer.from(await buildPdf(doc)) };
}

export async function openWindow(page) {
  await page.evaluate(() => game.modules.get("compendium-json-importer").api.open());
  await page.locator(WIN).waitFor();
}

/** `file` is a path (string) or a { name, mimeType, buffer } payload. */
export async function chooseFile(page, file) {
  await page.locator(`${WIN} input[name=sourceFile]`).setInputFiles(file);
}

export async function fillNewPack(page, label, name) {
  await page.fill(`${WIN} input[name=newPackLabel]`, label);
  await page.locator(`${WIN} input[name=newPackLabel]`).blur();
  await expect(page.locator(`${WIN} input[name=newPackName]`)).not.toHaveValue("");
  await page.fill(`${WIN} input[name=newPackName]`, name);
  await page.locator(`${WIN} input[name=newPackName]`).blur();
  await expect(page.locator(`${WIN} input[name=newPackName]`)).toHaveValue(name);
}

export const analyze = (page) => page.locator(`${WIN} footer button[type=submit]`).click();
export const confirm = (page) => page.locator(`${WIN} button[data-action=confirmImport]`).click();

/** Console warnings, errors and page errors, from now on. Call `.stop()` to read them. */
export function watchConsole(page) {
  const logs = [];
  const onConsole = (msg) => { if (["warning", "error"].includes(msg.type())) logs.push(`${msg.type()}: ${msg.text()}`); };
  const onError = (err) => logs.push(`pageerror: ${err.message}`);
  page.on("console", onConsole);
  page.on("pageerror", onError);
  return {
    logs,
    attributed: () => logs.filter((l) => /compendium-json-importer|pdf\.?js|pdfjs|deprecat|Failed to load resource|Unhandled/i.test(l)),
    stop() { page.off("console", onConsole); page.off("pageerror", onError); return logs; }
  };
}

/** Requests leaving the Foundry origin (C1: no external server). */
export function watchExternalRequests(page, baseURL) {
  const origin = new URL(baseURL).origin;
  const urls = [];
  const onRequest = (req) => {
    const u = req.url();
    if (/^(data|blob|about|chrome-extension):/.test(u)) return;
    if (new URL(u).origin !== origin) urls.push(u);
  };
  page.on("request", onRequest);
  return { urls, stop() { page.off("request", onRequest); return urls; } };
}

/** Records every distinct text of the progress line (`.cji-status`) from now on, in the page. */
export async function startStatusSampler(page) {
  await page.evaluate(() => {
    window.__cjiStatus = [];
    const read = () => {
      const el = document.querySelector("#compendium-json-importer .cji-status");
      const text = el?.textContent?.trim();
      if (text && window.__cjiStatus.at(-1) !== text) window.__cjiStatus.push(text);
    };
    window.__cjiObserver?.disconnect();
    window.__cjiObserver = new MutationObserver(read);
    window.__cjiObserver.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    read();
  });
}
export const readStatuses = (page) => page.evaluate(() => window.__cjiStatus ?? []);

/** Counts the Web Workers created from now on, and how many were terminated. */
export async function startWorkerProbe(page) {
  await page.evaluate(() => {
    if (window.__cjiWorkerOriginal) return;
    window.__cjiWorkerOriginal = window.Worker;
    window.__cjiWorkers = [];
    window.Worker = class extends window.__cjiWorkerOriginal {
      constructor(...args) { super(...args); this.__terminated = false; window.__cjiWorkers.push(this); }
      terminate() { this.__terminated = true; super.terminate(); }
    };
  });
}
export const workerCounts = (page) => page.evaluate(() => ({ created: window.__cjiWorkers?.length ?? 0, alive: (window.__cjiWorkers ?? []).filter((w) => !w.__terminated).length }));
export async function stopWorkerProbe(page) {
  await page.evaluate(() => {
    if (window.__cjiWorkerOriginal) { window.Worker = window.__cjiWorkerOriginal; delete window.__cjiWorkerOriginal; }
  });
}

/** Fake Ollama on http://localhost:11434 (CORS preflight answered). `answer(body)` returns the object the model "says". */
export async function fakeOllama(page, { answer, mode = "ok" } = {}) {
  const calls = [];
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
  await page.route("http://localhost:11434/**", async (route) => {
    const req = route.request();
    calls.push({ method: req.method(), url: req.url(), body: req.postData() ?? null });
    if (mode === "unreachable") return route.abort("connectionrefused");
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const url = new URL(req.url());
    if (url.pathname === "/api/chat") {
      const body = JSON.parse(req.postData() ?? "{}");
      return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify({ model: body.model, message: { role: "assistant", content: JSON.stringify(answer(body)) }, done: true }) });
    }
    if (url.pathname === "/api/generate") return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify({ response: "", done: true }) });
    if (url.pathname === "/api/tags") return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify({ models: [{ name: "llama3.1:8b" }] }) });
    return route.fulfill({ status: 404, headers: cors, body: "{}" });
  });
  return { calls, posts: () => calls.filter((c) => c.method !== "OPTIONS"), stop: () => page.unroute("http://localhost:11434/**") };
}

/** Reads a pack as plain objects. */
export async function clientReadPackDocs(packId) {
  const pack = game.packs.get(packId);
  if (!pack) return null;
  return (await pack.getDocuments()).map((d) => d.toObject());
}

/** Extracts the PDF bytes given as an array in the client (small synthetic files). */
export async function clientReadPdf(arg) {
  const api = game.modules.get("compendium-json-importer").api;
  const bytes = new Uint8Array(arg.bytes);
  const t0 = performance.now();
  const result = await api.readPdf(bytes, { fileName: arg.fileName, documentName: arg.documentName });
  return { entries: result.entries, meta: result.meta ?? null, report: result.report ?? null, ms: performance.now() - t0 };
}

/** Canonical form of a stored document: no random id, activities listed in a stable order. */
export function canonical(doc) {
  const strip = (v) => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v).sort()) {
        if (k === "_id" || k === "_key" || k === "_stats" || k === "sort") continue;
        if (k === "activities" && v[k] && typeof v[k] === "object") {
          out[k] = Object.values(v[k]).map(strip).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        } else out[k] = strip(v[k]);
      }
      return out;
    }
    return v;
  };
  return strip(doc);
}


/** Puts a local file in a hidden <input type=file> of the page (no copy of its bytes through the test); read it with `document.getElementById("cji-big-file").files[0]`. */
export async function bigFileInPage(page, filePath) {
  await page.evaluate(() => {
    document.getElementById("cji-big-file")?.remove();
    const input = document.createElement("input");
    input.type = "file";
    input.id = "cji-big-file";
    input.hidden = true;
    document.body.append(input);
  });
  await page.locator("#cji-big-file").setInputFiles(filePath);
}

/**
 * Full UI import of a synthetic document into a new compendium ("actors" | "items" filter).
 * enrich: false keeps the descriptions as read. Returns the review text and the stored documents (want = expected count).
 */
export async function importPdfDoc(page, foundry, created, { file, filter, name, enrich = false, want = 1, confirmImport = true }) {
  const { clientReadPack, uniqueName } = await import("./helpers.mjs");
  const pack = uniqueName(name);
  created.push(pack);
  await foundry(async (id) => { await foundry.applications.instances.get(id)?.close(); }, MODULE_ID);
  await openWindow(page);
  await page.selectOption(`${WIN} select[name=typeFilter]`, filter);
  await chooseFile(page, await syntheticFile(file));
  await fillNewPack(page, `PDF ${pack}`, pack);
  const enrichBox = page.locator(`${WIN} input[name=enrich]`);
  if (await enrichBox.count()) await enrichBox.setChecked(enrich);
  await analyze(page);
  await expect(page.locator(`${WIN} .cji-summary`)).toBeVisible({ timeout: 60_000 });
  const reviewText = await page.locator(`${WIN} .cji-summary`).innerText();
  if (!confirmImport) return { pack, docs: [], reviewText };
  await confirm(page);
  const deadline = Date.now() + 30_000;
  let docs = [];
  while (Date.now() < deadline) {
    docs = (await foundry(clientReadPack, `world.${pack}`)) ?? [];
    if (docs.length >= want) break;
    await page.waitForTimeout(500);
  }
  return { pack, docs, reviewText };
}

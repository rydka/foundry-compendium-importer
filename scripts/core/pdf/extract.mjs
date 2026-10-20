/**
 * Deterministic extraction of a document: stat blocks to NPC sources, magic items to item sources, problems for
 * the review (C4), the blocks the rules could not read for the local AI (C5), and the scanned-PDF check (C7).
 * `extractDocument` runs in one go; `extractDocumentAsync` yields between pages and can be cancelled.
 *
 * A block that reaches the bottom of its page stays open: when the next page does not start with a title, its
 * lines continue the block (sections, entries, the entry cut by the page break, or the stat lines). A block that
 * stops at a page bottom without a continuation and looks unfinished is reported as `blockCut` (C4).
 */
import { isFooterLine, pageColumns, pageText } from "./layout.mjs";
import { closeStatBlock, continueStatBlock, entryCount, findStatBlocks, isAcLine, readStatBlock, TITLE_RATIO } from "./stat-block.mjs";
import { hasRequiredStats, parseSizeLine, parseStatLines } from "./stat-lines.mjs";
import { toActorSource } from "./creature.mjs";
import { findMagicItems, toItemSource } from "./magic-item.mjs";

const SCANNED_AVERAGE = 50;
const SCANNED_MAX = 200;
const SENTENCE_END = /[.!?)»"”’']$/u;

/**
 * A scanned PDF: images without text (less than 50 characters per page on average and no page over 200).
 * @param {object[]} pages
 * @returns {boolean}
 */
export function isScanned(pages) {
  if ( !pages?.length ) return true;
  const lengths = pages.map(page => (page.items ?? []).reduce((n, w) => n + w.str.length, 0));
  const average = lengths.reduce((a, b) => a + b, 0) / pages.length;
  return average < SCANNED_AVERAGE && !lengths.some(n => n > SCANNED_MAX);
}

/** Empty result of an extraction. */
function emptyResult(pages) {
  return { actors: [], items: [], blocks: [], problems: [], aiQueue: [], scanned: false,
    stats: { pages: pages.length, acLines: 0, blocksFound: 0, blocksRead: 0, itemsFound: 0 } };
}

/** Lines of a block region: from its size line (title included when found) to the next title-sized line. */
function regionLines(lines, block) {
  const start = block.titleLine ? lines.indexOf(block.titleLine) : block.index;
  const titleMin = TITLE_RATIO * block.bodySize;
  const out = [];
  for ( let i = Math.max(0, start); i < lines.length; i++ ) {
    const line = lines[i];
    if ( i > start && line.size >= titleMin && line !== block.sizeLine ) break;
    out.push(line);
  }
  return out;
}

/**
 * A block that stopped at a page bottom looks unfinished: its last entry is cut mid-sentence. A block without any
 * entry is not "cut" but unreadable (`noEntries`, a candidate for the local AI).
 */
function looksCut(read) {
  if ( !entryCount(read) ) return false;
  const current = read.cursor?.current;
  const last = current ?? ["legendary", "reactions", "bonus", "actions", "features"].map(s => read[s].at(-1)).find(Boolean);
  return !!last && !SENTENCE_END.test(String(last.text ?? "").trim());
}

/**
 * Finish an open block: close its entry, parse its stat lines, produce the actor or the problem.
 * @param {object} open  `{ read, name, page, rank, region }`
 * @param {object} ctx
 * @param {object} result
 * @param {{cut?: boolean}} [flags]  `cut`: the block stopped at a page bottom without a continuation.
 */
function finalizeBlock(open, ctx, result, { cut = false } = {}) {
  const { parser = null, fileName = "" } = ctx;
  const toFeet = ctx.toFeet ?? parser?.toFeet;
  const { read, name, page, rank, region, found } = open;
  closeStatBlock(read);
  const lastPage = read.pages?.at(-1) ?? page;
  const fail = (reason, detail = null) => {
    result.blocks.push({ name, page, status: "failed" });
    result.problems.push({ name, page: lastPage, reason, detail });
    result.aiQueue.push({ name, page, rank, lines: region.map(l => l.text), block: found });
  };
  const stats = parseStatLines(read.statLines, { toFeet });
  if ( !hasRequiredStats(stats) ) {
    fail("missingStats", { missing: ["ac", "hp", "speed", "abilities"].filter(k => !stats[k]) });
    return;
  }
  if ( !entryCount(read) ) { fail("noEntries"); return; }
  // Imported, but flagged: the GM checks the last actions of the creature (C4)
  if ( cut ) result.problems.push({ name, page: lastPage, reason: "blockCut", detail: { imported: true } });
  const size = parseSizeLine(read.sizeLine ?? found.sizeLine.text);
  result.actors.push(toActorSource(read, stats, { parser, source: fileName, page, rank, readBy: "rules", size }));
  result.blocks.push({ name: read.title, page, status: "rules" });
  result.stats.blocksRead++;
}

/**
 * Stat blocks of one page, added to the result. `state.open` carries a block that reached the bottom of the
 * previous page.
 * @param {object} page  Page model.
 * @param {{parser: object, fileName: string, toFeet?: Function}} ctx
 * @param {object} result
 * @param {{open: object|null}} [state]
 * @param {{last?: boolean}} [flags]  `last`: this is the last page of the document.
 */
export function extractPage(page, ctx, result, state = { open: null }, { last = true } = {}) {
  const columns = pageColumns(page);
  const lines = columns.flat();
  const acCount = lines.filter(line => isAcLine(line.text)).length;
  result.stats.acLines += acCount;
  const found = findStatBlocks(columns, { page: page.number });
  result.stats.blocksFound += found.length;
  if ( acCount > found.length ) {
    result.problems.push({ name: null, page: page.number, reason: "countMismatch",
      detail: { acLines: acCount, blocks: found.length } });
  }

  // A block left open by the previous page: this page continues it unless it starts with a title
  if ( state.open ) {
    const open = state.open;
    state.open = null;
    const first = lines.find(l => !isFooterLine(l.text));
    const startsWithTitle = !first || found.some(f => f.titleLine === first) || (first.size >= TITLE_RATIO * open.read.bodySize);
    if ( !startsWithTitle ) continueStatBlock(columns, open.read, { page: page.number });
    if ( !startsWithTitle && (open.read.ended === "end") && !last ) state.open = open;
    else finalizeBlock(open, ctx, result, { cut: (open.read.ended === "end") && looksCut(open.read) });
  }

  const ranks = new Map();
  for ( const block of found ) {
    const name = block.title ?? lines[Math.max(0, block.index - 1)]?.text ?? "?";
    // Rank of the block among those of the same name on the page (part of the stable id)
    const rank = ranks.get(name) ?? 0;
    ranks.set(name, rank + 1);
    const region = regionLines(lines, block);
    const fail = (reason, detail = null) => {
      result.blocks.push({ name, page: page.number, status: "failed" });
      result.problems.push({ name, page: page.number, reason, detail });
      result.aiQueue.push({ name, page: page.number, rank, lines: region.map(l => l.text), block });
    };
    if ( !block.title ) { fail("noTitle"); continue; }
    const read = readStatBlock(columns, block, { page: page.number });
    if ( read.error ) { fail(read.error); continue; }
    const open = { read, name, page: page.number, rank, region, found: block };
    if ( (read.ended === "end") && !last ) state.open = open;
    else finalizeBlock(open, ctx, result, { cut: (read.ended === "end") && looksCut(read) });
  }
}

/** Finish the block still open after the last page. */
export function finishPages(ctx, result, state) {
  if ( !state?.open ) return;
  const open = state.open;
  state.open = null;
  finalizeBlock(open, ctx, result, { cut: looksCut(open.read) });
}

/**
 * Magic items of the document, added to the result.
 * @param {object[]} pages
 * @param {{parser: object, fileName: string}} ctx
 * @param {object} result
 */
export function extractItems(pages, ctx, result) {
  const { parser = null, fileName = "" } = ctx;
  if ( !parser?.parseItem ) return;
  const ranks = new Map();
  for ( const found of findMagicItems(pages, { parser }) ) {
    if ( !found.name ) {
      result.problems.push({ name: found.typeLine, page: found.page, reason: "itemNoTitle", detail: null });
      continue;
    }
    const key = `${found.page}|${found.name}`;
    const rank = ranks.get(key) ?? 0;
    ranks.set(key, rank + 1);
    result.items.push(toItemSource(found, { parser, source: fileName, rank }));
    result.stats.itemsFound++;
  }
}

/**
 * Extract the creatures and magic items of a document.
 * @param {object[]} pages  Page models (`toPageModel`), in order.
 * @param {object} ctx  `{ parser, fileName, toFeet }`: `parser` is the dnd5e-text-parser API, `toFeet` defaults
 *   to `parser.toFeet`.
 * @returns {{actors: object[], items: object[], blocks: object[], problems: object[], aiQueue: object[],
 *   stats: object, scanned: boolean}}
 *   `blocks` = `[{ name, page, status: "rules"|"failed" }]`; `problems` = `[{ name, page, reason, detail }]`;
 *   `aiQueue` = `[{ name, page, rank, lines, block }]` (the lines of the block region, for the local AI).
 */
export function extractDocument(pages, ctx = {}) {
  const result = emptyResult(pages);
  if ( isScanned(pages) ) {
    result.scanned = true;
    return result;
  }
  const state = { open: null };
  pages.forEach((page, i) => extractPage(page, ctx, result, state, { last: i === pages.length - 1 }));
  finishPages(ctx, result, state);
  extractItems(pages, ctx, result);
  return result;
}

/** The error thrown by `extractDocumentAsync` when its signal is aborted (`name` is "AbortError"). */
export const abortError = () => Object.assign(new Error("extraction aborted"), { name: "AbortError" });

/**
 * Same as `extractDocument`, one page per turn: `yieldTo` (a function returning a promise, e.g. a zero timer)
 * is awaited between pages so the interface stays responsive, and `signal` cancels the extraction.
 * @param {object[]} pages
 * @param {object} [ctx]
 * @param {{signal?: AbortSignal, yieldTo?: () => Promise<void>}} [opts]
 * @returns {Promise<object>}
 */
export async function extractDocumentAsync(pages, ctx = {}, { signal, yieldTo } = {}) {
  const result = emptyResult(pages);
  if ( isScanned(pages) ) {
    result.scanned = true;
    return result;
  }
  const state = { open: null };
  for ( const [i, page] of pages.entries() ) {
    if ( signal?.aborted ) throw abortError();
    extractPage(page, ctx, result, state, { last: i === pages.length - 1 });
    if ( yieldTo ) await yieldTo();
  }
  finishPages(ctx, result, state);
  if ( signal?.aborted ) throw abortError();
  extractItems(pages, ctx, result);
  return result;
}

/** Text of the whole document, page by page (debugging and the AI prompt). */
export const documentText = pages => pages.map(pageText);

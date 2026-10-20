/**
 * Deterministic extraction of a document: stat blocks to NPC sources, magic items to item sources, problems for
 * the review (C4), the blocks the rules could not read for the local AI (C5), and the scanned-PDF check (C7).
 * `extractDocument` runs in one go; `extractDocumentAsync` yields between pages and can be cancelled.
 */
import { pageColumns, pageText } from "./layout.mjs";
import { findStatBlocks, isAcLine, readStatBlock } from "./stat-block.mjs";
import { hasRequiredStats, parseSizeLine, parseStatLines } from "./stat-lines.mjs";
import { toActorSource } from "./creature.mjs";
import { findMagicItems, toItemSource } from "./magic-item.mjs";

const SCANNED_AVERAGE = 50;
const SCANNED_MAX = 200;

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
  const titleMin = 1.5 * block.bodySize;
  const out = [];
  for ( let i = Math.max(0, start); i < lines.length; i++ ) {
    const line = lines[i];
    if ( i > start && line.size >= titleMin && line !== block.sizeLine ) break;
    out.push(line);
  }
  return out;
}

/**
 * Stat blocks of one page, added to the result.
 * @param {object} page  Page model.
 * @param {{parser: object, fileName: string, toFeet?: Function}} ctx
 * @param {object} result
 */
export function extractPage(page, ctx, result) {
  const { parser = null, fileName = "" } = ctx;
  const toFeet = ctx.toFeet ?? parser?.toFeet;
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
    const stats = parseStatLines(read.statLines, { toFeet });
    if ( !hasRequiredStats(stats) ) {
      fail("missingStats", { missing: ["ac", "hp", "speed", "abilities"].filter(k => !stats[k]) });
      continue;
    }
    const size = parseSizeLine(read.sizeLine ?? block.sizeLine.text);
    result.actors.push(toActorSource(read, stats, { parser, source: fileName, page: page.number, rank, readBy: "rules", size }));
    result.blocks.push({ name: read.title, page: page.number, status: "rules" });
    result.stats.blocksRead++;
  }
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
  for ( const page of pages ) extractPage(page, ctx, result);
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
  for ( const page of pages ) {
    if ( signal?.aborted ) throw abortError();
    extractPage(page, ctx, result);
    if ( yieldTo ) await yieldTo();
  }
  if ( signal?.aborted ) throw abortError();
  extractItems(pages, ctx, result);
  return result;
}

/** Text of the whole document, page by page (debugging and the AI prompt). */
export const documentText = pages => pages.map(pageText);

/**
 * Deterministic extraction of a document: stat blocks to NPC sources, magic items to item sources, problems for
 * the review (C4), the blocks the rules could not read for the local AI (C5), and the scanned-PDF check (C7).
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

/**
 * Extract the creatures and magic items of a document.
 * @param {object[]} pages  Page models (`toPageModel`), in order.
 * @param {object} ctx  `{ parser, fileName, toFeet }`: `parser` is the dnd5e-text-parser API, `toFeet` defaults
 *   to `parser.toFeet`.
 * @returns {{actors: object[], items: object[], blocks: object[], problems: object[], aiQueue: object[],
 *   stats: object, scanned: boolean}}
 *   `blocks` = `[{ name, page, status: "rules"|"failed" }]`; `problems` = `[{ name, page, reason, detail }]`;
 *   `aiQueue` = `[{ name, page, lines, block }]` (the lines of the block region, for the local AI).
 */
export function extractDocument(pages, ctx = {}) {
  const { parser = null, fileName = "" } = ctx;
  const toFeet = ctx.toFeet ?? parser?.toFeet;
  const result = { actors: [], items: [], blocks: [], problems: [], aiQueue: [], scanned: false,
    stats: { pages: pages.length, acLines: 0, blocksFound: 0, blocksRead: 0, itemsFound: 0 } };
  if ( isScanned(pages) ) {
    result.scanned = true;
    return result;
  }

  for ( const page of pages ) {
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
    for ( const block of found ) {
      const name = block.title ?? lines[Math.max(0, block.index - 1)]?.text ?? "?";
      const region = regionLines(lines, block);
      const fail = (reason, detail = null) => {
        result.blocks.push({ name, page: page.number, status: "failed" });
        result.problems.push({ name, page: page.number, reason, detail });
        result.aiQueue.push({ name, page: page.number, lines: region.map(l => l.text), block });
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
      result.actors.push(toActorSource(read, stats, { parser, source: fileName, page: page.number, readBy: "rules", size }));
      result.blocks.push({ name: read.title, page: page.number, status: "rules" });
      result.stats.blocksRead++;
    }
  }

  if ( parser?.parseItem ) {
    for ( const found of findMagicItems(pages, { parser }) ) {
      if ( !found.name ) {
        result.problems.push({ name: found.typeLine, page: found.page, reason: "itemNoTitle", detail: null });
        continue;
      }
      result.items.push(toItemSource(found, { parser, source: fileName }));
      result.stats.itemsFound++;
    }
  }
  return result;
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

/** Text of the whole document, page by page (debugging and the AI prompt). */
export const documentText = pages => pages.map(pageText);

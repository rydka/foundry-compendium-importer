/**
 * Magic items of a PDF: a header line ("Wondrous Item (Spellbook), Legendary", "Objet merveilleux, rare (nécessite
 * un lien d'harmonisation)") under a heading set larger than the body, then the body until the next heading of the
 * title's size, another item, a stat block or the end of the document.
 */
import { pageLines } from "./layout.mjs";
import { LEXICON, fold } from "./lexicon.mjs";
import { findStatBlocks } from "./stat-block.mjs";
import { stableId } from "./stable-id.mjs";

const MODULE_ID = "compendium-json-importer";
const HEADER_MAX_LENGTH = 120;
const HEADING_RATIO = 1.1;
const PARAGRAPH_GAP = 1.4;

const escapeHtml = text => String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Header line rewritten with the words the text parser knows (French variants of the rarities and of the
 * attunement, see `LEXICON.itemHeaderAliases`).
 * @param {string} line
 * @returns {string}
 */
export function normalizeHeader(line) {
  let out = String(line ?? "");
  for ( const [from, to] of LEXICON.itemHeaderAliases ) {
    out = out.replace(new RegExp(`(?<![\\p{L}])${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}])`, "giu"), to);
  }
  return out;
}

/**
 * Item kind and rarity of a header line, read by the text parser; null when the line is not an item header.
 * @param {string} line
 * @param {object} parser
 * @returns {{kind: string|null, rarity: string|null, attunement: string|null}|null}
 */
export function readHeader(line, parser) {
  const text = String(line ?? "").trim();
  if ( !text || text.length > HEADER_MAX_LENGTH || !parser?.parseItem ) return null;
  const plan = parser.parseItem("", `<p>${escapeHtml(normalizeHeader(text))}</p>`);
  const kind = plan?.itemKind ?? null;
  const rarity = plan?.details?.rarity ?? null;
  if ( !kind && !rarity ) return null;
  return { kind, rarity, attunement: plan?.details?.attunement ?? null };
}

/**
 * Find the magic items of a document.
 * @param {object[]} pages  Page models.
 * @param {{parser: object}} ctx
 * @returns {{name: string, page: number, typeLine: string, header: object, html: string, titleSize: number}[]}
 */
export function findMagicItems(pages, { parser }) {
  // All the lines of the document in reading order, with their page; stat block titles are stop lines
  const all = [];
  const stops = new Set();
  for ( const page of pages ) {
    const lines = pageLines(page);
    for ( const block of findStatBlocks(lines, { page: page.number }) ) if ( block.titleLine ) stops.add(block.titleLine);
    for ( const line of lines ) all.push({ line, page: page.number });
  }
  const found = [];
  const headers = new Set();
  for ( let i = 1; i < all.length; i++ ) {
    const { line, page } = all[i];
    const bodySize = line.size;
    const above = all[i - 1].line;
    if ( all[i - 1].page !== page || above.size < HEADING_RATIO * bodySize ) continue;
    const header = readHeader(line.text, parser);
    if ( !header ) continue;
    // Title: consecutive heading lines above, top to bottom ("Censored Translation of the" / "Tome of Decay"). A line
    // set larger than the one below it is a chapter title, not a part of the name
    let first = i - 1;
    while ( first > 0 && all[first - 1].page === page && all[first - 1].line.size >= HEADING_RATIO * bodySize
      && all[first - 1].line.size <= all[first].line.size + 0.5
      && !stops.has(all[first - 1].line) && !headers.has(all[first - 1].line) ) first--;
    const titleLines = all.slice(first, i).map(e => e.line);
    const titleSize = Math.max(...titleLines.map(l => l.size));
    headers.add(line);
    found.push({ name: titleLines.map(l => l.text).join(" "), page, typeLine: line.text, header, titleSize, bodySize, start: i + 1, first });
  }
  // Body of each item: until a heading of the title's size, another item header, a stat block title or the end
  for ( const [n, item] of found.entries() ) {
    const nextFirst = found[n + 1]?.first ?? all.length;
    const parts = [];
    let paragraph = [];
    let previous = null;
    const flush = () => { if ( paragraph.length ) parts.push({ kind: "p", text: paragraph.join(" ") }); paragraph = []; };
    for ( let i = item.start; i < nextFirst; i++ ) {
      const { line, page } = all[i];
      if ( stops.has(line) || (line.size >= item.titleSize) ) break;
      if ( line.size >= HEADING_RATIO * item.bodySize ) {
        flush();
        parts.push({ kind: "h4", text: line.text });
      } else {
        const sameColumn = previous && (previous.page === page) && (previous.line.col === line.col);
        const gap = sameColumn ? previous.line.y - line.y : 0;
        if ( sameColumn && (gap > PARAGRAPH_GAP * Math.max(line.size, 1) * 1.25) ) flush();
        paragraph.push(line.text);
      }
      previous = { line, page };
    }
    flush();
    item.html = parts.map(p => (p.kind === "h4" ? `<h4>${escapeHtml(p.text)}</h4>` : `<p>${escapeHtml(p.text)}</p>`)).join("\n");
    delete item.start;
    delete item.first;
  }
  return found;
}

/**
 * dnd5e 6 item source of a found magic item: document type and `system.type` from the item kind
 * (`LEXICON.itemTypes`), rarity in `system.rarities`, attunement, header line and body in the description.
 * @param {object} found  Entry of `findMagicItems`.
 * @param {{parser: object, source?: string, readBy?: string}} ctx
 * @returns {object}
 */
export function toItemSource(found, { parser, source = "", readBy = "rules" } = {}) {
  const description = `<p><em>${escapeHtml(found.typeLine)}</em></p>\n${found.html ?? ""}`;
  const plan = parser?.parseItem ? parser.parseItem(found.name, `<p>${escapeHtml(normalizeHeader(found.typeLine))}</p>\n${found.html ?? ""}`) : null;
  const kind = plan?.itemKind ?? found.header?.kind ?? "wondrous";
  const mapping = LEXICON.itemTypes[kind] ?? LEXICON.itemTypes.wondrous;
  const system = { description: { value: description } };
  if ( mapping.value ) {
    // `baseItem` exists on weapons and equipment, not on consumables (dnd5e 6 rejects unknown fields)
    system.type = mapping.type === "consumable" ? { value: mapping.value } : { value: mapping.value, baseItem: mapping.baseItem ?? "" };
  }
  if ( mapping.properties ) system.properties = [...mapping.properties];
  const rarity = plan?.details?.rarity ?? found.header?.rarity;
  if ( rarity ) system.rarities = [rarity];
  const attunement = plan?.details?.attunement ?? found.header?.attunement;
  if ( attunement ) system.attunement = attunement;
  return {
    _id: stableId(`${source}|${found.page}|${found.name}|item`),
    name: found.name,
    type: mapping.type,
    img: "icons/svg/item-bag.svg",
    system,
    flags: { [MODULE_ID]: { pdf: { source, page: found.page, readBy } } }
  };
}

/**
 * True when a page text may hold an item header (a word of `LEXICON.itemKindWords`): a cheap filter, before the
 * fonts of a page are resolved.
 * @param {string} text
 * @returns {boolean}
 */
export function mayHoldItemHeader(text) {
  const low = fold(text);
  return LEXICON.itemKindWords.some(w => low.includes(fold(w)));
}

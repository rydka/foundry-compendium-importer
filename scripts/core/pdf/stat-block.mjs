/**
 * Stat blocks of a page: detection (size line followed by an AC label, title above) and reading from the layout
 * (columns, fonts). Port of `is_title_line`, `find_stat_block_title`, `entry_start` and `read_stat_block` of the
 * Python tool, with thresholds relative to the body size (the size of the AC line): title ≥ 1.5×, header ≥ 1.1×.
 */
import { fontFamily, fontStyle, inferEntryFont, isUnresolved } from "./fonts.mjs";
import { isFooterLine, joinWords, normalizeSpace, pageColumns } from "./layout.mjs";
import { ABILITY_CELL_RE, ABILITY_ROW_RE, LEXICON, isWord, labelOf, labelRegex, sectionOf } from "./lexicon.mjs";
import { isSizeLine } from "./stat-lines.mjs";

export const TITLE_RATIO = 1.5;
export const HEADER_RATIO = 1.1;
const AC_LOOKAHEAD = 6;
const TITLE_LOOKBACK = 12;
const SECTION_NAMES = new Set(Object.keys(LEXICON.sections));
const TITLE_SMALL_WORDS = new Set(["of", "the", "a", "an", "and", "in", "on", "de", "du", "des", "la", "le", "les", "l'", "d'", "et", "à", "au", "aux"]);
const ABILITY_CELL = new RegExp(ABILITY_CELL_RE.source, "iu");

const lineText = line => (typeof line === "string" ? line : line?.text ?? "");
const lineSize = line => (typeof line === "string" ? 0 : line?.size ?? 0);

/** "Armor Class 16", "AC 17 Initiative +2 (12)": an AC label with a value. */
export const isAcLine = text => labelRegex("ac").test(lineText(text)) && /\d/.test(lineText(text));

/**
 * A stat block title: a short Title Case line that is not a feature ("Shadow Meld."), a section, a size line or a
 * stat label; or, when `bodySize` is known, any short line set at least 1.5× larger than the body (French titles
 * are not in Title Case).
 * @param {string|object} line  Text, or a line of the layout.
 * @param {number} [bodySize]
 * @returns {boolean}
 */
export function isTitleLine(line, bodySize = 0) {
  const s = normalizeSpace(lineText(line));
  const words = s.split(" ");
  if ( !words[0] || words.length > 8 || s.length > 60 || /[.,:;]$/.test(s) ) return false;
  if ( sectionOf(s) || isSizeLine(s) || labelOf(s) || ABILITY_ROW_RE.test(s) || isFooterLine(s) ) return false;
  if ( isWord(LEXICON.headerTraits, s) ) return false;
  if ( !/^\p{Lu}/u.test(words[0]) ) return false;
  if ( bodySize && (lineSize(line) >= TITLE_RATIO * bodySize) ) return true;
  if ( words.length > 6 || s.length > 48 ) return false;
  return words.every(w => /^[\p{Lu}\d(«"'’]/u.test(w) || TITLE_SMALL_WORDS.has(w.toLowerCase()));
}

/**
 * Stat blocks of a page: every size line followed by an AC line within six lines, with the nearest title above.
 * @param {object[]|object[][]} columnsOrLines  Lines in reading order (`pageLines`), or the columns (`pageColumns`).
 * @param {{page?: number}} [opts]
 * @returns {{title: string|null, titleLine: object|null, sizeLine: object, acLine: object, bodySize: number,
 *   index: number, col: number, page: number}[]}
 */
export function findStatBlocks(columnsOrLines, { page = 0 } = {}) {
  const lines = Array.isArray(columnsOrLines[0]) ? columnsOrLines.flat() : columnsOrLines;
  const found = [];
  const used = new Set();
  for ( let i = 0; i < lines.length; i++ ) {
    const line = lines[i];
    if ( !isSizeLine(lineText(line)) ) continue;
    const acLine = lines.slice(i + 1, i + 1 + AC_LOOKAHEAD).find(l => isAcLine(lineText(l)));
    if ( !acLine ) continue;
    const bodySize = lineSize(acLine);
    let titleLine = null;
    for ( let j = i - 1; j >= Math.max(0, i - TITLE_LOOKBACK); j-- ) {
      const candidate = lines[j];
      if ( used.has(candidate) ) break;
      if ( isTitleLine(candidate, bodySize) ) { titleLine = candidate; break; }
    }
    if ( titleLine ) used.add(titleLine);
    found.push({
      title: titleLine ? normalizeSpace(lineText(titleLine)) : null, titleLine, sizeLine: line, acLine, bodySize,
      index: i, col: typeof line === "string" ? 0 : line.col ?? 0, page
    });
  }
  return found;
}

/**
 * (name, meta, rest of the line) when the line starts a trait or an action: a name in the entry font ("Shadow
 * Meld.", "Gory Feast The Striga feasts..."). Null otherwise.
 * @param {object} line
 * @param {(word: object) => boolean} isEntryWord
 * @returns {{name: string, meta: string, rest: string}|null}
 */
export function entryStart(line, isEntryWord) {
  const words = line.words ?? [];
  if ( !words.length || !isEntryWord(words[0]) ) return null;
  let n = 0;
  while ( n < words.length && isEntryWord(words[n]) ) n++;
  const head = joinWords(words.slice(0, n));
  let rest = joinWords(words.slice(n));
  const m = head.match(/^(.+?)(?:\s*\(([^)]*)\))?\s*[.:]?$/);
  let name = m ? normalizeSpace(m[1]) : head.replace(/[.:]+$/, "");
  let meta = m ? normalizeSpace(m[2] ?? "") : "";
  if ( meta && rest.startsWith(")") ) rest = rest.slice(1).replace(/^[. ]+/, "");
  // A meta in regular font after the name: "Name (Recharge 5-6)." is sometimes split over two fonts
  const mm = rest.match(/^\(([^)]*)\)\.?\s*(.*)$/);
  if ( !meta && mm ) { meta = normalizeSpace(mm[1]); rest = mm[2]; }
  name = name.replace(/[.:]+$/, "").trim();
  if ( !name ) return null;
  return { name, meta, rest };
}

/**
 * Entry-word predicate of a block: bold italic words of the body family (2014 layouts), bold words when the block
 * has no bold italic head (2024 layouts), or, when the font names are unresolved, the inferred entry font.
 * @param {object[]} lines  Lines of the block region.
 * @param {string} bodyFamily
 * @param {string[]} bodyFonts  Fonts that cannot be the entry font (regular body font).
 * @returns {{isEntryWord: Function, style: "boldItalic"|"bold"|"inferred"|null}}
 */
export function entryPredicate(lines, bodyFamily, bodyFonts) {
  const fonts = new Set(lines.flatMap(l => l.words.map(w => w.font)));
  const resolved = [...fonts].some(f => !isUnresolved(f) && fontStyle(f).known);
  if ( resolved ) {
    const boldItalic = lines.some(l => {
      const w = l.words[0];
      const s = fontStyle(w.font);
      return s.bold && s.italic && (fontFamily(w.font) === bodyFamily);
    });
    const isEntryWord = w => {
      const s = fontStyle(w.font);
      return s.bold && (!boldItalic || s.italic) && (fontFamily(w.font) === bodyFamily);
    };
    return { isEntryWord, style: boldItalic ? "boldItalic" : "bold" };
  }
  const inferred = inferEntryFont(lines, bodyFonts);
  if ( !inferred ) return { isEntryWord: () => false, style: null };
  return { isEntryWord: w => w.font === inferred, style: "inferred" };
}

/**
 * Read lines into a block, from a position of the columns. Shared by the first page of a block and its
 * continuation on the next page. The cursor carries the state between calls: section, entries open, the entry
 * being read (closed only when the block is finalized, because its text may go on over the page break).
 * @param {object[][]} columns
 * @param {{c: number, i: number}} start  First line to read (inclusive).
 * @param {object} cursor  `{ block, bodyFamily, bodySize, isEntryWord, section, inEntries, current, pageContinuation }`
 * @returns {"title"|"sidebar"|"break"|"end"}  Why the reading stopped: another title, a sidebar or heading, lore
 *   or text that is not the block's (`break`), or the end of the page (`end`: the block may go on).
 */
function readBlockLines(columns, start, cursor) {
  const { block, bodyFamily, bodySize, isEntryWord } = cursor;
  const titleMin = TITLE_RATIO * bodySize;
  const headerMin = HEADER_RATIO * bodySize;
  const isBodyLine = line => line.words.some(w => fontFamily(w.font) === bodyFamily);
  const isStatLine = text => !!labelOf(text) || ABILITY_ROW_RE.test(text) || ABILITY_CELL.test(text) || isSizeLine(text);
  const close = () => {
    if ( cursor.current ) {
      const { section, name, meta, text } = cursor.current;
      block[section].push({ name, meta, text: normalizeSpace(text) });
    }
    cursor.current = null;
  };
  for ( let c = start.c; c < columns.length; c++ ) {
    const lines = c === start.c ? columns[c].slice(start.i) : columns[c];
    // A column (or a page) that continues the block starts with lore or a quote in another font, or with the
    // block itself. In the other column, body text that is not an entry is lore (Python rule); at the top of
    // the next page, it is the rest of the entry cut by the page break.
    let continuation = (c !== start.c) || !!cursor.pageContinuation;
    for ( const line of lines ) {
      const text = line.text;
      if ( isFooterLine(text) ) continue;
      if ( line.size >= titleMin ) return "title";
      const body = isBodyLine(line);
      if ( line.size >= headerMin ) {
        const sectionKey = sectionOf(text);
        if ( sectionKey && SECTION_NAMES.has(sectionKey) ) {
          close();
          cursor.section = sectionKey;
          cursor.inEntries = true;
          continuation = false;
          continue;
        }
        if ( isWord(LEXICON.headerTraits, text) && cursor.inEntries ) {
          close();
          cursor.current = { section: "features", name: normalizeSpace(text).replace(/[.:]+$/, ""), meta: "", text: "" };
          continuation = false;
          continue;
        }
        if ( !body ) {
          if ( continuation ) continue;
          return "sidebar";
        }
      }
      if ( !body ) {
        if ( continuation ) continue;
        if ( cursor.inEntries ) return "break";
        continue;
      }
      if ( !cursor.inEntries && !block.sizeLine && isSizeLine(text) ) { block.sizeLine = text; continue; }
      const stat = !cursor.inEntries && isStatLine(text);
      const start_ = stat ? null : entryStart(line, isEntryWord);
      const firstStyle = fontStyle(line.words[0].font);
      const continuesEntry = cursor.pageContinuation && (cursor.current || !cursor.inEntries);
      if ( continuation && !start_ && !(firstStyle.italic && cursor.current) && !continuesEntry ) return "break";
      continuation = false;
      if ( start_ ) {
        close();
        cursor.current = { section: cursor.section, name: start_.name, meta: start_.meta, text: start_.rest };
        cursor.inEntries = true;
      } else if ( !cursor.inEntries ) {
        block.statLines.push(text);
      } else if ( cursor.current ) {
        cursor.current.text += ` ${text}`;
      } else if ( cursor.section === "legendary" ) {
        cursor.current = { section: "features", name: "Legendary Actions", meta: "", text };
      } else {
        return "break";
      }
    }
    cursor.pageContinuation = false;
  }
  return "end";
}

/** Push the entry being read into its section (the block is complete). Returns the block. */
export function closeStatBlock(block) {
  const cursor = block.cursor;
  if ( cursor?.current ) {
    const { section, name, meta, text } = cursor.current;
    block[section].push({ name, meta, text: normalizeSpace(text) });
    cursor.current = null;
  }
  return block;
}

/** Number of traits and actions of a block (the entry being read included). */
export function entryCount(block) {
  const closed = ["features", "actions", "bonus", "reactions", "legendary"].reduce((n, s) => n + (block[s]?.length ?? 0), 0);
  return closed + (block.cursor?.current ? 1 : 0);
}

/** Lines of a block region: from a start to the next title-sized line, over the columns. */
function regionOf(columns, start, titleMin) {
  const region = [];
  outer: for ( let c = start.c; c < columns.length; c++ ) {
    const lines = c === start.c ? columns[c].slice(start.i + 1) : columns[c];
    for ( const line of lines ) {
      if ( line.size >= titleMin ) break outer;
      region.push(line);
    }
  }
  return region;
}

/**
 * Read the stat block `title` of a page from its layout.
 * @param {object|object[][]} page  Page model, or its columns (`pageColumns`).
 * @param {string|object} title  Title text, or a block found by `findStatBlocks` (its `titleLine` is used).
 * @param {object} [opts]
 * @returns {object}  `{ title, page, statLines, sizeLine, bodySize, entryStyle, features, actions, bonus, reactions,
 *   legendary, ended, cursor }` with the exact text of each trait and action, or `{ error, title, page }` (`error`
 *   is one of noTitle, missingStats, fontUnknown). `ended` is "end" when the block reached the end of the page:
 *   it may go on on the next page (`continueStatBlock`); call `closeStatBlock` once it is complete, the entry
 *   being read at the end of the page is in `cursor.current`, not yet in its section.
 */
export function readStatBlock(page, title, opts = {}) {
  const columns = Array.isArray(page) ? page : pageColumns(page);
  const pageNumber = opts.page ?? (Array.isArray(page) ? 0 : page.number);
  const found = (title && typeof title === "object") ? title : null;
  const titleText = found ? found.title : normalizeSpace(title);
  const fail = error => ({ error, title: titleText, page: pageNumber });

  // The AC line gives the body font and size
  const acLines = columns.flat().filter(l => isAcLine(l.text));
  const acLine = found?.acLine ?? acLines[0];
  if ( !acLine ) return fail("missingStats");
  const bodySize = acLine.size;
  const titleMin = TITLE_RATIO * bodySize;
  const bodyFamily = fontFamily(acLine.words[0].font);
  const regularFont = acLine.words.at(-1).font;

  // Start: the title line
  let start = null;
  for ( let c = 0; c < columns.length && !start; c++ ) {
    const i = columns[c].findIndex(l => (found?.titleLine ? l === found.titleLine : (l.size >= titleMin) && (l.text === titleText)));
    if ( i >= 0 ) start = { c, i };
  }
  if ( !start && !found?.titleLine ) {
    for ( let c = 0; c < columns.length && !start; c++ ) {
      const i = columns[c].findIndex(l => (l.text === titleText) && isTitleLine(l, bodySize));
      if ( i >= 0 ) start = { c, i };
    }
  }
  if ( !start ) return fail("noTitle");

  const { isEntryWord, style } = entryPredicate(regionOf(columns, start, titleMin), bodyFamily, [regularFont]);
  if ( !style ) return fail("fontUnknown");

  const block = { title: titleText, page: pageNumber, statLines: [], sizeLine: null, bodySize, entryStyle: style,
    features: [], actions: [], bonus: [], reactions: [], legendary: [], ended: null, cursor: null };
  block.cursor = { block, bodyFamily, bodySize, regularFont, isEntryWord, section: "features", inEntries: false, current: null, pageContinuation: false };
  block.ended = readBlockLines(columns, { c: start.c, i: start.i + 1 }, block.cursor);
  if ( !block.statLines.length ) return fail("missingStats");
  return block;
}

/**
 * Continue a block that reached the end of its page (`ended === "end"`) with the columns of the next page: the
 * lines before the next title-sized line go on with the same section, with the entry cut by the page break, or
 * with the stat lines when the block had no entry yet. Lore in another font at the top of the page is skipped.
 * @param {object[][]} columns  Columns of the next page.
 * @param {object} block  Block read by `readStatBlock` (modified in place: entries, `ended`, `continued`, `pages`).
 * @param {{page?: number}} [opts]
 * @returns {object}  The same block; `continued` tells whether the page added anything to it.
 */
export function continueStatBlock(columns, block, { page } = {}) {
  const cursor = block.cursor;
  if ( !cursor ) return block;
  const titleMin = TITLE_RATIO * cursor.bodySize;
  const { isEntryWord, style } = entryPredicate(regionOf(columns, { c: 0, i: -1 }, titleMin), cursor.bodyFamily, [cursor.regularFont]);
  if ( style ) cursor.isEntryWord = isEntryWord;
  const measure = () => entryCount(block) + block.statLines.length + (cursor.current?.text.length ?? 0);
  const before = measure();
  cursor.pageContinuation = true;
  block.ended = readBlockLines(columns, { c: 0, i: 0 }, cursor);
  cursor.pageContinuation = false;
  block.continued = measure() > before;
  if ( block.continued && page ) (block.pages ??= [block.page]).push(page);
  return block;
}

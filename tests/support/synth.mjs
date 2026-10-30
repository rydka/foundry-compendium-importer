// Synthetic PDF books for the tests of the PDF import (pdf-lib, standard fonts only).
//
//   spec (JSON, versioned)  ->  printed lines (renderCreature / renderItem)  ->  layout (two columns)  ->  PDF bytes
//   spec (JSON, versioned)  ->  expected values (expectedCreature / expectedItem), never read back from the PDF
//
// The books are original texts written for the tests. The PDFs are never versioned (`*.pdf` is ignored): they
// are generated on demand in memory or in the temporary folder.
//
// Fonts, as in a real 5e supplement: title = Times-Bold 17.6, section heading = Times-Roman 12.7, type line =
// Helvetica-Oblique 8.6, stat labels = Helvetica-Bold 9, entry names = Helvetica-BoldOblique 9, body = Helvetica 9.
// `fonts: "single"` writes everything in Helvetica 9 (no layout cue: the rules cannot read it, used for C4 / C5).
//
// Document options: { cols: 1|2, draw: "lines"|"words"|"chars", footer: "none"|"number"|"head", fonts: "std"|"single" }
// Flow items: { wide }, { lore }, { loreHead }, { gap: n }, { col: 1 }, { page: 1 }, { creature }, { item }, { image: 1 }.
import { readFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import { fingerprintOf } from "./fingerprint.mjs";

// ---------------------------------------------------------------------------------------------- vocabularies

const ABILITIES = ["str", "dex", "con", "int", "wis", "cha"];

const SKILL_ABILITY = {
  acr: "dex", ani: "wis", arc: "int", ath: "str", dec: "cha", his: "int", ins: "wis", itm: "cha", inv: "int", med: "wis",
  nat: "int", prc: "wis", prf: "cha", per: "cha", rel: "int", slt: "dex", ste: "dex", sur: "wis"
};

const SKILL_NAMES = {
  en: { acr: "Acrobatics", ani: "Animal Handling", arc: "Arcana", ath: "Athletics", dec: "Deception", his: "History", ins: "Insight", itm: "Intimidation", inv: "Investigation", med: "Medicine", nat: "Nature", prc: "Perception", prf: "Performance", per: "Persuasion", rel: "Religion", slt: "Sleight of Hand", ste: "Stealth", sur: "Survival" },
  fr: { acr: "Acrobaties", ani: "Dressage", arc: "Arcanes", ath: "Athlétisme", dec: "Tromperie", his: "Histoire", ins: "Perspicacité", itm: "Intimidation", inv: "Investigation", med: "Médecine", nat: "Nature", prc: "Perception", prf: "Représentation", per: "Persuasion", rel: "Religion", slt: "Escamotage", ste: "Discrétion", sur: "Survie" }
};

const L = {
  en14: {
    ac: "Armor Class", hp: "Hit Points", speed: "Speed", saves: "Saving Throws", skills: "Skills", dv: "Damage Vulnerabilities",
    dr: "Damage Resistances", di: "Damage Immunities", ci: "Condition Immunities", senses: "Senses", languages: "Languages",
    cr: "Challenge", prof: "Proficiency Bonus", abil: ["STR", "DEX", "CON", "INT", "WIS", "CHA"], abilWord: ["Str", "Dex", "Con", "Int", "Wis", "Cha"],
    heads: { action: "Actions", bonus: "Bonus Actions", reaction: "Reactions", legendary: "Legendary Actions" },
    move: { walk: "", fly: "fly ", swim: "swim ", climb: "climb ", burrow: "burrow " }, hover: " (hover)", unit: "ft.",
    sense: { darkvision: "darkvision", blindsight: "blindsight", truesight: "truesight", tremorsense: "tremorsense" }, passive: "passive Perception", xp: "XP"
  },
  fr14: {
    ac: "Classe d’armure", hp: "Points de vie", speed: "Vitesse", saves: "Jets de sauvegarde", skills: "Compétences", dv: "Vulnérabilités aux dégâts",
    dr: "Résistances aux dégâts", di: "Immunités contre les dégâts", ci: "Immunités contre les états", senses: "Sens", languages: "Langues",
    cr: "Facteur de puissance", prof: "Bonus de maîtrise", abil: ["FOR", "DEX", "CON", "INT", "SAG", "CHA"], abilWord: ["For", "Dex", "Con", "Int", "Sag", "Cha"],
    heads: { action: "Actions", bonus: "Actions bonus", reaction: "Réactions", legendary: "Actions légendaires" },
    move: { walk: "", fly: "vol ", swim: "nage ", climb: "escalade ", burrow: "fouissement " }, hover: " (vol stationnaire)", unit: "m",
    sense: { darkvision: "vision dans le noir", blindsight: "vision aveugle", truesight: "vision lucide", tremorsense: "perception des vibrations" }, passive: "Perception passive", xp: "PX"
  },
  en24: {
    ac: "AC", hp: "HP", speed: "Speed", skills: "Skills", dv: "Vulnerabilities", dr: "Resistances", imm: "Immunities", senses: "Senses",
    languages: "Languages", cr: "CR", abil: ["Str", "Dex", "Con", "Int", "Wis", "Cha"],
    heads: { trait: "Traits", action: "Actions", bonus: "Bonus Actions", reaction: "Reactions", legendary: "Legendary Actions" },
    move: { walk: "", fly: "Fly ", swim: "Swim ", climb: "Climb ", burrow: "Burrow " }, hover: " (hover)", unit: "ft.",
    sense: { darkvision: "Darkvision", blindsight: "Blindsight", truesight: "Truesight", tremorsense: "Tremorsense" }, passive: "Passive Perception", xp: "XP", init: "Initiative", pb: "PB"
  },
  fr24: {
    ac: "CA", hp: "PV", speed: "Vitesse", skills: "Compétences", dv: "Vulnérabilités", dr: "Résistances", imm: "Immunités", senses: "Sens",
    languages: "Langues", cr: "FP", abil: ["For", "Dex", "Con", "Int", "Sag", "Cha"],
    heads: { trait: "Traits", action: "Actions", bonus: "Actions bonus", reaction: "Réactions", legendary: "Actions légendaires" },
    move: { walk: "", fly: "vol ", swim: "nage ", climb: "escalade ", burrow: "fouissement " }, hover: " (vol stationnaire)", unit: "m",
    sense: { darkvision: "Vision dans le noir", blindsight: "Vision aveugle", truesight: "Vision lucide", tremorsense: "Perception des vibrations" }, passive: "Perception passive", xp: "PX", init: "Initiative", pb: "BM"
  }
};

const mod = (score) => Math.floor((score - 10) / 2);
const signed = (n) => (n >= 0 ? `+${n}` : `-${Math.abs(n)}`);
const thousands = (n, lang) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, lang === "fr" ? " " : ",");
const crText = (cr) => ({ 0.125: "1/8", 0.25: "1/4", 0.5: "1/2" }[cr] ?? String(cr));

function distance(feet, lang) {
  if (lang !== "fr") return `${feet} ft.`;
  const m = feet / 10 * 3;
  return `${String(m).replace(".", ",")} m`;
}

// ---------------------------------------------------------------------------------------------- creatures

/**
 * Printed lines of a stat block, as ops understood by the layout.
 * @returns {object[]}
 */
export function renderCreature(c, { edition, lang }) {
  const key = `${lang}${edition === "2024" ? "24" : "14"}`;
  const t = L[key];
  const ops = [];
  const abil = c.abilities;
  const prof = c.prof;
  ops.push({ k: "title", text: c.name });
  ops.push({ k: "type", text: c.typeLine });

  const speedText = Object.entries(c.speed)
    .filter(([m]) => m !== "hover")
    .map(([m, v]) => `${t.move[m]}${distance(v, lang)}`)
    .join(", ") + (c.speed.hover ? t.hover : "");
  const sensesText = [
    ...Object.entries(c.senses).map(([s, v]) => `${t.sense[s]} ${distance(v, lang)}`),
    `${t.passive} ${c.passive}`
  ].join(edition === "2024" ? (lang === "fr" ? " ; " : "; ") : ", ");
  const crValue = edition === "2024"
    ? (lang === "fr" ? `${crText(c.cr)} (${t.xp} ${thousands(c.xp, lang)} ; ${t.pb} +${prof})` : `${crText(c.cr)} (${t.xp} ${thousands(c.xp, lang)}; ${t.pb} +${prof})`)
    : `${crText(c.cr)} (${thousands(c.xp, lang)} ${t.xp})   `;
  const skillsText = Object.entries(c.skills ?? {})
    .map(([k, level]) => `${SKILL_NAMES[lang][k]} ${signed(mod(abil[ABILITIES.indexOf(SKILL_ABILITY[k])]) + prof * level)}`)
    .join(", ");

  if (edition === "2024") {
    const init = mod(abil[1]);
    ops.push({ k: "label", label: t.ac, value: `${c.ac.value}   ${t.init} ${signed(init)} (${10 + init})` });
    ops.push({ k: "label", label: t.hp, value: `${c.hp.value} (${c.hp.formula})` });
    ops.push({ k: "label", label: t.speed, value: speedText });
    for (const row of [[0, 1, 2], [3, 4, 5]]) {
      const cells = [];
      for (const i of row) {
        const m = mod(abil[i]);
        const save = (c.saves ?? []).includes(ABILITIES[i]) ? m + prof : m;
        cells.push({ t: t.abil[i], bold: true }, { t: String(abil[i]) }, { t: signed(m) }, { t: signed(save) });
      }
      ops.push({ k: "row", cells });
    }
    if (skillsText) ops.push({ k: "label", label: t.skills, value: skillsText });
    if (c.printed.dv) ops.push({ k: "label", label: t.dv, value: c.printed.dv });
    if (c.printed.dr) ops.push({ k: "label", label: t.dr, value: c.printed.dr });
    if (c.printed.imm) ops.push({ k: "label", label: t.imm, value: c.printed.imm });
    ops.push({ k: "label", label: t.senses, value: sensesText });
    ops.push({ k: "label", label: t.languages, value: c.printed.languages });
    ops.push({ k: "label", label: t.cr, value: crValue });
  } else {
    const acDetail = c.ac.detail ? ` (${c.ac.detail})` : "";
    ops.push({ k: "label", label: t.ac, value: `${c.ac.value}${acDetail}` });
    ops.push({ k: "label", label: t.hp, value: `${c.hp.value} (${c.hp.formula})` });
    ops.push({ k: "label", label: t.speed, value: speedText });
    ops.push({ k: "row", cells: t.abil.map((a) => ({ t: a, bold: true })) });
    ops.push({ k: "row", cells: abil.map((a) => ({ t: `${a} (${signed(mod(a))})` })) });
    const saves = (c.saves ?? []).map((a) => `${t.abilWord[ABILITIES.indexOf(a)]} ${signed(mod(abil[ABILITIES.indexOf(a)]) + prof)}`).join(", ");
    if (saves) ops.push({ k: "label", label: t.saves, value: saves });
    if (skillsText) ops.push({ k: "label", label: t.skills, value: skillsText });
    for (const f of ["dv", "dr", "di", "ci"]) if (c.printed[f]) ops.push({ k: "label", label: t[f], value: c.printed[f] });
    ops.push({ k: "label", label: t.senses, value: sensesText });
    ops.push({ k: "label", label: t.languages, value: c.printed.languages });
    ops.push({ k: "label", label: t.cr, value: `${crValue}${t.prof} +${prof}` });
  }

  let section = edition === "2024" ? null : "trait";
  for (const [s, name, meta, text] of c.entries) {
    if (s !== section) {
      if (s !== "trait" || edition === "2024") {
        ops.push({ k: "head", text: t.heads[s] });
        if (s === "legendary" && c.legendaryIntro) ops.push({ k: "para", text: c.legendaryIntro });
      }
      section = s;
    }
    ops.push({ k: "entry", name: `${name}${meta ? ` (${meta})` : ""}.`, text });
  }
  return ops;
}

/** The text printed for an entry (name, meta and body), whose fingerprint the tests compare. */
export const printedEntry = ([, name, meta, text]) => `${name}${meta ? ` (${meta})` : ""}. ${text}`;

/**
 * Expected values for a creature spec (all taken from the spec, never from the PDF).
 * @returns {object} same shape as a creature of better-undead.truth.json, plus size / traits for the C2 checks.
 */
export function expectedCreature(c, { edition, lang }) {
  const counts = { trait: 0, action: 0, bonus: 0, reaction: 0, legendary: 0 };
  for (const e of c.entries) counts[e[0]]++;
  const abilities = Object.fromEntries(ABILITIES.map((a, i) => [a, c.abilities[i]]));
  const saves = Object.fromEntries((c.saves ?? []).map((a) => [a, mod(abilities[a]) + c.prof]));
  const skills = Object.fromEntries(Object.entries(c.skills ?? {}).map(([k, level]) => [k, { level, bonus: mod(abilities[SKILL_ABILITY[k]]) + c.prof * level }]));
  const speed = { ...c.speed };
  const senses = { ...c.senses };
  return {
    name: c.name, size: c.size, type: c.type, subtype: c.subtype ?? "", alignment: c.alignment,
    ac: { value: c.ac.value, natural: edition === "2024" ? undefined : !!c.ac.natural },
    hp: { value: c.hp.value, formula: c.hp.formula },
    speed, abilities, saves, skills, senses, passivePerception: c.passive,
    cr: c.cr, xp: c.xp, prof: c.prof, traits: c.traits ?? {},
    entries: c.entries.map((e) => ({ name: e[1], section: e[0], meta: e[2], ...fingerprintOf(printedEntry(e)) })),
    counts, edition, lang
  };
}

// ---------------------------------------------------------------------------------------------- magic items

export function renderItem(it) {
  const ops = [{ k: "itemTitle", lines: it.titleLines }, { k: "itemType", text: it.typeLine }];
  for (const p of it.paras ?? []) ops.push({ k: "itemPara", text: p });
  for (const s of it.subs ?? []) {
    ops.push({ k: "sub", text: s.head });
    for (const p of s.paras) ops.push({ k: "itemPara", text: p });
  }
  return ops;
}

export function expectedItem(it) {
  return {
    name: it.titleLines.join(" "), docType: it.expect.docType, typeValue: it.expect.typeValue ?? null,
    rarity: it.expect.rarity, attunement: it.expect.attunement,
    intro: it.paras?.[0] ? fingerprintOf(it.paras[0]) : null
  };
}

// ---------------------------------------------------------------------------------------------- layout

const PAGE = { w: 595, h: 842 };
const COLS = [{ x: 40, w: 245 }, { x: 310, w: 245 }];
const TOP = 800;
const BOTTOM = 62;

function pngBytes() {
  const size = 48;
  const raw = Buffer.alloc((size + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) raw[y * (size + 1) + 1 + x] = (x * 5 + y * 3) % 200 + 20;
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/**
 * Builds the PDF of a document.
 * @param {object} doc  { cols, draw, footer, fonts, edition, lang, flow }
 * @returns {Promise<Uint8Array>}
 */
export async function buildPdf(doc) {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  pdf.setTitle(doc.id ?? "synthetic"); pdf.setProducer("cji-tests");
  const F = {
    reg: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    obl: await pdf.embedFont(StandardFonts.HelveticaOblique),
    boldObl: await pdf.embedFont(StandardFonts.HelveticaBoldOblique),
    times: await pdf.embedFont(StandardFonts.TimesRoman),
    timesBold: await pdf.embedFont(StandardFonts.TimesRomanBold)
  };
  let single = doc.fonts === "single";
  const draw = doc.draw ?? "lines";
  const cols = doc.cols ?? 2;
  const style = (name) => {
    // [font, size, line height, space before, space after]
    if (single) return [F.reg, 9, 11, 0, 0];
    return {
      title: [F.timesBold, 17.6, 19, 3, 2], type: [F.obl, 8.6, 10.5, 0, 1], label: [F.reg, 9, 11, 0, 0], row: [F.reg, 9, 11, 0, 0],
      head: [F.times, 12.7, 14, 5, 1], entry: [F.reg, 9, 11, 0, 0], para: [F.reg, 9, 11, 0, 0],
      lore: [F.reg, 9.6, 11.5, 0, 5], loreSerif: [F.times, 10.5, 12.5, 0, 5], loreHead: [F.timesBold, 16.3, 18, 8, 2], wide: [F.timesBold, 25, 28, 0, 6],
      itemTitle1: [F.timesBold, 13, 15, 0, 0], itemTitle2: [F.timesBold, 21.3, 24, 0, 2], itemType: [F.obl, 9.6, 11.7, 0, 3],
      itemPara: [F.reg, 9.6, 11.7, 0, 6], sub: [F.times, 13, 15, 5, 1]
    }[name];
  };

  let page = null;
  let pageNo = 0;
  let col = 0;
  let y = TOP;
  let colTop = TOP;

  const finishPage = () => {
    if (!page) return;
    if (doc.footer === "number") {
      const s = String(pageNo);
      page.drawText(s, { x: PAGE.w / 2 - F.reg.widthOfTextAtSize(s, 12) / 2, y: 30, size: 12, font: F.reg });
    } else if (doc.footer === "head") {
      const s = `${(doc.runningHead ?? "THE EMBER ARCHIVE").split("").join(" ")}   ${pageNo}`;
      page.drawText(s, { x: 40, y: 30, size: 8.2, font: F.reg });
    }
  };
  const newPage = () => {
    finishPage();
    page = pdf.addPage([PAGE.w, PAGE.h]);
    pageNo++; col = 0; y = TOP; colTop = TOP;
  };
  const nextColumn = () => {
    if (cols === 2 && col === 0) { col = 1; y = colTop; } else newPage();
  };
  const ensure = (lh) => { if (!page) newPage(); if (y - lh < BOTTOM) nextColumn(); };

  const drawRun = (text, font, size, x, yy) => {
    if (!text) return;
    if (draw === "lines") { page.drawText(text, { x, y: yy, size, font, color: rgb(0, 0, 0) }); return; }
    if (draw === "words") {
      let cx = x;
      for (const w of text.split(/( )/)) {
        if (w === "") continue;
        if (w !== " ") page.drawText(w, { x: cx, y: yy, size, font });
        cx += font.widthOfTextAtSize(w, size);
      }
      return;
    }
    let cx = x;
    for (const ch of [...text]) {
      if (ch !== " ") page.drawText(ch, { x: cx, y: yy, size, font });
      cx += font.widthOfTextAtSize(ch, size);
    }
  };

  /** Wraps segments [{ text, font }] at width; returns lines of runs. */
  const wrap = (segments, size, width) => {
    const lines = [[]];
    let x = 0;
    for (const seg of segments) {
      for (const word of seg.text.split(" ").filter(Boolean)) {
        const w = seg.font.widthOfTextAtSize(word, size);
        const sp = x === 0 ? 0 : seg.font.widthOfTextAtSize(" ", size);
        if (x > 0 && x + sp + w > width) { lines.push([]); x = 0; }
        const line = lines[lines.length - 1];
        const lead = line.length ? " " : "";
        const last = line[line.length - 1];
        if (last && last.font === seg.font) last.text += lead + word;
        else line.push({ text: (last ? " " : "") + word, font: seg.font });
        x += (x === 0 ? 0 : sp) + w;
      }
    }
    return lines;
  };

  // Test hooks of a creature flow item: breakBefore (page break before the printed line / entry / heading starting with this text),
  // afterBreak ({ text, style } paragraph written at the top of the new page), breakBeforeLineContaining (page break before the first
  // wrapped line that contains this text, i.e. in the middle of an entry).
  let lineBreakText = null;
  const place = (segments, styleName, { indent = 0 } = {}) => {
    const [, size, lh, before, after] = style(styleName);
    const font0 = style(styleName)[0];
    const segs = segments.map((s) => ({ text: s.text, font: single ? F.reg : (s.font ?? font0) }));
    // widest line is limited by the column
    const colw = (cols === 2 ? COLS[0].w : 515) - indent;
    const lines = wrap(segs, size, colw);
    y -= before;
    for (const runs of lines) {
      if (lineBreakText && runs.map((r) => r.text).join("").includes(lineBreakText)) { lineBreakText = null; newPage(); }
      ensure(lh);
      const c = cols === 2 ? COLS[col] : { x: 40, w: 515 };
      y -= lh;
      let x = c.x + indent;
      for (const r of runs) {
        drawRun(r.text, r.font, size, x, y);
        x += r.font.widthOfTextAtSize(r.text, size);
      }
    }
    y -= after;
  };

  for (const item of doc.flow) {
    single = doc.fonts === "single" || item.fonts === "single";
    if (item.page) { newPage(); continue; }
    if (item.col) { nextColumn(); continue; }
    if (item.gap) { if (!page) newPage(); y -= item.gap; if (y < BOTTOM + 14) nextColumn(); continue; }
    if (item.wide) {
      newPage();
      const [font, size, lh] = style("wide");
      y -= lh;
      drawRun(item.wide, font, size, 40, y);
      y -= 10; colTop = y;
      continue;
    }
    if (item.image) {
      newPage();
      const img = await pdf.embedPng(pngBytes());
      page.drawImage(img, { x: 20, y: 120, width: 555, height: 600 });
      continue;
    }
    if (item.lore) { place([{ text: item.lore }], "lore"); continue; }
    if (item.loreHead) { place([{ text: item.loreHead }], "loreHead"); continue; }
    const ops = item.creature ? renderCreature(item.creature, doc) : item.item ? renderItem(item.item) : [];
    let broken = false;
    lineBreakText = item.creature?.breakBeforeLineContaining ?? item.breakBeforeLineContaining ?? null;
    const breakBefore = item.breakBefore ?? item.creature?.breakBefore ?? null;
    const opStart = (o) => o.label ?? o.name ?? o.text ?? o.cells?.[0]?.t ?? "";
    for (const op of ops) {
      if (breakBefore && !broken && String(opStart(op)).startsWith(breakBefore)) {
        broken = true;
        newPage();
        const ab = item.afterBreak ?? item.creature?.afterBreak;
        if (ab) place([{ text: ab.text }], ab.style === "serif" ? "loreSerif" : "para");
      }
      switch (op.k) {
        case "title": place([{ text: op.text }], "title"); break;
        case "type": place([{ text: op.text }], "type"); break;
        case "head": place([{ text: op.text }], "head"); break;
        case "label": place([{ text: op.label, font: F.bold }, { text: op.value, font: F.reg }], "label"); break;
        case "para": place([{ text: op.text }], "para"); break;
        case "entry": place([{ text: op.name, font: F.boldObl }, { text: op.text, font: F.reg }], "entry"); break;
        case "row": {
          const [font, size, lh] = style("row");
          ensure(lh);
          const c = cols === 2 ? COLS[col] : { x: 40, w: 515 };
          y -= lh;
          const step = c.w / op.cells.length;
          op.cells.forEach((cell, i) => drawRun(cell.t, single ? F.reg : (cell.bold ? F.bold : font), size, c.x + i * step, y));
          break;
        }
        case "itemTitle": {
          const [a, b] = [style("itemTitle1"), style("itemTitle2")];
          op.lines.forEach((text, i) => {
            const st = i < op.lines.length - 1 ? a : b;
            ensure(st[2]);
            const c = cols === 2 ? COLS[col] : { x: 40, w: 515 };
            y -= st[2];
            drawRun(text, st[0], st[1], c.x, y);
            y -= st[4];
          });
          break;
        }
        case "itemType": place([{ text: op.text }], "itemType"); break;
        case "itemPara": place([{ text: op.text }], "itemPara"); break;
        case "sub": place([{ text: op.text }], "sub"); break;
        default: throw new Error(`unknown op ${op.k}`);
      }
    }
    // a little air after a block
    y -= 8;
  }
  finishPage();
  // `maxPages` cuts the document: what overflowed to the next pages is lost (a stat block cut short)
  if (doc.maxPages) while (pdf.getPageCount() > doc.maxPages) pdf.removePage(pdf.getPageCount() - 1);
  return pdf.save();
}

// ---------------------------------------------------------------------------------------------- documents

export const loadDoc = (file) => JSON.parse(readFileSync(file, "utf8"));

/** Expected creatures and items of a document, in reading order. */
export function expectedOfDoc(doc) {
  const creatures = [];
  const items = [];
  for (const f of doc.flow) {
    if (f.creature) creatures.push(expectedCreature(f.creature, doc));
    if (f.item) items.push(expectedItem(f.item));
  }
  return { creatures, items };
}

export { ABILITIES, SKILL_ABILITY };

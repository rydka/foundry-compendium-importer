(async () => {
  /**
   * PDF → Compendiums (Actors + Items) — Foundry V13 / dnd5e 5.2.x
   * Patch: erreurs copiable + suppression compendium robuste + lookup global items.
   */

  const IMPORT_NS = "pdf-importer-v2";
  const DEFAULT_ACTOR_PACK_LABEL = "PDF Import - Actors";
  const DEFAULT_ITEM_PACK_LABEL  = "PDF Import - Items";

  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  function slugify(s) {
    return String(s ?? "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 60);
  }
  function normName(s) { return String(s ?? "").trim().replace(/\s+/g, " "); }
  function lcName(s) { return normName(s).toLowerCase(); }

  function pickLocalPDF() {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "application/pdf";
      input.onchange = () => resolve(input.files?.[0] ?? null);
      input.click();
    });
  }

  function absUrl(pathOrUrl) {
    try { return new URL(pathOrUrl, window.location.origin).toString(); }
    catch { return pathOrUrl; }
  }

  async function fetchText(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.text();
  }

  async function urlExists(url) {
    try {
      let res = await fetch(url, { method: "HEAD", cache: "no-store" });
      if (res.ok) return true;
      res = await fetch(url, { method: "GET", cache: "no-store" });
      return res.ok;
    } catch {
      return false;
    }
  }

  async function loadScriptClassic(url) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = url;
      s.async = true;
      s.onload = () => resolve(true);
      s.onerror = () => reject(new Error(`Script load failed: ${url}`));
      document.head.appendChild(s);
    });
  }

  /**
   * ✅ FIX: suppression compendium robuste (V13 / variations)
   */
  async function packDeleteDocuments(pack, ids) {
    if (!ids?.length) return;
    if (typeof pack.deleteDocuments === "function") {
      return pack.deleteDocuments(ids);
    }
    // fallback officiel via DocumentClass
    return pack.documentClass.deleteDocuments(ids, { pack: pack.collection });
  }

  async function probePdfjsFromViewer(log = () => {}) {
    const viewerCandidates = [
      "/pdfjs/web/viewer.html",
      "/scripts/pdfjs/web/viewer.html",
      "/scripts/pdfjs-dist/web/viewer.html",
      "/scripts/pdfjs/web/viewer.html?file=",
      "/scripts/pdfjs-dist/web/viewer.html?file="
    ].map(absUrl);

    for (const viewerUrl of viewerCandidates) {
      if (!(await urlExists(viewerUrl))) continue;

      log(`✓ viewer trouvé: ${viewerUrl}`);
      let html;
      try { html = await fetchText(viewerUrl); }
      catch (e) { log(`✗ lecture viewer.html impossible: ${viewerUrl} (${e.message ?? e})`); continue; }

      const mViewer = html.match(/<script[^>]+src=["']([^"']*viewer\.(?:mjs|js))["']/i);
      const viewerScriptRel = mViewer?.[1];
      if (!viewerScriptRel) {
        log(`✗ viewer.html ne référence pas viewer.(m)js: ${viewerUrl}`);
        const guessedRoot = new URL("../", viewerUrl).toString();
        return { rootUrl: guessedRoot };
      }

      const viewerScriptUrl = new URL(viewerScriptRel, viewerUrl).toString();
      log(`✓ viewer script: ${viewerScriptUrl}`);

      let viewerJs;
      try { viewerJs = await fetchText(viewerScriptUrl); }
      catch (e) {
        log(`✗ lecture viewer script impossible: ${viewerScriptUrl} (${e.message ?? e})`);
        const guessedRoot = new URL("../", viewerScriptUrl).toString();
        return { rootUrl: guessedRoot };
      }

      const importRe = /from\s+["']([^"']*pdf(?:\.min)?\.(?:mjs|js))["']/i;
      const mPdf = viewerJs.match(importRe);

      if (mPdf?.[1]) {
        const pdfRel = mPdf[1];
        const pdfUrl = new URL(pdfRel, viewerScriptUrl).toString();
        log(`✓ pdf lib détectée via import: ${pdfUrl}`);

        let workerUrl = pdfUrl.replace(/pdf(?:\.min)?\.(mjs|js)$/i, "pdf.worker.$1");
        if (!(await urlExists(workerUrl))) {
          const workerMin = pdfUrl.replace(/pdf(?:\.min)?\.(mjs|js)$/i, "pdf.worker.min.$1");
          if (await urlExists(workerMin)) workerUrl = workerMin;
          else workerUrl = null;
        }
        if (workerUrl) log(`✓ worker détecté: ${workerUrl}`);
        return { pdfUrl, workerUrl };
      }

      const buildGuess = new URL("../build/pdf.mjs", viewerScriptUrl).toString();
      if (await urlExists(buildGuess)) {
        log(`✓ pdf lib devinée via structure standard: ${buildGuess}`);
        const workerGuess = new URL("../build/pdf.worker.mjs", viewerScriptUrl).toString();
        const workerUrl = (await urlExists(workerGuess)) ? workerGuess : null;
        if (workerUrl) log(`✓ worker deviné: ${workerUrl}`);
        return { pdfUrl: buildGuess, workerUrl };
      }

      const buildGuessJs = new URL("../build/pdf.min.js", viewerScriptUrl).toString();
      if (await urlExists(buildGuessJs)) {
        log(`✓ pdf lib devinée (UMD) via structure standard: ${buildGuessJs}`);
        const workerGuessJs = new URL("../build/pdf.worker.min.js", viewerScriptUrl).toString();
        const workerUrl = (await urlExists(workerGuessJs)) ? workerGuessJs : null;
        if (workerUrl) log(`✓ worker deviné: ${workerUrl}`);
        return { pdfUrl: buildGuessJs, workerUrl };
      }

      log(`✗ viewer trouvé mais impossible d'en déduire pdf.js depuis: ${viewerUrl}`);
    }

    return null;
  }

  async function loadPdfjsLib(progressLog = () => {}) {
    if (globalThis.pdfjsLib?.getDocument) return { lib: globalThis.pdfjsLib, workerUrl: null };

    const attempts = [];
    const log = (s) => { attempts.push(s); progressLog(s); };

    log("Recherche du viewer PDF Foundry pour localiser pdf.js…");
    const probed = await probePdfjsFromViewer(log);
    if (probed?.pdfUrl) {
      if (/\.js(\?|$)/i.test(probed.pdfUrl) && !/\.mjs(\?|$)/i.test(probed.pdfUrl)) {
        log(`Chargement pdf.js via <script>: ${probed.pdfUrl}`);
        await loadScriptClassic(probed.pdfUrl);
        if (globalThis.pdfjsLib?.getDocument) return { lib: globalThis.pdfjsLib, workerUrl: probed.workerUrl ?? null };
        throw new Error(`pdf.js chargé mais pdfjsLib introuvable après script.\n- ${attempts.join("\n- ")}`);
      }

      const u = probed.pdfUrl;
      log(`Import ESM pdf.js: ${u}`);
      try {
        const mod = await import(/* @vite-ignore */ u);
        const lib = mod?.pdfjsLib ?? mod?.default ?? mod;
        if (lib?.getDocument) {
          globalThis.pdfjsLib = lib;
          return { lib, workerUrl: probed.workerUrl ?? null };
        }
      } catch (e) {
        log(`✗ import() a échoué: ${u} (${e.message ?? e})`);
      }
    }

    log("Fallback: essais de chemins courants pour pdf.js…");
    const candidates = [
      "/scripts/pdfjs/build/pdf.mjs",
      "/scripts/pdfjs/build/pdf.min.mjs",
      "/scripts/pdfjs/pdf.mjs",
      "/scripts/pdfjs-dist/build/pdf.mjs",
      "/scripts/pdfjs-dist/build/pdf.min.mjs",
      "/scripts/pdfjs/build/pdf.min.js",
      "/scripts/pdfjs/build/pdf.js",
      "/scripts/pdfjs-dist/legacy/build/pdf.min.js",
      "/scripts/pdfjs-dist/legacy/build/pdf.js",
      "/scripts/pdfjs-dist/build/pdf.min.js",
      "/scripts/pdfjs-dist/build/pdf.js"
    ].map(absUrl);

    for (const url of candidates) {
      if (!(await urlExists(url))) { log(`- 404: ${url}`); continue; }
      try {
        if (/\.mjs(\?|$)/i.test(url)) {
          log(`Import ESM: ${url}`);
          const mod = await import(/* @vite-ignore */ url);
          const lib = mod?.pdfjsLib ?? mod?.default ?? mod;
          if (lib?.getDocument) {
            globalThis.pdfjsLib = lib;
            return { lib, workerUrl: null };
          }
          log(`✗ module importé mais pas de getDocument: ${url}`);
        } else {
          log(`Chargement <script>: ${url}`);
          await loadScriptClassic(url);
          if (globalThis.pdfjsLib?.getDocument) return { lib: globalThis.pdfjsLib, workerUrl: null };
          log(`✗ script chargé mais pdfjsLib absent: ${url}`);
        }
      } catch (e) {
        log(`✗ échec: ${url} (${e.message ?? e})`);
      }
    }

    const worldId = game.world.id;
    const worldCandidates = [
      `/worlds/${worldId}/scripts/vendor/pdfjs/pdf.mjs`,
      `/worlds/${worldId}/scripts/vendor/pdfjs/pdf.min.js`
    ].map(absUrl);

    log("Fallback final: recherche pdf.js dans le dossier world (/scripts/vendor/pdfjs)…");
    for (const url of worldCandidates) {
      if (!(await urlExists(url))) { log(`- absent: ${url}`); continue; }
      try {
        if (/\.mjs(\?|$)/i.test(url)) {
          log(`Import ESM world: ${url}`);
          const mod = await import(/* @vite-ignore */ url);
          const lib = mod?.pdfjsLib ?? mod?.default ?? mod;
          if (lib?.getDocument) {
            globalThis.pdfjsLib = lib;
            return { lib, workerUrl: null };
          }
        } else {
          log(`Chargement <script> world: ${url}`);
          await loadScriptClassic(url);
          if (globalThis.pdfjsLib?.getDocument) return { lib: globalThis.pdfjsLib, workerUrl: null };
        }
      } catch (e) {
        log(`✗ échec world: ${url} (${e.message ?? e})`);
      }
    }

    throw new Error(
      `Impossible de charger pdf.js depuis Foundry.\n\n` +
      `Solution fiable: upload pdfjs-dist/build/pdf.mjs (ou pdf.min.js) dans:\n` +
      `  /worlds/${worldId}/scripts/vendor/pdfjs/\n\n` +
      `Détails:\n- ${attempts.join("\n- ")}`
    );
  }

  async function getOrCreatePack({ documentName, label, name }) {
    const packId = `world.${name}`;
    let pack = game.packs.get(packId);

    if (!pack) {
      await CompendiumCollection.createCompendium({
        label,
        name,
        type: documentName,
        system: game.system.id
      });
      pack = game.packs.get(packId);
    }
    await pack.getIndex();
    return pack;
  }

  async function createProgressDialog(title, total) {
    let cancelled = false;

    const dlg = new Dialog({
      title,
      content: `
        <div style="display:flex; flex-direction:column; gap:8px;">
          <progress value="0" max="${total}" style="width:100%; height:18px;"></progress>
          <div class="status" style="font-size:12px; opacity:0.9;">Préparation…</div>
          <textarea class="log" style="width:100%; height:180px; resize:vertical;" readonly></textarea>
          <div style="font-size:11px; opacity:0.8;">(Tu peux copier/coller ce log)</div>
        </div>
      `,
      buttons: {
        cancel: { icon: '<i class="fas fa-times"></i>', label: "Annuler", callback: () => { cancelled = true; } }
      },
      default: "cancel",
      close: () => { cancelled = true; }
    });

    dlg.render(true);
    await wait(0);

    const $el = dlg.element;
    const prog = $el.find("progress")[0];
    const status = $el.find(".status")[0];
    const log = $el.find(".log")[0];

    function set(v, s) {
      if (prog) prog.value = v;
      if (status) status.textContent = s ?? "";
    }
    function append(line) {
      if (!log) return;
      log.value += (log.value ? "\n" : "") + line;
      log.scrollTop = log.scrollHeight;
    }

    return { isCancelled: () => cancelled, set, log: append, close: () => dlg.close() };
  }

  async function extractLinesFromPage(pdf, pageNumber) {
    const page = await pdf.getPage(pageNumber);
    const tc = await page.getTextContent({ disableCombineTextItems: false });

    const byY = new Map();
    for (const it of tc.items) {
      const str = String(it.str ?? "").trim();
      if (!str) continue;
      const x = it.transform?.[4] ?? 0;
      const y = it.transform?.[5] ?? 0;
      const yKey = Math.round(y * 10) / 10;
      const arr = byY.get(yKey) ?? [];
      arr.push({ x, str });
      byY.set(yKey, arr);
    }

    const ys = Array.from(byY.keys()).sort((a, b) => b - a);
    const lines = [];
    for (const y of ys) {
      const arr = byY.get(y).sort((a, b) => a.x - b.x);
      const line = arr.map(o => o.str).join(" ").replace(/\s+/g, " ").trim();
      if (line) lines.push(line);
    }
    return lines;
  }

  function parseHP(lines) {
    const ln = lines.find(l => /^Hit Points\b/i.test(l));
    if (!ln) return null;
    const m = ln.match(/Hit Points\s+(\d+)\s*(?:\(([^)]+)\))?/i);
    if (!m) return null;
    return { value: Number(m[1]), formula: (m[2] ?? "").trim() };
  }
  function parseAC(lines) {
    const ln = lines.find(l => /^Armor Class\b/i.test(l));
    if (!ln) return null;
    const m = ln.match(/Armor Class\s+(\d+)(?:\s*\(([^)]+)\))?/i);
    if (!m) return null;
    return { value: Number(m[1]), detail: (m[2] ?? "").trim() };
  }
  function parseSpeed(lines) {
    const ln = lines.find(l => /^Speed\b/i.test(l));
    if (!ln) return null;
    const s = ln.replace(/^Speed\s+/i, "");
    const parts = s.split(",").map(x => x.trim());
    const move = {};
    for (const p of parts) {
      const m = p.match(/^(walk|fly|swim|climb|burrow)?\s*(\d+)\s*ft/i);
      if (m) {
        const mode = (m[1] ?? "walk").toLowerCase();
        move[mode] = Number(m[2]);
      }
    }
    return move;
  }
  function parseAbilities(lines) {
    const idx = lines.findIndex(l => /\bSTR\b.*\bDEX\b.*\bCON\b.*\bINT\b.*\bWIS\b.*\bCHA\b/i.test(l));
    if (idx < 0) return null;
    const vLine = lines[idx + 1] ?? "";
    let nums = Array.from(vLine.matchAll(/\b(\d{1,2})\b/g)).map(m => Number(m[1]));
    nums = nums.slice(0, 6);
    if (nums.length < 6) return null;
    return { str: nums[0], dex: nums[1], con: nums[2], int: nums[3], wis: nums[4], cha: nums[5] };
  }

  const DAMAGE_TYPES = new Set(["acid","bludgeoning","cold","fire","force","lightning","necrotic","piercing","poison","psychic","radiant","slashing","thunder"]);
  const CONDITION_TYPES = new Set(["blinded","charmed","deafened","exhaustion","frightened","grappled","incapacitated","invisible","paralyzed","petrified","poisoned","prone","restrained","stunned","unconscious"]);

  function parseTraitCSVLine(lines, label) {
    const ln = lines.find(l => l.toLowerCase().startsWith(label.toLowerCase()));
    if (!ln) return null;
    return ln.replace(new RegExp(`^${label}\\s*`, "i"), "").trim();
  }
  function splitCSVish(s) {
    if (!s) return [];
    return s.replace(/;/g, ",").split(",").map(x => x.trim()).filter(Boolean);
  }
  function mapDamageList(raw) {
    const out = { value: [], custom: "" };
    if (!raw) return out;
    const parts = splitCSVish(raw);
    for (const p of parts) {
      const low = p.toLowerCase();
      const hit = Array.from(DAMAGE_TYPES).find(dt => low.includes(dt));
      if (hit) out.value.push(hit);
      else out.custom += (out.custom ? "; " : "") + p;
    }
    out.value = Array.from(new Set(out.value));
    return out;
  }
  function mapConditionList(raw) {
    const out = { value: [], custom: "" };
    if (!raw) return out;
    const parts = splitCSVish(raw);
    for (const p of parts) {
      const low = p.toLowerCase();
      const hit = Array.from(CONDITION_TYPES).find(ct => low.includes(ct));
      if (hit) out.value.push(hit);
      else out.custom += (out.custom ? "; " : "") + p;
    }
    out.value = Array.from(new Set(out.value));
    return out;
  }

  function cleanBlockName(name) {
    const raw = normName(name);
    if (!raw) return raw;
    const stripped = raw
      .replace(/^Action(?=[A-Z])/, "")
      .replace(/^Reaction(?=[A-Z])/, "")
      .replace(/^LegendaryActions?(?=[A-Z])/, "")
      .replace(/^Action\s+/i, "")
      .replace(/^Reaction\s+/i, "")
      .replace(/^Legendary Actions?\s+/i, "");
    return normName(stripped || raw);
  }
  function isSentenceLikeName(name) {
    const s = normName(name);
    if (!s) return false;
    const words = s.split(/\s+/);
    if (/^(The|A|An|Each|Any|If|When|While|On|At|In|After|Before|During|Until|Once)\b/i.test(s) && words.length > 2) return true;
    if (words.length > 6) return true;
    if (/\b(is|are|was|were|be|becomes|become|make|makes|made|hurl|hurls|cast|casts|take|takes|gain|gains|must|can)\b/i.test(s)) return true;
    return false;
  }
  function parseNamedBlocks(sectionLines) {
    const blocks = [];
    let cur = null;
    for (const line of sectionLines) {
      const m = line.match(/^(.+?)(?:\s*\(([^)]+)\))?\.\s*(.*)$/);
      const rawName = m?.[1] ? normName(m[1]) : "";
      const bodyText = m?.[3] ? normName(m[3]) : "";
      const name = cleanBlockName(rawName);
      const looksLikeName = m && name && name.length <= 80 && /^[A-Z]/.test(name) &&
        !/^(Armor Class|Hit Points|Speed|STR|DEX|CON|INT|WIS|CHA|Damage |Condition |Senses |Languages |Challenge |Proficiency Bonus)/i.test(name) &&
        !isSentenceLikeName(name);
      if (looksLikeName) {
        if (cur) blocks.push(cur);
        cur = { name, meta: normName(m[2] ?? ""), text: bodyText };
      } else if (cur) {
        cur.text = normName((cur.text ? cur.text + " " : "") + line);
      }
    }
    if (cur) blocks.push(cur);
    return blocks;
  }

  function parseDamagePartsFromText(text) {
    const parts = [];
    const seen = new Set();
    function pushPart(formula, dtype) {
      const cleaned = normName(formula);
      const low = String(dtype ?? "").toLowerCase();
      if (!cleaned || !low) return;
      if (DAMAGE_TYPES.size && !DAMAGE_TYPES.has(low)) return;
      const key = `${cleaned.toLowerCase()}::${low}`;
      if (seen.has(key)) return;
      seen.add(key);
      parts.push({ formula: cleaned, dtype: low });
    }

    const re = /\(([^)]+)\)\s*([a-z]+)\s*damage/gi;
    let dm;
    while ((dm = re.exec(text)) !== null) {
      pushPart(dm[1], dm[2]);
    }

    const bareRe = /\b(\d+d\d+(?:\s*[+\-]\s*\d+)?)\s*([a-z]+)\s*damage/gi;
    while ((dm = bareRe.exec(text)) !== null) {
      pushPart(dm[1], dm[2]);
    }
    return parts;
  }
  function extractVersatilePart(hitText, parts) {
    const m = hitText.match(/\(([^)]+)\)\s*([a-z]+)\s*damage\s*if used with two hands/i);
    if (!m) return { versatile: null, parts };
    const formula = normName(m[1]);
    const dtype = m[2].toLowerCase();
    const fKey = normName(formula).toLowerCase();
    const cleaned = parts.filter(p => !(normName(p.formula).toLowerCase() === fKey && p.dtype === dtype));
    return { versatile: { formula, dtype }, parts: cleaned };
  }
  function parseAttackRangeInfo(text) {
    if (!text) return null;
    const out = { units: "ft" };
    const reachMatch = text.match(/reach\s+(\d+)\s*(?:ft|feet)\.?/i);
    if (reachMatch) out.reach = Number(reachMatch[1]);
    const rangeMatch = text.match(/range\s+(\d+)(?:\s*\/\s*(\d+))?\s*(?:ft|feet)\.?/i);
    if (rangeMatch) {
      out.value = Number(rangeMatch[1]);
      if (rangeMatch[2]) out.long = Number(rangeMatch[2]);
    }
    return (reachMatch || rangeMatch) ? out : null;
  }
  function parseTargetFromText(text) {
    if (!text) return null;
    const numWords = {
      one: 1, two: 2, three: 3, four: 4, five: 5,
      six: 6, seven: 7, eight: 8, nine: 9, ten: 10
    };
    const m = text.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\b\s+(creature|target|object|enemy|ally)s?/i);
    if (!m) return null;
    const rawCount = m[1].toLowerCase();
    const count = numWords[rawCount] ?? Number(rawCount);
    const rawType = m[2].toLowerCase();
    const type = rawType === "object" ? "object" : "creature";
    return Number.isFinite(count) ? { count, type } : null;
  }
  function parseAreaFromText(text) {
    if (!text) return null;
    const m = text.match(/(\d+)\s*[- ]?foot(?:[- ]radius)?\s*(sphere|cone|cube|line|cylinder)/i);
    if (!m) return null;
    const size = Number(m[1]);
    const type = m[2].toLowerCase();
    const widthMatch = text.match(/(\d+)\s*[- ]?foot\s*[- ]?wide/i);
    const heightMatch = text.match(/(\d+)\s*[- ]?foot\s*[- ]?high/i);
    return {
      size: Number.isFinite(size) ? size : null,
      type,
      units: "ft",
      width: widthMatch ? Number(widthMatch[1]) : null,
      height: heightMatch ? Number(heightMatch[1]) : null
    };
  }
  function normalizeAbilityKey(raw) {
    const s = String(raw ?? "").toLowerCase();
    if (s.startsWith("str")) return "str";
    if (s.startsWith("dex")) return "dex";
    if (s.startsWith("con")) return "con";
    if (s.startsWith("int")) return "int";
    if (s.startsWith("wis")) return "wis";
    if (s.startsWith("cha")) return "cha";
    return "";
  }
  function parseSaveFromText(text) {
    const m = text.match(/\bDC\s*(\d+)\s*([A-Za-z]+)\s*saving throw/i);
    if (!m) return null;
    const dc = Number(m[1]);
    const ability = normalizeAbilityKey(m[2]);
    const parts = parseDamagePartsFromText(text);
    const low = text.toLowerCase();
    let onSave = "half";
    if (/no damage|no effect/.test(low)) onSave = "none";
    else if (/half as much|half the damage|half damage/.test(low)) onSave = "half";
    const range = (() => {
      const r = text.match(/within\s+(\d+)\s*(?:ft|feet)\.?/i);
      if (r) return { value: Number(r[1]), units: "ft" };
      const r2 = text.match(/range\s+(\d+)\s*(?:ft|feet)\.?/i);
      if (r2) return { value: Number(r2[1]), units: "ft" };
      return null;
    })();
    const area = parseAreaFromText(text);
    const target = parseTargetFromText(text);
    return { dc, ability, parts, onSave, range, area, target };
  }

  function parseAttackFromText(text) {
    const cleaned = normName(text)
      .replace(/\u2212/g, "-")
      .replace(/[\u2013\u2014]/g, "-")
      .replace(/\uFF0B/g, "+");
    const attackStart = cleaned.search(/\b(Melee|Ranged|Melee or Ranged)\s+(Weapon|Spell)\s+Attack:/i);
    if (attackStart < 0) return null;
    const slice = cleaned.slice(attackStart);
    const m = slice.match(/^(Melee|Ranged|Melee or Ranged)\s+(Weapon|Spell)\s+Attack:\s*([+\-]?\s*\d+)\s*to hit,?\s*(.+?)(?:[.,\s]+Hit:\s*(.+))?$/i);
    if (!m) return null;

    const modeRaw = m[1].toLowerCase();
    const mode = (modeRaw.includes("melee") && modeRaw.includes("ranged")) ? "melee" : modeRaw;
    const kind = m[2].toLowerCase();
    const toHit = Number(String(m[3]).replace(/\s+/g, ""));
    const rangeText = normName(m[4]).replace(/[.\s]+$/, "");
    const hitText = (m[5] ?? "").trim();
    const damageText = hitText || rangeText;

    const range = parseAttackRangeInfo(rangeText);
    const target = parseTargetFromText(rangeText);

    const parsedParts = parseDamagePartsFromText(damageText);
    const { versatile, parts } = extractVersatilePart(damageText, parsedParts);

    const actionType =
      (mode === "melee" && kind === "weapon") ? "mwak" :
      (mode === "ranged" && kind === "weapon") ? "rwak" :
      (mode === "melee" && kind === "spell")   ? "msak" :
      (mode === "ranged" && kind === "spell")  ? "rsak" : "";

    return { actionType, toHit, parts, versatile, range, target };
  }

  function getAttackModeFromActionType(actionType) {
    const value = actionType?.startsWith("r") ? "ranged" : "melee";
    const classification = actionType?.endsWith("sak") ? "spell" : "weapon";
    return { value, classification };
  }
  function getAttackAbilityFromActionType(actionType) {
    if (!actionType) return "";
    if (actionType.endsWith("sak")) return "spellcasting";
    return actionType.startsWith("r") ? "dex" : "str";
  }
  function getActivationTypeFromSection(sectionLabel) {
    const low = String(sectionLabel ?? "").toLowerCase();
    if (low.includes("legendary")) return "legendary";
    if (low.includes("reaction")) return "reaction";
    if (low.includes("bonus")) return "bonus";
    return "action";
  }
  function abilityModFromScore(score) {
    if (!Number.isFinite(score)) return null;
    return Math.floor((score - 10) / 2);
  }
  function isNumericBonus(value) {
    return (typeof value === "string") && /^-?\d+(\.\d+)?$/.test(value.trim());
  }
  function buildDamagePart(formula, dtype) {
    const src = { system: { scaling: { mode: "none", formula: "" } } };
    const transformer = CONFIG?.DND5E?.activityTypes?.attack?.documentClass?.transformDamagePartData;
    if (typeof transformer === "function") {
      return transformer(src, [formula, dtype]);
    }

    const data = {
      number: null,
      denomination: null,
      bonus: "",
      types: dtype ? [dtype] : [],
      custom: { enabled: false, formula: "" },
      scaling: { mode: "", number: null, formula: "" }
    };
    const parsed = (formula ?? "").match(/^\s*(\d+)d(\d+)(?:\s*([+|-])\s*(\d+))?\s*$/i);
    if (parsed) {
      data.number = Number(parsed[1]);
      data.denomination = Number(parsed[2]);
      if (parsed[4]) data.bonus = parsed[3] === "-" ? `-${parsed[4]}` : parsed[4];
    } else if (formula) {
      data.custom.enabled = true;
      data.custom.formula = formula;
    }
    return data;
  }
  function pickAreaTargetType(rawType) {
    const key = String(rawType ?? "").toLowerCase();
    const cfg = CONFIG?.DND5E?.areaTargetTypes ?? {};
    if (key && key in cfg) return key;
    if (key === "sphere" && "radius" in cfg) return "radius";
    if (key === "radius" && "sphere" in cfg) return "sphere";
    return key || "";
  }
  function buildActivityTarget(area, singleTarget) {
    if (area) {
      return {
        template: {
          count: "",
          contiguous: false,
          type: pickAreaTargetType(area.type),
          size: area.size != null ? String(area.size) : "",
          width: area.width != null ? String(area.width) : "",
          height: area.height != null ? String(area.height) : "",
          units: area.units || "ft"
        },
        affects: {
          count: "",
          type: "",
          choice: false,
          special: ""
        },
        prompt: true
      };
    }
    if (singleTarget) {
      return {
        template: {
          count: "",
          contiguous: false,
          type: "",
          size: "",
          width: "",
          height: "",
          units: "ft"
        },
        affects: {
          count: String(singleTarget.count ?? ""),
          type: singleTarget.type || "creature",
          choice: false,
          special: ""
        },
        prompt: true
      };
    }
    return null;
  }
  function applyParsedAttackToWeaponItem(itemData, creature, parsedAttack, sectionLabel, activityName) {
    const { value, classification } = getAttackModeFromActionType(parsedAttack.actionType);
    const ability = getAttackAbilityFromActionType(parsedAttack.actionType);
    const activationType = getActivationTypeFromSection(sectionLabel);
    const parts = (parsedAttack.parts ?? []).filter(p => p.formula && p.dtype);
    const isSpellAttack = classification === "spell";
    const basePart = isSpellAttack ? null : parts[0];
    const extraParts = isSpellAttack ? parts : parts.slice(1);

    if (basePart) {
      const baseDamage = buildDamagePart(basePart.formula, basePart.dtype);
      if (classification === "weapon" && !baseDamage.custom?.enabled) {
        const mod = abilityModFromScore(creature?.abilities?.[ability]);
        if (mod != null && isNumericBonus(baseDamage.bonus)) {
          const extra = Number(baseDamage.bonus) - mod;
          baseDamage.bonus = extra ? String(extra) : "";
        }
      }
      itemData.system ??= {};
      itemData.system.damage ??= {};
      itemData.system.damage.base = baseDamage;
    }

    if (parsedAttack.versatile) {
      const versatileDamage = buildDamagePart(parsedAttack.versatile.formula, parsedAttack.versatile.dtype);
      if (classification === "weapon" && !versatileDamage.custom?.enabled) {
        const mod = abilityModFromScore(creature?.abilities?.[ability]);
        if (mod != null && isNumericBonus(versatileDamage.bonus)) {
          const extra = Number(versatileDamage.bonus) - mod;
          versatileDamage.bonus = extra ? String(extra) : "";
        }
      }
      itemData.system ??= {};
      itemData.system.damage ??= {};
      itemData.system.damage.versatile = versatileDamage;
      itemData.system.properties ??= [];
      const props = new Set(Array.isArray(itemData.system.properties)
        ? itemData.system.properties
        : Array.from(itemData.system.properties ?? []));
      props.add("ver");
      itemData.system.properties = Array.from(props);
    }

    if (parsedAttack.range) {
      itemData.system ??= {};
      itemData.system.range ??= {};
      if (parsedAttack.range.reach != null) itemData.system.range.reach = parsedAttack.range.reach;
      if (parsedAttack.range.value != null) itemData.system.range.value = parsedAttack.range.value;
      if (parsedAttack.range.long != null) itemData.system.range.long = parsedAttack.range.long;
      if (parsedAttack.range.units) itemData.system.range.units = parsedAttack.range.units;
    }

    const activityId = foundry.utils.randomID();
    const target = buildActivityTarget(null, parsedAttack.target);
    itemData.system.activities = {
      [activityId]: {
        _id: activityId,
        type: "attack",
        name: activityName || itemData.name || "Attack",
        activation: { type: activationType, value: 1, condition: "" },
        attack: {
          ability,
          bonus: String(parsedAttack.toHit ?? ""),
          flat: parsedAttack.toHit != null,
          type: { value, classification }
        },
        damage: {
          includeBase: !!basePart,
          parts: extraParts.map(p => buildDamagePart(p.formula, p.dtype))
        },
        ...(target ? { target } : {})
      }
    };
  }
  function applySaveActivityToFeat(itemData, saveData, sectionLabel, name) {
    const activityId = foundry.utils.randomID();
    const activationType = getActivationTypeFromSection(sectionLabel);
    const target = buildActivityTarget(saveData.area, saveData.target);

    const activity = {
      _id: activityId,
      type: "save",
      name: name || "Save",
      activation: { type: activationType, value: 1, condition: "" },
      save: {
        ability: [saveData.ability || "dex"],
        dc: {
          calculation: "",
          formula: String(saveData.dc ?? "")
        }
      },
      damage: {
        onSave: saveData.onSave || "half",
        parts: (saveData.parts ?? []).map(p => buildDamagePart(p.formula, p.dtype))
      }
    };

    if (saveData.range) {
      activity.range = {
        value: saveData.range.value != null ? String(saveData.range.value) : "",
        units: saveData.range.units || "ft",
        special: ""
      };
    }
    if (target) activity.target = target;

    itemData.system ??= {};
    itemData.system.activities = { [activityId]: activity };
  }
  function applyUtilityActivityToFeat(itemData, sectionLabel, name) {
    const activityId = foundry.utils.randomID();
    const activationType = getActivationTypeFromSection(sectionLabel);
    itemData.system ??= {};
    itemData.system.activities = {
      [activityId]: {
        _id: activityId,
        type: "utility",
        name: name || "Utility",
        activation: { type: activationType, value: 1, condition: "" },
        roll: { formula: "", name: "", prompt: false, visible: false }
      }
    };
  }

  function makeTempItemData(base) {
    const ItemCls = CONFIG.Item.documentClass;
    const tmp = new ItemCls(base, { temporary: true });
    const data = tmp.toObject();
    delete data._id;
    return data;
  }
  function makeTempActorData(base) {
    const ActorCls = CONFIG.Actor.documentClass;
    const tmp = new ActorCls(base, { temporary: true });
    const data = tmp.toObject();
    delete data._id;
    return data;
  }

  // ====== lookup global ======
  function rankPackEntry(entry) {
    let score = 0;
    if (entry.pkg === "dnd5e") score += 100;
    if (entry.packId?.startsWith("world.")) score += 80;
    else score += 40;
    if ((entry.label ?? "").toLowerCase().includes("srd")) score += 10;
    return score;
  }

  async function buildGlobalItemIndex(progressLog, excludePackId) {
    const packs = game.packs.filter(p => p.documentName === "Item");
    const byTypeName = new Map();
    const byName = new Map();

    progressLog?.(`Indexation des compendiums Item (${packs.length})…`);
    let i = 0;
    for (const pack of packs) {
      i++;
      let idx;
      try {
        idx = await pack.getIndex({ fields: ["name", "type"] });
      } catch (e) {
        progressLog?.(`- Skip index ${pack.collection}: ${e.message ?? e}`);
        continue;
      }

      for (const it of idx) {
        const name = normName(it.name);
        const type = it.type;
        if (!name || !type) continue;

        const entry = {
          packId: pack.collection,
          docId: it._id,
          name,
          type,
          label: pack.metadata?.label ?? pack.metadata?.name ?? pack.collection,
          pkg: pack.metadata?.package ?? ""
        };

        const k1 = `${type}::${lcName(name)}`;
        (byTypeName.get(k1) ?? byTypeName.set(k1, []).get(k1)).push(entry);

        const k2 = lcName(name);
        (byName.get(k2) ?? byName.set(k2, []).get(k2)).push(entry);
      }

      if (i % 10 === 0) progressLog?.(`…indexés: ${i}/${packs.length}`);
    }

    function findByTypeAndNames(type, names) {
      const hits = [];
      for (const n of names) {
        const key = `${type}::${lcName(n)}`;
        const arr = byTypeName.get(key);
        if (arr?.length) hits.push(...arr);
      }
      hits.sort((a, b) => rankPackEntry(b) - rankPackEntry(a));
      const elsewhere = hits.find(h => h.packId !== excludePackId);
      return elsewhere ?? hits[0] ?? null;
    }

    function findAnyNonFeatSpellByNames(names) {
      const hits = [];
      for (const n of names) {
        const arr = byName.get(lcName(n));
        if (arr?.length) hits.push(...arr);
      }
      const filtered = hits.filter(h => !["feat", "spell"].includes(h.type));
      filtered.sort((a, b) => rankPackEntry(b) - rankPackEntry(a));
      const elsewhere = filtered.find(h => h.packId !== excludePackId);
      return elsewhere ?? filtered[0] ?? null;
    }

    return { findByTypeAndNames, findAnyNonFeatSpellByNames };
  }

  async function fetchItemAsEmbedded(entry, { embedName, appendHtml } = {}) {
    const pack = game.packs.get(entry.packId);
    if (!pack) throw new Error(`Pack introuvable: ${entry.packId}`);
    const doc = await pack.getDocument(entry.docId);
    if (!doc) throw new Error(`Item introuvable: ${entry.packId}.${entry.docId}`);

    const obj = doc.toObject();
    delete obj._id;

    if (embedName) obj.name = embedName;

    if (appendHtml) {
      obj.system = obj.system ?? {};
      obj.system.description = obj.system.description ?? {};
      const cur = obj.system.description.value ?? "";
      obj.system.description.value = `${cur || ""}${cur ? "<hr/>" : ""}${appendHtml}`;
    }
    return obj;
  }

  function parseCreatureFromLines(lines, pageNumber) {
    const idxAC = lines.findIndex(l => /^Armor Class\b/i.test(l));
    const idxHP = lines.findIndex(l => /^Hit Points\b/i.test(l));
    const idxSpeed = lines.findIndex(l => /^Speed\b/i.test(l));
    if (idxAC < 0 || idxHP < 0 || idxSpeed < 0) return null;

    const idxSize = lines.findIndex(l => /^(Tiny|Small|Medium|Large|Huge|Gargantuan)\b/i.test(l) && /,/.test(l));
    let name = null;
    if (idxSize > 0) name = normName(lines[idxSize - 1]);
    else {
      const before = lines.slice(0, idxAC).filter(l => l && !/^Proficiency Bonus\b/i.test(l));
      name = normName(before[before.length - 1] ?? "Unknown Creature");
    }
    if (!name || /^Hit Points\b/i.test(name)) return null;

    const ac = parseAC(lines);
    const hp = parseHP(lines);
    const speed = parseSpeed(lines);
    const abilities = parseAbilities(lines);

    const rawDR = parseTraitCSVLine(lines, "Damage Resistances");
    const rawDI = parseTraitCSVLine(lines, "Damage Immunities");
    const rawDV = parseTraitCSVLine(lines, "Damage Vulnerabilities");
    const rawCI = parseTraitCSVLine(lines, "Condition Immunities");

    const actionsIdx = lines.findIndex(l => /^Actions\b/i.test(l));
    const reactionsIdx = lines.findIndex(l => /^Reactions\b/i.test(l));
    const legendaryIdx = lines.findIndex(l => /^Legendary Actions\b/i.test(l));

    const endOfStatsIdx = Math.max(
      lines.findIndex(l => /^Challenge\b/i.test(l)),
      lines.findIndex(l => /^Languages\b/i.test(l)),
      lines.findIndex(l => /^Senses\b/i.test(l))
    );

    const traitsStart = (endOfStatsIdx >= 0) ? endOfStatsIdx + 1 : (idxSpeed + 1);
    const traitsEnd = (actionsIdx >= 0) ? actionsIdx : lines.length;

    const traitLines = lines.slice(traitsStart, traitsEnd).filter(l => l && !/^\d{3,}$/.test(l));
    const traits = parseNamedBlocks(traitLines);

    const actionsEnd = reactionsIdx >= 0 ? reactionsIdx : (legendaryIdx >= 0 ? legendaryIdx : lines.length);
    const actionLines = (actionsIdx >= 0) ? lines.slice(actionsIdx + 1, actionsEnd).filter(l => l && !/^\d{3,}$/.test(l)) : [];
    const actions = parseNamedBlocks(actionLines);

    const reactionLines = (reactionsIdx >= 0)
      ? lines.slice(reactionsIdx + 1, (legendaryIdx >= 0 ? legendaryIdx : lines.length)).filter(l => l && !/^\d{3,}$/.test(l))
      : [];
    const reactions = parseNamedBlocks(reactionLines);

    const legendaryLines = (legendaryIdx >= 0)
      ? lines.slice(legendaryIdx + 1).filter(l => l && !/^\d{3,}$/.test(l))
      : [];
    const legendary = parseNamedBlocks(legendaryLines);

    return {
      kind: "creature",
      page: pageNumber,
      name,
      ac, hp, speed, abilities,
      traits: {
        dr: mapDamageList(rawDR),
        di: mapDamageList(rawDI),
        dv: mapDamageList(rawDV),
        ci: mapConditionList(rawCI)
      },
      features: traits,
      actions,
      reactions,
      legendary
    };
  }

  function parseMagicItemFromLines(lines, pageNumber) {
    const idxWI = lines.findIndex(l => /\bWondrous Item\b/i.test(l));
    if (idxWI < 0) return null;

    const titleParts = [];
    for (let i = Math.max(0, idxWI - 3); i < idxWI; i++) {
      const s = normName(lines[i]);
      if (!s) continue;
      if (/^Proficiency Bonus\b/i.test(s)) continue;
      if (/^\d{3,}$/.test(s)) continue;
      titleParts.push(s);
    }
    const title = normName(titleParts.slice(-2).join(" "));
    if (!title) return null;

    const typeLine = normName(lines[idxWI]);
    const body = normName(lines.slice(idxWI + 1).join("\n"));
    return { kind: "magicItem", page: pageNumber, name: title, typeLine, body };
  }

  function parseSpellsInsideText(text) {
    const spells = [];
    const re = /(^|\n)([A-Z][A-Za-z’' \-]{2,60})\n(\d+(?:st|nd|rd|th)-level\s+[^\n]+)\n/g;
    let m;
    while ((m = re.exec(text)) !== null) spells.push({ name: normName(m[2]), header: normName(m[3]) });
    const seen = new Set();
    return spells.filter(s => { const k = s.name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  }

  async function buildItemsForCreature(creature, itemPack, options, globalIndex, stats) {
    const embedded = [];

    async function upsertItemToPack(data) {
      const idx = await itemPack.getIndex({ fields: ["name", "type"] });
      const hit = idx.find(e => lcName(e.name) === lcName(data.name) && e.type === data.type);

      if (hit && options.overwrite) {
        await packDeleteDocuments(itemPack, [hit._id]);
        const [doc] = await itemPack.documentClass.createDocuments([data], { pack: itemPack.collection });
        return doc;
      }
      if (hit && !options.overwrite) return null;

      const [doc] = await itemPack.documentClass.createDocuments([data], { pack: itemPack.collection });
      return doc;
    }

    for (const f of creature.features ?? []) {
      const baseName = f.name;
      const wouldCreateName = `${creature.name} — ${f.name}`;

      const existing = globalIndex.findByTypeAndNames("feat", [baseName, wouldCreateName]);
      if (existing && existing.packId !== itemPack.collection) {
        const append = `<p><small>Source PDF: ${creature.name} (p.${creature.page})</small><br/><strong>${f.meta ? `${f.name} (${f.meta})` : f.name}.</strong> ${f.text}</p>`;
        const emb = await fetchItemAsEmbedded(existing, { embedName: baseName, appendHtml: append });
        embedded.push(emb);
        stats.reusedItems.push(`${baseName} ← ${existing.label}`);
        continue;
      }

      const featData = makeTempItemData({ name: wouldCreateName, type: "feat" });
      featData.system ??= {};
      featData.system.description ??= {};
      featData.system.description.value = `<p><strong>${f.meta ? `${f.name} (${f.meta})` : f.name}.</strong> ${f.text}</p>`;

      const doc = await upsertItemToPack(featData);
      if (doc) stats.createdItems.push(doc.name); else stats.ignoredItems.push(wouldCreateName);

      const emb = foundry.utils.deepClone(featData);
      emb.name = baseName;
      delete emb._id;
      embedded.push(emb);
    }

    async function handleActionBlock(block, sectionLabel) {
      const baseName = block.name;
      const parsedAttack = parseAttackFromText(block.text);

      if (parsedAttack && parsedAttack.actionType) {
        const wouldCreateName = `${creature.name} — ${block.name}`;
        const existing = globalIndex.findByTypeAndNames("weapon", [wouldCreateName]);

        if (existing && existing.packId !== itemPack.collection) {
          const append = `<p><small>Source PDF: ${creature.name} (p.${creature.page})</small><br/>${block.meta ? `<em>${block.meta}</em><br/>` : ""}${block.text}</p>`;
          const emb = await fetchItemAsEmbedded(existing, { embedName: baseName, appendHtml: append });
          embedded.push(emb);
          stats.reusedItems.push(`${baseName} ← ${existing.label}`);
          return;
        }

        const wpn = makeTempItemData({ name: wouldCreateName, type: "weapon" });
        wpn.system ??= {};
        wpn.system.description ??= {};
        wpn.system.description.value = `<p>${block.meta ? `<em>${block.meta}</em><br/>` : ""}${block.text}</p>`;
        applyParsedAttackToWeaponItem(wpn, creature, parsedAttack, sectionLabel, block.name);

        const doc = await upsertItemToPack(wpn);
        if (doc) stats.createdItems.push(doc.name); else stats.ignoredItems.push(wouldCreateName);

        const emb = foundry.utils.deepClone(wpn);
        emb.name = baseName;
        delete emb._id;
        embedded.push(emb);
        return;
      }

      const wouldCreateName = `${creature.name} — ${block.name}`;
      const existing = globalIndex.findByTypeAndNames("feat", [baseName, wouldCreateName]);

      if (existing && existing.packId !== itemPack.collection) {
        const append = `<p><small>${sectionLabel} — Source PDF: ${creature.name} (p.${creature.page})</small><br/><strong>${block.meta ? `${block.name} (${block.meta})` : block.name}.</strong> ${block.text}</p>`;
        const emb = await fetchItemAsEmbedded(existing, { embedName: baseName, appendHtml: append });
        embedded.push(emb);
        stats.reusedItems.push(`${baseName} ← ${existing.label}`);
        return;
      }

      const feat = makeTempItemData({ name: wouldCreateName, type: "feat" });
      feat.system ??= {};
      feat.system.description ??= {};
      feat.system.description.value = `<p><small>${sectionLabel}</small><br/><strong>${block.meta ? `${block.name} (${block.meta})` : block.name}.</strong> ${block.text}</p>`;
      const parsedSave = parseSaveFromText(block.text);
      if (parsedSave) applySaveActivityToFeat(feat, parsedSave, sectionLabel, block.name);
      else applyUtilityActivityToFeat(feat, sectionLabel, block.name);

      const doc = await upsertItemToPack(feat);
      if (doc) stats.createdItems.push(doc.name); else stats.ignoredItems.push(wouldCreateName);

      const emb = foundry.utils.deepClone(feat);
      emb.name = baseName;
      delete emb._id;
      embedded.push(emb);
    }

    for (const a of creature.actions ?? []) await handleActionBlock(a, "Action");
    for (const r of creature.reactions ?? []) await handleActionBlock(r, "Reaction");
    for (const l of creature.legendary ?? []) await handleActionBlock(l, "Legendary Action");

    return { embeddedItems: embedded };
  }

  async function buildItemsForMagicItem(mItem, itemPack, options, globalIndex, stats) {
    async function upsert(data) {
      const idx = await itemPack.getIndex({ fields: ["name", "type"] });
      const hit = idx.find(e => lcName(e.name) === lcName(data.name) && e.type === data.type);

      if (hit && options.overwrite) {
        await packDeleteDocuments(itemPack, [hit._id]);
        const [doc] = await itemPack.documentClass.createDocuments([data], { pack: itemPack.collection });
        return doc;
      }
      if (hit && !options.overwrite) return null;

      const [doc] = await itemPack.documentClass.createDocuments([data], { pack: itemPack.collection });
      return doc;
    }

    const existingObj = globalIndex.findAnyNonFeatSpellByNames([mItem.name]);
    if (existingObj && existingObj.packId !== itemPack.collection) {
      stats.reusedItems.push(`${mItem.name} ← ${existingObj.label}`);
    } else {
      const eq = makeTempItemData({ name: mItem.name, type: "equipment" });
      eq.system ??= {};
      eq.system.description ??= {};
      eq.system.description.value = `<p><em>${mItem.typeLine}</em></p>\n${mItem.body}`;

      const doc = await upsert(eq);
      if (doc) stats.createdItems.push(doc.name); else stats.ignoredItems.push(eq.name);
    }

    const spells = parseSpellsInsideText(mItem.body);
    for (const sp of spells) {
      const existingSpell = globalIndex.findByTypeAndNames("spell", [sp.name]);
      if (existingSpell && existingSpell.packId !== itemPack.collection) {
        stats.reusedItems.push(`${sp.name} ← ${existingSpell.label}`);
        continue;
      }

      const spellData = makeTempItemData({ name: sp.name, type: "spell" });
      spellData.system ??= {};
      spellData.system.description ??= {};
      spellData.system.description.value = `<p><strong>${sp.name}</strong></p><p><em>${sp.header}</em></p><p>(Description complète: voir le PDF)</p>`;

      const sdoc = await upsert(spellData);
      if (sdoc) stats.createdItems.push(sdoc.name); else stats.ignoredItems.push(sp.name);
    }
  }

  async function runImport() {
    if (!game.user.isGM) return ui.notifications.warn("GM uniquement.");

    const pdfFile = await pickLocalPDF();
    if (!pdfFile) return ui.notifications.warn("Aucun PDF sélectionné.");

    const pdfLabelSlug = slugify(pdfFile.name.replace(/\.pdf$/i, ""));
    const actorPackName = `pdfimp-${pdfLabelSlug}-actors`;
    const itemPackName  = `pdfimp-${pdfLabelSlug}-items`;

    let overwrite = true;
    let actorPackLabel = `${DEFAULT_ACTOR_PACK_LABEL} (${pdfFile.name})`;
    let itemPackLabel  = `${DEFAULT_ITEM_PACK_LABEL} (${pdfFile.name})`;

    await new Promise((resolve) => {
      new Dialog({
        title: "PDF Import — Options",
        content: `
          <div style="display:flex; flex-direction:column; gap:10px;">
            <p><strong>PDF :</strong> ${pdfFile.name} (${Math.round(pdfFile.size/1024/1024)} MB)</p>
            <div class="form-group">
              <label>Nom compendium Actors</label>
              <input type="text" name="apl" value="${actorPackLabel}"/>
            </div>
            <div class="form-group">
              <label>Nom compendium Items</label>
              <input type="text" name="ipl" value="${itemPackLabel}"/>
            </div>
            <div class="form-group">
              <label>Écraser si déjà présent (delete+create)</label>
              <input type="checkbox" name="ow" ${overwrite ? "checked" : ""}/>
            </div>
          </div>
        `,
        buttons: {
          go: {
            icon: '<i class="fas fa-play"></i>',
            label: "Lancer",
            callback: (html) => {
              actorPackLabel = html.find('input[name="apl"]').val();
              itemPackLabel  = html.find('input[name="ipl"]').val();
              overwrite      = html.find('input[name="ow"]').is(":checked");
              resolve();
            }
          },
          cancel: { label: "Annuler", callback: () => resolve("cancel") }
        },
        default: "go"
      }).render(true);
    });

    const progress = await createProgressDialog("PDF Import — Progression", 100);
    progress.log("Chargement pdf.js…");

    const { lib: pdfjsLib, workerUrl } = await loadPdfjsLib((m) => progress.log(m));
    if (workerUrl && pdfjsLib?.GlobalWorkerOptions) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
      progress.log(`WorkerSrc configuré: ${workerUrl}`);
    }

    progress.log("Lecture du PDF en mémoire…");
    const buffer = await pdfFile.arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({ data: buffer, disableWorker: true });
    const pdf = await loadingTask.promise;

    const totalPages = pdf.numPages;
    progress.set(0, `PDF chargé. Pages: ${totalPages}`);

    const actorPack = await getOrCreatePack({ documentName: "Actor", label: actorPackLabel, name: actorPackName });
    const itemPack  = await getOrCreatePack({ documentName: "Item",  label: itemPackLabel,  name: itemPackName });

    const globalIndex = await buildGlobalItemIndex((m) => progress.log(m), itemPack.collection);

    const foundCreatures = [];
    const foundMagicItems = [];
    let quasiEmpty = 0;

    const summary = {
      pages: totalPages,
      quasiEmpty: 0,
      detected: { creatures: 0, magicItems: 0 },
      created: { actors: 0, items: 0 },
      ignored: { actors: 0, items: 0 },
      errors: []
    };

    const stats = {
      createdItems: [],
      ignoredItems: [],
      reusedItems: []
    };

    for (let p = 1; p <= totalPages; p++) {
      if (progress.isCancelled()) break;
      const pct = Math.round((p / totalPages) * 100);
      progress.set(pct, `Analyse page ${p}/${totalPages}…`);

      let lines = [];
      try {
        lines = await extractLinesFromPage(pdf, p);
      } catch (e) {
        summary.errors.push(`Page ${p}: extraction texte impossible — ${e.message ?? e}`);
        continue;
      }

      const joined = lines.join(" ").replace(/\s+/g, " ").trim();
      if (!joined || joined.length < 40) { quasiEmpty++; continue; }

      const creature = parseCreatureFromLines(lines, p);
      if (creature) { foundCreatures.push(creature); continue; }

      const mi = parseMagicItemFromLines(lines, p);
      if (mi) { foundMagicItems.push(mi); continue; }
    }

    summary.detected.creatures = foundCreatures.length;
    summary.detected.magicItems = foundMagicItems.length;
    summary.quasiEmpty = quasiEmpty;

    progress.log(`Détecté: ${foundCreatures.length} créature(s), ${foundMagicItems.length} item(s).`);
    progress.set(100, "Création des compendiums…");

    async function upsertActorToPack(actorData) {
      const idx = await actorPack.getIndex({ fields: ["name", "type"] });
      const hit = idx.find(e => lcName(e.name) === lcName(actorData.name) && e.type === actorData.type);

      if (hit && overwrite) {
        await packDeleteDocuments(actorPack, [hit._id]);
        const [doc] = await actorPack.documentClass.createDocuments([actorData], { pack: actorPack.collection });
        return doc;
      }
      if (hit && !overwrite) return null;

      const [doc] = await actorPack.documentClass.createDocuments([actorData], { pack: actorPack.collection });
      return doc;
    }

    const options = { overwrite };

    for (const c of foundCreatures) {
      if (progress.isCancelled()) break;

      try {
        progress.log(`Actor: ${c.name} (p.${c.page})…`);

        const built = await buildItemsForCreature(c, itemPack, options, globalIndex, stats);

        const actorData = makeTempActorData({ name: c.name, type: "npc" });
        actorData.img = actorData.img || "icons/svg/mystery-man.svg";
        actorData.flags ??= {};
        actorData.flags[IMPORT_NS] = { source: pdfFile.name, page: c.page };

        if (c.hp?.value != null) {
          foundry.utils.setProperty(actorData, "system.attributes.hp.value", c.hp.value);
          foundry.utils.setProperty(actorData, "system.attributes.hp.max", c.hp.value);
          if (c.hp.formula) foundry.utils.setProperty(actorData, "system.attributes.hp.formula", c.hp.formula);
        }
        if (c.ac?.value != null) foundry.utils.setProperty(actorData, "system.attributes.ac.value", c.ac.value);

        if (c.speed) {
          for (const [k, v] of Object.entries(c.speed)) {
            foundry.utils.setProperty(actorData, `system.attributes.movement.${k}`, v);
          }
        }
        if (c.abilities) {
          for (const [ab, val] of Object.entries(c.abilities)) {
            foundry.utils.setProperty(actorData, `system.abilities.${ab}.value`, val);
          }
        }

        if (c.traits?.dr) {
          foundry.utils.setProperty(actorData, "system.traits.dr.value", c.traits.dr.value);
          foundry.utils.setProperty(actorData, "system.traits.dr.custom", c.traits.dr.custom);
        }
        if (c.traits?.di) {
          foundry.utils.setProperty(actorData, "system.traits.di.value", c.traits.di.value);
          foundry.utils.setProperty(actorData, "system.traits.di.custom", c.traits.di.custom);
        }
        if (c.traits?.dv) {
          foundry.utils.setProperty(actorData, "system.traits.dv.value", c.traits.dv.value);
          foundry.utils.setProperty(actorData, "system.traits.dv.custom", c.traits.dv.custom);
        }
        if (c.traits?.ci) {
          foundry.utils.setProperty(actorData, "system.traits.ci.value", c.traits.ci.value);
          foundry.utils.setProperty(actorData, "system.traits.ci.custom", c.traits.ci.custom);
        }

        actorData.items = built.embeddedItems ?? [];

        const doc = await upsertActorToPack(actorData);
        if (doc) summary.created.actors++;
        else summary.ignored.actors++;

      } catch (e) {
        summary.errors.push(`Actor ${c.name}: ${e.message ?? e}\n${e?.stack ?? ""}`);
      }
    }

    for (const mi of foundMagicItems) {
      if (progress.isCancelled()) break;

      try {
        progress.log(`Item: ${mi.name} (p.${mi.page})…`);
        await buildItemsForMagicItem(mi, itemPack, options, globalIndex, stats);
      } catch (e) {
        summary.errors.push(`Item ${mi.name}: ${e.message ?? e}\n${e?.stack ?? ""}`);
      }
    }

    summary.created.items = stats.createdItems.length;
    summary.ignored.items = stats.ignoredItems.length;

    progress.close();

    // ✅ FIX: erreurs + reused copiable
    const errorsText = summary.errors.length ? summary.errors.join("\n\n") : "Aucune";
    const reusedText = stats.reusedItems.length ? stats.reusedItems.join("\n") : "Aucune";

    new Dialog({
      title: "Import terminé — Résumé",
      content: `
        <div style="display:flex; flex-direction:column; gap:10px;">
          <div>
            <p><strong>Pages traitées:</strong> 1 → ${summary.pages}</p>
            <p><strong>Pages “quasi vides”:</strong> ${summary.quasiEmpty} / ${summary.pages}</p>
            <p><strong>Détecté:</strong> Créatures ${summary.detected.creatures}, Items ${summary.detected.magicItems}</p>
            <hr/>
            <p><strong>Créés:</strong> Actors ${summary.created.actors}, Items ${summary.created.items}</p>
            <p><strong>Ignorés:</strong> Actors ${summary.ignored.actors}, Items ${summary.ignored.items}</p>
          </div>

          <h3 style="margin:0;">Réutilisés (compendiums)</h3>
          <textarea readonly style="width:100%; height:140px; resize:vertical;">${reusedText}</textarea>
          <div style="font-size:11px; opacity:0.8;">(Copiable)</div>

          <h3 style="margin:0;">Erreurs</h3>
          <textarea readonly style="width:100%; height:180px; resize:vertical;">${errorsText}</textarea>
          <div style="font-size:11px; opacity:0.8;">(Copiable)</div>
        </div>
      `,
      buttons: { ok: { label: "OK" } }
    }).render(true);
  }

  try {
    await runImport();
  } catch (e) {
    console.error(e);
    ui.notifications.error(e?.message ?? String(e));
  }
})();

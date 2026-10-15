#!/usr/bin/env python3
"""
Extract actors and items from a PDF and output Foundry-ready JSON/DB files.

Usage:
  python extract-compendium-from-pdf.py --pdf "C:\\path\\file.pdf" --out-dir "C:\\out"

Optional LLM parsing (local Llama via HTTP):
  python extract-compendium-from-pdf.py --pdf "C:\\path\\file.pdf" --out-dir "C:\\out" --llm --llm-provider ollama --llm-model llama3.1:8b
  python extract-compendium-from-pdf.py --pdf "C:\\path\\file.pdf" --out-dir "C:\\out" --llm --llm-provider openai --llm-url http://localhost:8080/v1/chat/completions --llm-model llama3.1

Two-column PDFs (lines of both columns interleave, e.g. "Better Undead Compendium.pdf"): the regex parser misses
most stat blocks, use the LLM with --llm-mode prefer. The stat lines (challenge, senses, languages, saving throws,
skills, damage and condition traits) are always read from the page text, see apply_stat_lines():
  python extract-compendium-from-pdf.py --pdf "tools/Better Undead Compendium.pdf" --out-dir tools/out --llm --llm-model llama3.1:8b --llm-mode prefer --llm-timeout 300

Dependencies:
  pip install pdfplumber
"""
import argparse
import json
import logging
import os
import random
import re
import string
import time
import urllib.error
import urllib.request
from copy import deepcopy

import pdfplumber

logging.getLogger("pdfminer").setLevel(logging.ERROR)

DAMAGE_TYPES = {
    "acid", "bludgeoning", "cold", "fire", "force", "lightning", "necrotic",
    "piercing", "poison", "psychic", "radiant", "slashing", "thunder"
}

CONDITION_TYPES = {
    "blinded", "charmed", "deafened", "exhaustion", "frightened", "grappled",
    "incapacitated", "invisible", "paralyzed", "petrified", "poisoned",
    "prone", "restrained", "stunned", "unconscious"
}

# Labels of the stat block lines. In some PDFs the label is alone on its line and the value follows on the next
# line(s) ("Challenge Proficiency Bonus" / "18 (20,000 XP) +6"), see labelled_value().
STAT_LABELS = [
    "Armor Class", "Hit Points", "Speed", "Saving Throws", "Skills",
    "Damage Vulnerabilities", "Damage Resistances", "Damage Immunities", "Condition Immunities",
    "Senses", "Languages", "Challenge", "Proficiency Bonus",
]
STAT_LABEL_RE = re.compile(r"^(" + "|".join(re.escape(label) for label in STAT_LABELS) + r")\b", re.I)
ABILITY_ROW_RE = re.compile(r"\bSTR\b.*\bDEX\b.*\bCON\b.*\bINT\b.*\bWIS\b.*\bCHA\b", re.I)

# dnd5e 6.0.6 keys (CONFIG.DND5E.senses, CONFIG.DND5E.skills, CONFIG.DND5E.languages).
SENSE_TYPES = ("blindsight", "darkvision", "tremorsense", "truesight")
SKILL_KEYS = {
    "acrobatics": "acr", "animal handling": "ani", "arcana": "arc", "athletics": "ath", "deception": "dec",
    "history": "his", "insight": "ins", "intimidation": "itm", "investigation": "inv", "medicine": "med",
    "nature": "nat", "perception": "prc", "performance": "prf", "persuasion": "per", "religion": "rel",
    "sleight of hand": "slt", "stealth": "ste", "survival": "sur",
}
SKILL_ABILITIES = {
    "acr": "dex", "ani": "wis", "arc": "int", "ath": "str", "dec": "cha", "his": "int", "ins": "wis",
    "itm": "cha", "inv": "int", "med": "wis", "nat": "int", "prc": "wis", "prf": "cha", "per": "cha",
    "rel": "int", "slt": "dex", "ste": "dex", "sur": "wis",
}
LANGUAGE_KEYS = {
    "common sign language": "sign", "thieves' cant": "cant", "thieves cant": "cant", "deep speech": "deep",
    "common": "common", "draconic": "draconic", "dwarvish": "dwarvish", "elvish": "elvish", "giant": "giant",
    "gnomish": "gnomish", "goblin": "goblin", "halfling": "halfling", "orc": "orc", "aarakocra": "aarakocra",
    "abyssal": "abyssal", "celestial": "celestial", "druidic": "druidic", "gith": "gith", "gnoll": "gnoll",
    "infernal": "infernal", "primordial": "primordial", "aquan": "aquan", "auran": "auran", "ignan": "ignan",
    "terran": "terran", "sylvan": "sylvan", "undercommon": "undercommon",
}
CR_FRACTIONS = {"1/8": 0.125, "1/4": 0.25, "1/2": 0.5, "⅛": 0.125, "¼": 0.25, "½": 0.5}
CR_VALUE_RE = r"(\d+\s*/\s*\d+|[⅛¼½]|\d+(?:\.\d+)?)"


def random_id(length=16):
    chars = string.ascii_letters + string.digits
    return "".join(random.choice(chars) for _ in range(length))


def slugify(value):
    value = str(value or "").lower()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return re.sub(r"(^-|-$)", "", value)[:60]


def norm_name(value):
    return re.sub(r"\s+", " ", str(value or "").strip())


def lc_name(value):
    return norm_name(value).lower()


def extract_lines_from_page(page):
    words = page.extract_words(x_tolerance=1, y_tolerance=2, keep_blank_chars=False)
    by_y = {}
    for w in words:
        text = str(w.get("text", "")).strip()
        if not text:
            continue
        x = float(w.get("x0", 0))
        y = round(float(w.get("top", 0)), 1)
        by_y.setdefault(y, []).append((x, text))

    lines = []
    for y in sorted(by_y.keys()):
        parts = [t for _, t in sorted(by_y[y], key=lambda p: p[0])]
        line = norm_name(" ".join(parts))
        if line:
            lines.append(line)
    return lines


LLM_DEFAULT_PROVIDER = "ollama"
LLM_DEFAULT_MODEL = "llama3.1"
LLM_DEFAULT_URLS = {
    "ollama": "http://localhost:11434/api/chat",
    "openai": "http://localhost:8080/v1/chat/completions",
}


def build_llm_prompt(lines):
    lines_text = "\n".join(lines)
    prompt_lines = [
        "Extract a JSON object from the text lines below.",
        "Return JSON only, no extra text or markdown.",
        "",
        "Schema:",
        "{",
        '  "kind": "creature|magicItem|none",',
        '  "name": "string",',
        '  "ac": {"value": number, "detail": "string"} or null,',
        '  "hp": {"value": number, "formula": "string"} or null,',
        '  "speed": {"walk": number, "fly": number, "swim": number, "climb": number, "burrow": number} or null,',
        '  "abilities": {"str": number, "dex": number, "con": number, "int": number, "wis": number, "cha": number} or null,',
        '  "damage_resistances": "string",',
        '  "damage_immunities": "string",',
        '  "damage_vulnerabilities": "string",',
        '  "condition_immunities": "string",',
        '  "saving_throws": "string",',
        '  "skills": "string",',
        '  "senses": "string",',
        '  "languages": "string",',
        '  "challenge": "string",',
        '  "proficiency_bonus": "string",',
        '  "features": [{"name": "string", "meta": "string", "text": "string"}],',
        '  "actions": [{"name": "string", "meta": "string", "text": "string"}],',
        '  "reactions": [{"name": "string", "meta": "string", "text": "string"}],',
        '  "legendary": [{"name": "string", "meta": "string", "text": "string"}],',
        '  "typeLine": "string",',
        '  "body": "string"',
        "}",
        "",
        "Rules:",
        "- Treat lore/intro/section text as non-content and ignore it.",
        "- Only return kind='creature' if a full stat block is present (Armor Class, Hit Points, Speed, and ability scores).",
        '- If the page is not a creature or magic item, set kind="none".',
        "- Use null for unknown structured fields.",
        "- For action or feature blocks, split at the first period after the name.",
        "- Put parenthetical tags like (Recharge 5-6) into meta.",
        '- Copy the stat lines as written: saving_throws "Str +11, Wis +9", skills "Perception +4",',
        '  senses "darkvision 120 ft., passive Perception 13", languages "Common, Abyssal",',
        '  challenge "18 (20,000 XP)", proficiency_bonus "+6".',
        "",
        "Text lines:",
        lines_text,
    ]
    return "\n".join(prompt_lines)


def call_llm(messages, config):
    provider = config["provider"]
    payload = {
        "model": config["model"],
        "messages": messages,
        "stream": False,
    }
    headers = {"Content-Type": "application/json"}

    if provider == "ollama":
        if config.get("temperature") is not None:
            payload["options"] = {"temperature": config["temperature"]}
    else:
        if config.get("temperature") is not None:
            payload["temperature"] = config["temperature"]
        api_key = config.get("api_key")
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"

    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(config["url"], data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=config["timeout"]) as resp:
        raw = resp.read().decode("utf-8")
    parsed = json.loads(raw)

    if provider == "ollama":
        message = parsed.get("message") or {}
        return message.get("content") or parsed.get("response") or ""
    choices = parsed.get("choices") or []
    if not choices:
        return ""
    choice = choices[0] or {}
    message = choice.get("message") or {}
    return message.get("content") or choice.get("text") or ""


def extract_json_object(text):
    start = text.find("{")
    if start < 0:
        return None
    depth = 0
    in_string = False
    escape = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
    return None


def parse_llm_json(text):
    if not text:
        return None
    raw = text.strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass
    fence = re.search(r"```(?:json)?\s*(\{.*\})\s*```", raw, re.S)
    if fence:
        try:
            return json.loads(fence.group(1))
        except json.JSONDecodeError:
            pass
    candidate = extract_json_object(raw)
    if candidate:
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            return None
    return None


def to_int(value):
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        m = re.search(r"-?\d+", value)
        if m:
            return int(m.group(0))
    return None


def coerce_ac(raw):
    if raw is None:
        return None
    if isinstance(raw, dict):
        val = to_int(raw.get("value"))
        if val is None:
            return None
        return {"value": val, "detail": norm_name(raw.get("detail") or "")}
    if isinstance(raw, (int, float)):
        return {"value": int(raw), "detail": ""}
    if isinstance(raw, str):
        return parse_ac([f"Armor Class {raw}"])
    return None


def coerce_hp(raw):
    if raw is None:
        return None
    if isinstance(raw, dict):
        val = to_int(raw.get("value"))
        if val is None:
            return None
        return {"value": val, "formula": norm_name(raw.get("formula") or "")}
    if isinstance(raw, (int, float)):
        return {"value": int(raw), "formula": ""}
    if isinstance(raw, str):
        return parse_hp([f"Hit Points {raw}"])
    return None


def coerce_speed(raw):
    if raw is None:
        return None
    if isinstance(raw, dict):
        out = {}
        for key, val in raw.items():
            v = to_int(val)
            if v is None:
                continue
            out[str(key).lower()] = v
        return out or None
    if isinstance(raw, str):
        line = raw if re.search(r"\bSpeed\b", raw, re.I) else f"Speed {raw}"
        return parse_speed([line])
    return None


def coerce_abilities(raw):
    if raw is None:
        return None
    if isinstance(raw, dict):
        out = {}
        for key in ["str", "dex", "con", "int", "wis", "cha"]:
            if key in raw:
                val = to_int(raw.get(key))
                if val is not None:
                    out[key] = val
        return out or None
    if isinstance(raw, str):
        nums = [int(m.group(1)) for m in re.finditer(r"\b(\d{1,2})\b", raw)]
        if len(nums) >= 6:
            return {"str": nums[0], "dex": nums[1], "con": nums[2], "int": nums[3], "wis": nums[4], "cha": nums[5]}
    return None


def has_required_creature_stats(ac, hp, speed, abilities):
    if not isinstance(ac, dict) or ac.get("value") is None:
        return False
    if not isinstance(hp, dict) or hp.get("value") is None:
        return False
    if not isinstance(speed, dict) or not speed:
        return False
    if not isinstance(abilities, dict):
        return False
    for key in ["str", "dex", "con", "int", "wis", "cha"]:
        if abilities.get(key) is None:
            return False
    return True


def coerce_trait_raw(raw):
    if raw is None:
        return ""
    if isinstance(raw, dict):
        parts = []
        values = raw.get("value")
        custom = raw.get("custom")
        if isinstance(values, list):
            parts.extend([str(v).strip() for v in values if str(v).strip()])
        elif isinstance(values, str) and values.strip():
            parts.append(values.strip())
        if isinstance(custom, str) and custom.strip():
            parts.append(custom.strip())
        return ", ".join(parts)
    if isinstance(raw, list):
        parts = [str(v).strip() for v in raw if str(v).strip()]
        return ", ".join(parts)
    return str(raw)


def normalize_block_entry(entry):
    if isinstance(entry, dict):
        name = entry.get("name") or ""
        meta = entry.get("meta") or ""
        text = entry.get("text") or ""
    elif isinstance(entry, str):
        raw = norm_name(entry)
        m = re.match(r"^(.+?)(?:\s*\(([^)]+)\))?\.\s*(.*)$", raw)
        if not m:
            return None
        name = m.group(1)
        meta = m.group(2) or ""
        text = m.group(3) or ""
    else:
        return None

    name = clean_block_name(norm_name(name))
    if not name:
        return None
    return {
        "name": name,
        "meta": norm_name(meta),
        "text": norm_name(text),
    }


def normalize_block_list(raw):
    if not raw:
        return []
    blocks = []
    if isinstance(raw, list):
        for entry in raw:
            block = normalize_block_entry(entry)
            if block:
                blocks.append(block)
    elif isinstance(raw, dict):
        block = normalize_block_entry(raw)
        if block:
            blocks.append(block)
    elif isinstance(raw, str):
        block = normalize_block_entry(raw)
        if block:
            blocks.append(block)
    return blocks


def build_creature_from_llm(data, page_number):
    name = norm_name(data.get("name") or "")
    if not name:
        return None

    ac = coerce_ac(data.get("ac") or data.get("armor_class"))
    hp = coerce_hp(data.get("hp") or data.get("hit_points"))
    speed = coerce_speed(data.get("speed"))
    abilities = coerce_abilities(data.get("abilities"))

    if not has_required_creature_stats(ac, hp, speed, abilities):
        return None

    raw_dr = coerce_trait_raw(data.get("damage_resistances") or data.get("dr"))
    raw_di = coerce_trait_raw(data.get("damage_immunities") or data.get("di"))
    raw_dv = coerce_trait_raw(data.get("damage_vulnerabilities") or data.get("dv"))
    raw_ci = coerce_trait_raw(data.get("condition_immunities") or data.get("ci"))

    features = normalize_block_list(data.get("features"))
    actions = normalize_block_list(data.get("actions"))
    reactions = normalize_block_list(data.get("reactions"))
    legendary = normalize_block_list(data.get("legendary"))

    creature = {
        "kind": "creature",
        "page": page_number,
        "name": name,
        "ac": ac,
        "hp": hp,
        "speed": speed,
        "abilities": abilities,
        "traits": {
            "dr": map_damage_list(raw_dr),
            "di": map_damage_list(raw_di),
            "dv": map_damage_list(raw_dv),
            "ci": map_condition_list(raw_ci),
        },
        "features": features,
        "actions": actions,
        "reactions": reactions,
        "legendary": legendary,
    }
    challenge = parse_challenge_text(coerce_trait_raw(data.get("challenge") or data.get("cr")))
    prof = parse_proficiency_bonus_text(coerce_trait_raw(data.get("proficiency_bonus")))
    if challenge:
        creature["cr"] = challenge["cr"]
        creature["xp"] = challenge["xp"]
        prof = prof if prof is not None else challenge["prof"]
    creature["prof"] = prof
    creature["senses"] = parse_senses_text(coerce_trait_raw(data.get("senses")))
    creature["languages"] = parse_languages_text(coerce_trait_raw(data.get("languages")))
    creature["saves"] = parse_saving_throws_text(coerce_trait_raw(data.get("saving_throws")))
    creature["skills"] = parse_skills_text(coerce_trait_raw(data.get("skills")), abilities, prof, creature.get("cr"))
    return creature


def build_magic_item_from_llm(data, page_number):
    name = norm_name(data.get("name") or "")
    if not name:
        return None
    type_line = norm_name(data.get("typeLine") or data.get("type_line") or data.get("type") or "")
    body = norm_name(data.get("body") or "")
    if not type_line and not body:
        return None
    return {"kind": "magicItem", "page": page_number, "name": name, "typeLine": type_line, "body": body}


def parse_page_with_llm(lines, page_number, llm_config):
    prompt = build_llm_prompt(lines)
    messages = [
        {"role": "system", "content": "You extract structured data and return strict JSON only."},
        {"role": "user", "content": prompt},
    ]
    logging.info("LLM page %s: request start", page_number)
    started = time.time()
    try:
        response = call_llm(messages, llm_config)
    except (OSError, json.JSONDecodeError) as exc:  # URLError and socket timeouts are OSErrors
        logging.warning("LLM request failed on page %s: %s", page_number, exc)
        return None
    elapsed = time.time() - started
    logging.info("LLM page %s: response in %.2fs", page_number, elapsed)

    data = parse_llm_json(response)
    if not isinstance(data, dict):
        logging.warning("LLM returned non-JSON on page %s", page_number)
        logging.debug("LLM page %s raw response: %s", page_number, response)
        return None

    raw_kind = str(data.get("kind") or "").strip().lower()
    kind_key = re.sub(r"[^a-z]", "", raw_kind)
    if kind_key in {"none", ""}:
        logging.info("LLM page %s: kind=none", page_number)
        return None
    if kind_key in {"creature", "monster", "npc"}:
        logging.info("LLM page %s: kind=creature", page_number)
        creature = build_creature_from_llm(data, page_number)
        if not creature:
            logging.info("LLM page %s: ignored (missing stat block)", page_number)
        return creature
    if kind_key in {"magicitem", "item", "wondrousitem"}:
        logging.info("LLM page %s: kind=magicItem", page_number)
        return build_magic_item_from_llm(data, page_number)
    return None


def labelled_value(lines, label, max_lines=3):
    """Value of a stat block line: the rest of the line after the label or, when the label is alone on its line
    (two-column layouts), the following lines until the next label (at most max_lines). None if the label is absent."""
    idx = next((i for i, l in enumerate(lines) if re.match(rf"^{re.escape(label)}\b", l, re.I)), -1)
    if idx < 0:
        return None
    rest = re.sub(rf"^{re.escape(label)}\s*", "", lines[idx], flags=re.I)
    rest = re.sub(r"^Proficiency Bonus\s*", "", rest, flags=re.I)  # "Challenge Proficiency Bonus" header
    if rest.strip() and not STAT_LABEL_RE.match(rest):
        return rest.strip()
    parts = []
    for line in lines[idx + 1:idx + 1 + max_lines]:
        if STAT_LABEL_RE.match(line) or ABILITY_ROW_RE.search(line):
            break
        parts.append(line)
    return norm_name(" ".join(parts)) or None


def parse_hp(lines):
    raw = labelled_value(lines, "Hit Points", max_lines=1)
    m = re.match(r"(\d+)\s*(?:\(([^)]+)\))?", raw or "")
    if not m:
        return None
    return {"value": int(m.group(1)), "formula": norm_name(m.group(2) or "")}


def parse_ac(lines):
    raw = labelled_value(lines, "Armor Class", max_lines=1)
    m = re.match(r"(\d+)(?:\s*\(([^)]+)\))?", raw or "")
    if not m:
        return None
    return {"value": int(m.group(1)), "detail": norm_name(m.group(2) or "")}


def parse_speed(lines):
    s = labelled_value(lines, "Speed", max_lines=1)
    if not s:
        return None
    parts = [p.strip() for p in s.split(",")]
    move = {}
    for p in parts:
        m = re.match(r"^(walk|fly|swim|climb|burrow)?\s*(\d+)\s*ft", p, re.I)
        if m:
            mode = (m.group(1) or "walk").lower()
            move[mode] = int(m.group(2))
    return move


def parse_abilities(lines):
    idx = next((i for i, l in enumerate(lines)
                if re.search(r"\bSTR\b.*\bDEX\b.*\bCON\b.*\bINT\b.*\bWIS\b.*\bCHA\b", l, re.I)), -1)
    if idx < 0:
        return None
    v_line = lines[idx + 1] if idx + 1 < len(lines) else ""
    v_line = re.sub(r"\([^)]*\)", " ", v_line)  # "20 (+5) 15 (+2)": scores only, not the modifiers
    nums = [int(m.group(1)) for m in re.finditer(r"\b(\d{1,2})\b", v_line)]
    nums = nums[:6]
    if len(nums) < 6:
        return None
    return {"str": nums[0], "dex": nums[1], "con": nums[2], "int": nums[3], "wis": nums[4], "cha": nums[5]}


def parse_trait_csv_line(lines, label):
    return labelled_value(lines, label)


def split_csvish(value):
    if not value:
        return []
    return [x.strip() for x in value.replace(";", ",").split(",") if x.strip()]


def parse_cr_value(raw):
    """'18', '1/2', '½', '0.25' -> number (dnd5e system.details.cr), None otherwise."""
    s = norm_name(raw).replace(" ", "")
    if s in CR_FRACTIONS:
        return CR_FRACTIONS[s]
    m = re.match(r"^(\d+)/(\d+)$", s)
    if m and int(m.group(2)):
        return int(m.group(1)) / int(m.group(2))
    try:
        value = float(s)
    except ValueError:
        return None
    return int(value) if value.is_integer() else value


def parse_challenge_text(raw):
    """'18 (20,000 XP) +6' -> {"cr": 18, "xp": 20000, "prof": 6}. XP and the proficiency bonus are optional."""
    if not raw:
        return None
    m = re.match(rf"^(?:Challenge\s*(?:Rating)?\s*:?\s*)?{CR_VALUE_RE}(?:\s*\(\s*([\d,.\s]+?)\s*XP\s*\))?(?:\s*\+\s*(\d+))?",
                 norm_name(raw), re.I)
    if not m:
        return None
    cr = parse_cr_value(m.group(1))
    if cr is None:
        return None
    xp = to_int(re.sub(r"[^\d]", "", m.group(2) or "")) if m.group(2) else None
    prof = int(m.group(3)) if m.group(3) else None
    return {"cr": cr, "xp": xp, "prof": prof}


def parse_proficiency_bonus_text(raw):
    m = re.search(r"\+\s*(\d+)", raw or "")
    return int(m.group(1)) if m else None


def proficiency_from_cr(cr):
    """dnd5e: Proficiency.calculateMod(max(cr, 1))."""
    if cr is None:
        return None
    return int((max(float(cr), 1) + 7) // 4)


def parse_senses_text(raw):
    """'darkvision 120 ft., passive Perception 13' -> system.attributes.senses (dnd5e 6: ranges, units, special)."""
    if raw is None:
        return None
    ranges = {}
    special = []
    for part in split_csvish(raw):
        m = re.match(rf"^({'|'.join(SENSE_TYPES)})\s+(\d+)\s*(?:ft\.?|feet|m\.?)?\s*(.*)$", part, re.I)
        if m:
            ranges[m.group(1).lower()] = int(m.group(2))
            if m.group(3).strip():
                special.append(f"{m.group(1).lower()} {m.group(3).strip()}")
        elif not re.match(r"^passive\s+perception\b", part, re.I):
            special.append(part)
    if not ranges and not special:
        return None
    return {"ranges": ranges, "units": "ft", "special": "; ".join(special)}


def parse_languages_text(raw):
    """'Common, Abyssal, telepathy 60 ft.' -> system.traits.languages (value keys, custom text, communication)."""
    if raw is None:
        return None
    value, custom, communication = [], [], {}
    for part in split_csvish(raw):
        low = part.lower().strip(" .")
        if low in {"", "-", "—", "–", "none"}:
            continue
        if low == "all":
            value.append("ALL")
            continue
        m = re.match(r"^telepathy\s+(\d+)\s*(?:ft\.?|feet|m\.?)?", low)
        if m:
            communication["telepathy"] = {"value": int(m.group(1)), "units": "ft"}
            continue
        key = next((k for name, k in LANGUAGE_KEYS.items() if low == name), None)
        if key:
            value.append(key)
        else:
            custom.append(part.strip(" ."))
    if not value and not custom and not communication:
        return None
    return {"value": sorted(set(value)), "custom": "; ".join(custom), "communication": communication}


def parse_saving_throws_text(raw):
    """'Str +11, Wis +9' -> {"str": 11, "wis": 9}."""
    if not raw:
        return None
    out = {}
    for m in re.finditer(r"\b([A-Za-z]+)\s*([+-]\s*\d+)", raw):
        key = normalize_ability_key(m.group(1))
        if key:
            out[key] = int(m.group(2).replace(" ", ""))
    return out or None


def parse_skills_text(raw, abilities=None, prof=None, cr=None):
    """'Athletics +11, Perception +4' -> {"ath": 2, "prc": 1}: proficiency level (2 = expertise when the bonus
    equals the ability modifier plus twice the proficiency bonus)."""
    if not raw:
        return None
    prof = prof if prof is not None else proficiency_from_cr(cr)
    out = {}
    for m in re.finditer(r"([A-Za-z][A-Za-z ]*?)\s*([+-]\s*\d+)", raw):
        key = SKILL_KEYS.get(m.group(1).strip().lower())
        if not key:
            continue
        level = 1
        bonus = int(m.group(2).replace(" ", ""))
        score = (abilities or {}).get(SKILL_ABILITIES[key])
        if prof and score is not None and bonus >= ability_mod_from_score(score) + 2 * prof:
            level = 2
        out[key] = level
    return out or None


def challenge_line(lines):
    """'Challenge 5 (1,800 XP)' on one line, or the first '5 (1,800 XP) +3' line among the three after the label
    (two-column layouts interleave lines of the other column)."""
    idx = next((i for i, l in enumerate(lines) if re.match(r"^Challenge\b", l, re.I)), -1)
    if idx < 0:
        return None
    rest = re.sub(r"^Challenge\s*(Rating)?\s*:?\s*(Proficiency Bonus)?\s*", "", lines[idx], flags=re.I)
    if re.match(rf"^{CR_VALUE_RE}\s*(\(|\+|$)", rest):
        return rest
    return next((l for l in lines[idx + 1:idx + 4] if re.match(rf"^{CR_VALUE_RE}\s*(\(|\+|$)", l)), None)


def parse_stat_lines(lines):
    """Deterministic read of the stat lines of a page (challenge, senses, languages, saves, skills, traits)."""
    challenge = parse_challenge_text(challenge_line(lines))
    prof = parse_proficiency_bonus_text(labelled_value(lines, "Proficiency Bonus", max_lines=1))
    if prof is None and challenge:
        prof = challenge["prof"]
    stats = {
        "cr": challenge["cr"] if challenge else None,
        "xp": challenge["xp"] if challenge else None,
        "prof": prof,
        "senses": parse_senses_text(labelled_value(lines, "Senses")),
        "languages": parse_languages_text(labelled_value(lines, "Languages")),
        "saves": parse_saving_throws_text(labelled_value(lines, "Saving Throws")),
        "skills_raw": labelled_value(lines, "Skills"),
        "traits": {},
    }
    for key, label, mapper in [("dr", "Damage Resistances", map_damage_list), ("di", "Damage Immunities", map_damage_list),
                               ("dv", "Damage Vulnerabilities", map_damage_list), ("ci", "Condition Immunities", map_condition_list)]:
        raw = labelled_value(lines, label)
        if raw is not None:
            stats["traits"][key] = mapper(raw)
    return stats


def apply_stat_lines(creature, lines):
    """Completes a creature (regex or LLM) with the stat lines read from the page. The lines win over the LLM
    for what they state (the LLM shifts the trait lists); what they do not state is left as it is."""
    stats = parse_stat_lines(lines)
    if stats["cr"] is not None:
        creature["cr"] = stats["cr"]
        creature["xp"] = stats["xp"]
    if stats["prof"] is not None:
        creature["prof"] = stats["prof"]
    for key in ("senses", "languages", "saves"):
        if stats[key]:
            creature[key] = stats[key]
    skills = parse_skills_text(stats["skills_raw"], creature.get("abilities"), creature.get("prof"), creature.get("cr"))
    if skills:
        creature["skills"] = skills
    if stats["traits"]:
        traits = creature.setdefault("traits", {})
        for key in ("dr", "di", "dv", "ci"):
            traits[key] = stats["traits"].get(key) or {"value": [], "custom": ""}
    return creature


def map_damage_list(raw):
    out = {"value": [], "custom": ""}
    for p in split_csvish(raw):
        low = p.lower()
        hit = next((dt for dt in DAMAGE_TYPES if dt in low), None)
        if hit:
            out["value"].append(hit)
        else:
            out["custom"] += ("; " if out["custom"] else "") + p
    out["value"] = sorted(set(out["value"]))
    return out


def map_condition_list(raw):
    out = {"value": [], "custom": ""}
    for p in split_csvish(raw):
        low = p.lower()
        hit = next((ct for ct in CONDITION_TYPES if ct in low), None)
        if hit:
            out["value"].append(hit)
        else:
            out["custom"] += ("; " if out["custom"] else "") + p
    out["value"] = sorted(set(out["value"]))
    return out


def clean_block_name(name):
    raw = norm_name(name)
    if not raw:
        return raw
    stripped = raw
    stripped = re.sub(r"^Action(?=[A-Z])", "", stripped)
    stripped = re.sub(r"^Reaction(?=[A-Z])", "", stripped)
    stripped = re.sub(r"^LegendaryActions?(?=[A-Z])", "", stripped)
    stripped = re.sub(r"^Action\s+", "", stripped, flags=re.I)
    stripped = re.sub(r"^Reaction\s+", "", stripped, flags=re.I)
    stripped = re.sub(r"^Legendary Actions?\s+", "", stripped, flags=re.I)
    return norm_name(stripped or raw)


def is_sentence_like_name(name):
    s = norm_name(name)
    if not s:
        return False
    words = s.split()
    if re.match(r"^(The|A|An|Each|Any|If|When|While|On|At|In|After|Before|During|Until|Once)\b", s, re.I) and len(words) > 2:
        return True
    if len(words) > 6:
        return True
    if re.search(r"\b(is|are|was|were|be|becomes|become|make|makes|made|hurl|hurls|cast|casts|take|takes|gain|gains|must|can)\b", s, re.I):
        return True
    return False


def parse_named_blocks(section_lines):
    blocks = []
    cur = None
    for line in section_lines:
        m = re.match(r"^(.+?)(?:\s*\(([^)]+)\))?\.\s*(.*)$", line)
        raw_name = norm_name(m.group(1)) if m else ""
        body_text = norm_name(m.group(3)) if m else ""
        name = clean_block_name(raw_name)
        looks_like = bool(m) and name and len(name) <= 80 and re.match(r"^[A-Z]", name) \
            and not re.match(r"^(Armor Class|Hit Points|Speed|STR|DEX|CON|INT|WIS|CHA|Damage |Condition |Senses |Languages |Challenge |Proficiency Bonus)", name, re.I) \
            and not is_sentence_like_name(name)
        if looks_like:
            if cur:
                blocks.append(cur)
            cur = {"name": name, "meta": norm_name(m.group(2) or ""), "text": body_text}
        elif cur:
            cur["text"] = norm_name((cur["text"] + " " if cur["text"] else "") + line)
    if cur:
        blocks.append(cur)
    return blocks

def parse_damage_parts_from_text(text):
    parts = []
    seen = set()

    def push_part(formula, dtype):
        cleaned = norm_name(formula)
        low = str(dtype or "").lower()
        if not cleaned or not low:
            return
        if DAMAGE_TYPES and low not in DAMAGE_TYPES:
            return
        key = f"{cleaned.lower()}::{low}"
        if key in seen:
            return
        seen.add(key)
        parts.append({"formula": cleaned, "dtype": low})

    for dm in re.finditer(r"\(([^)]+)\)\s*([a-z]+)\s*damage", text, re.I):
        push_part(dm.group(1), dm.group(2))

    for dm in re.finditer(r"\b(\d+d\d+(?:\s*[+\-]\s*\d+)?)\s*([a-z]+)\s*damage", text, re.I):
        push_part(dm.group(1), dm.group(2))

    return parts


def extract_versatile_part(text, parts):
    m = re.search(r"\(([^)]+)\)\s*([a-z]+)\s*damage\s*if used with two hands", text, re.I)
    if not m:
        return {"versatile": None, "parts": parts}
    formula = norm_name(m.group(1))
    dtype = m.group(2).lower()
    fkey = norm_name(formula).lower()
    cleaned = [p for p in parts if not (norm_name(p["formula"]).lower() == fkey and p["dtype"] == dtype)]
    return {"versatile": {"formula": formula, "dtype": dtype}, "parts": cleaned}


def parse_attack_range_info(text):
    if not text:
        return None
    out = {"units": "ft"}
    reach = re.search(r"reach\s+(\d+)\s*(?:ft|feet)\.?", text, re.I)
    if reach:
        out["reach"] = int(reach.group(1))
    rng = re.search(r"range\s+(\d+)(?:\s*\/\s*(\d+))?\s*(?:ft|feet)\.?", text, re.I)
    if rng:
        out["value"] = int(rng.group(1))
        if rng.group(2):
            out["long"] = int(rng.group(2))
    return out if (reach or rng) else None


def parse_target_from_text(text):
    if not text:
        return None
    num_words = {
        "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
        "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10
    }
    m = re.search(r"\b(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\b\s+(creature|target|object|enemy|ally)s?", text, re.I)
    if not m:
        return None
    raw_count = m.group(1).lower()
    if raw_count.isdigit():
        count = int(raw_count)
    else:
        count = num_words.get(raw_count)
    if count is None:
        return None
    raw_type = m.group(2).lower()
    ttype = "object" if raw_type == "object" else "creature"
    return {"count": count, "type": ttype} if isinstance(count, int) else None


def parse_area_from_text(text):
    if not text:
        return None
    m = re.search(r"(\d+)\s*[- ]?foot(?:[- ]radius)?\s*(sphere|cone|cube|line|cylinder)", text, re.I)
    if not m:
        return None
    size = int(m.group(1))
    atype = m.group(2).lower()
    width = re.search(r"(\d+)\s*[- ]?foot\s*[- ]?wide", text, re.I)
    height = re.search(r"(\d+)\s*[- ]?foot\s*[- ]?high", text, re.I)
    return {
        "size": size,
        "type": atype,
        "units": "ft",
        "width": int(width.group(1)) if width else None,
        "height": int(height.group(1)) if height else None
    }


def normalize_ability_key(raw):
    s = str(raw or "").lower()
    if s.startswith("str"):
        return "str"
    if s.startswith("dex"):
        return "dex"
    if s.startswith("con"):
        return "con"
    if s.startswith("int"):
        return "int"
    if s.startswith("wis"):
        return "wis"
    if s.startswith("cha"):
        return "cha"
    return ""


def parse_save_from_text(text):
    m = re.search(r"\bDC\s*(\d+)\s*([A-Za-z]+)\s*saving throw", text, re.I)
    if not m:
        return None
    dc = int(m.group(1))
    ability = normalize_ability_key(m.group(2))
    parts = parse_damage_parts_from_text(text)
    low = text.lower()
    on_save = "half"
    if "no damage" in low or "no effect" in low:
        on_save = "none"
    elif "half as much" in low or "half the damage" in low or "half damage" in low:
        on_save = "half"
    r = re.search(r"within\s+(\d+)\s*(?:ft|feet)\.?", text, re.I)
    if r:
        range_info = {"value": int(r.group(1)), "units": "ft"}
    else:
        r2 = re.search(r"range\s+(\d+)\s*(?:ft|feet)\.?", text, re.I)
        range_info = {"value": int(r2.group(1)), "units": "ft"} if r2 else None
    area = parse_area_from_text(text)
    target = parse_target_from_text(text)
    return {"dc": dc, "ability": ability, "parts": parts, "onSave": on_save, "range": range_info, "area": area, "target": target}


def parse_attack_from_text(text):
    cleaned = norm_name(text)
    cleaned = cleaned.replace("\u2212", "-").replace("\u2013", "-").replace("\u2014", "-").replace("\uFF0B", "+")
    attack_start = re.search(r"\b(Melee|Ranged|Melee or Ranged)\s+(Weapon|Spell)\s+Attack:", cleaned, re.I)
    if not attack_start:
        return None
    slice_text = cleaned[attack_start.start():]
    m = re.match(r"^(Melee|Ranged|Melee or Ranged)\s+(Weapon|Spell)\s+Attack:\s*([+\-]?\s*\d+)\s*to hit,?\s*(.+?)(?:[.,\s]+Hit:\s*(.+))?$", slice_text, re.I)
    if not m:
        return None
    mode_raw = m.group(1).lower()
    mode = "melee" if ("melee" in mode_raw and "ranged" in mode_raw) else mode_raw
    kind = m.group(2).lower()
    to_hit = int(re.sub(r"\s+", "", m.group(3)))
    range_text = re.sub(r"[.\s]+$", "", norm_name(m.group(4)))
    hit_text = norm_name(m.group(5) or "")
    damage_text = hit_text or range_text
    range_info = parse_attack_range_info(range_text)
    target = parse_target_from_text(range_text)
    parsed_parts = parse_damage_parts_from_text(damage_text)
    versatile_data = extract_versatile_part(damage_text, parsed_parts)

    action_type = ""
    if mode == "melee" and kind == "weapon":
        action_type = "mwak"
    elif mode == "ranged" and kind == "weapon":
        action_type = "rwak"
    elif mode == "melee" and kind == "spell":
        action_type = "msak"
    elif mode == "ranged" and kind == "spell":
        action_type = "rsak"

    return {
        "actionType": action_type,
        "toHit": to_hit,
        "parts": versatile_data["parts"],
        "versatile": versatile_data["versatile"],
        "range": range_info,
        "target": target
    }


def get_attack_mode_from_action_type(action_type):
    value = "ranged" if action_type and action_type.startswith("r") else "melee"
    classification = "spell" if action_type and action_type.endswith("sak") else "weapon"
    return {"value": value, "classification": classification}


def get_attack_ability_from_action_type(action_type):
    if not action_type:
        return ""
    if action_type.endswith("sak"):
        return "spellcasting"
    return "dex" if action_type.startswith("r") else "str"


def get_activation_type_from_section(section_label):
    low = str(section_label or "").lower()
    if "legendary" in low:
        return "legendary"
    if "reaction" in low:
        return "reaction"
    if "bonus" in low:
        return "bonus"
    return "action"


def ability_mod_from_score(score):
    if score is None:
        return None
    return (int(score) - 10) // 2


def is_numeric_bonus(value):
    return isinstance(value, str) and re.match(r"^-?\d+(\.\d+)?$", value.strip())


def build_damage_part(formula, dtype):
    data = {
        "number": None,
        "denomination": None,
        "bonus": "",
        "types": [dtype] if dtype else [],
        "custom": {"enabled": False, "formula": ""},
        "scaling": {"mode": "", "number": None, "formula": ""}
    }
    m = re.match(r"^\s*(\d+)d(\d+)(?:\s*([+|-])\s*(\d+))?\s*$", formula or "", re.I)
    if m:
        data["number"] = int(m.group(1))
        data["denomination"] = int(m.group(2))
        if m.group(4):
            data["bonus"] = f"-{m.group(4)}" if m.group(3) == "-" else m.group(4)
    elif formula:
        data["custom"]["enabled"] = True
        data["custom"]["formula"] = formula
    return data


def pick_area_target_type(raw_type):
    key = str(raw_type or "").lower()
    return key


def build_activity_target(area, single_target):
    if area:
        return {
            "template": {
                "count": "",
                "contiguous": False,
                "type": pick_area_target_type(area.get("type")),
                "size": str(area.get("size")) if area.get("size") is not None else "",
                "width": str(area.get("width")) if area.get("width") is not None else "",
                "height": str(area.get("height")) if area.get("height") is not None else "",
                "units": area.get("units") or "ft"
            },
            "affects": {"count": "", "type": "", "choice": False, "special": ""},
            "prompt": True
        }
    if single_target:
        return {
            "template": {
                "count": "",
                "contiguous": False,
                "type": "",
                "size": "",
                "width": "",
                "height": "",
                "units": "ft"
            },
            "affects": {
                "count": str(single_target.get("count") or ""),
                "type": single_target.get("type") or "creature",
                "choice": False,
                "special": ""
            },
            "prompt": True
        }
    return None

def apply_parsed_attack_to_weapon_item(item_data, creature, parsed_attack, section_label, activity_name):
    mode = get_attack_mode_from_action_type(parsed_attack.get("actionType"))
    ability = get_attack_ability_from_action_type(parsed_attack.get("actionType"))
    activation_type = get_activation_type_from_section(section_label)
    parts = [p for p in (parsed_attack.get("parts") or []) if p.get("formula") and p.get("dtype")]
    is_spell_attack = mode["classification"] == "spell"
    base_part = None if is_spell_attack else (parts[0] if parts else None)
    extra_parts = parts if is_spell_attack else parts[1:]

    item_data.setdefault("system", {})
    item_data["system"].setdefault("damage", {})
    if base_part:
        base_damage = build_damage_part(base_part["formula"], base_part["dtype"])
        if mode["classification"] == "weapon" and not base_damage["custom"]["enabled"]:
            abilities = creature.get("abilities") or {}
            mod = ability_mod_from_score(abilities.get(ability))
            if mod is not None and is_numeric_bonus(base_damage["bonus"]):
                extra = int(base_damage["bonus"]) - mod
                base_damage["bonus"] = str(extra) if extra else ""
        item_data["system"]["damage"]["base"] = base_damage

    if parsed_attack.get("versatile"):
        vers = parsed_attack["versatile"]
        versatile_damage = build_damage_part(vers["formula"], vers["dtype"])
        if mode["classification"] == "weapon" and not versatile_damage["custom"]["enabled"]:
            abilities = creature.get("abilities") or {}
            mod = ability_mod_from_score(abilities.get(ability))
            if mod is not None and is_numeric_bonus(versatile_damage["bonus"]):
                extra = int(versatile_damage["bonus"]) - mod
                versatile_damage["bonus"] = str(extra) if extra else ""
        item_data["system"]["damage"]["versatile"] = versatile_damage
        props = set(item_data["system"].get("properties") or [])
        props.add("ver")
        item_data["system"]["properties"] = sorted(props)

    if parsed_attack.get("range"):
        item_data["system"].setdefault("range", {})
        r = parsed_attack["range"]
        if r.get("reach") is not None:
            item_data["system"]["range"]["reach"] = r["reach"]
        if r.get("value") is not None:
            item_data["system"]["range"]["value"] = r["value"]
        if r.get("long") is not None:
            item_data["system"]["range"]["long"] = r["long"]
        if r.get("units"):
            item_data["system"]["range"]["units"] = r["units"]

    activity_id = random_id()
    target = build_activity_target(None, parsed_attack.get("target"))
    item_data["system"]["activities"] = {
        activity_id: {
            "_id": activity_id,
            "type": "attack",
            "name": activity_name or item_data.get("name") or "Attack",
            "activation": {"type": activation_type, "value": 1, "condition": ""},
            "attack": {
                "ability": ability,
                "bonus": str(parsed_attack.get("toHit") or ""),
                "flat": parsed_attack.get("toHit") is not None,
                "type": {"value": mode["value"], "classification": mode["classification"]}
            },
            "damage": {
                "includeBase": bool(base_part),
                "parts": [build_damage_part(p["formula"], p["dtype"]) for p in extra_parts]
            },
            **({"target": target} if target else {})
        }
    }


def apply_save_activity_to_feat(item_data, save_data, section_label, name):
    activity_id = random_id()
    activation_type = get_activation_type_from_section(section_label)
    target = build_activity_target(save_data.get("area"), save_data.get("target"))
    activity = {
        "_id": activity_id,
        "type": "save",
        "name": name or "Save",
        "activation": {"type": activation_type, "value": 1, "condition": ""},
        "save": {
            "ability": [save_data.get("ability") or "dex"],
            "dc": {"calculation": "", "formula": str(save_data.get("dc") or "")}
        },
        "damage": {
            "onSave": save_data.get("onSave") or "half",
            "parts": [build_damage_part(p["formula"], p["dtype"]) for p in (save_data.get("parts") or [])]
        }
    }
    if save_data.get("range"):
        activity["range"] = {
            "value": str(save_data["range"].get("value") or ""),
            "units": save_data["range"].get("units") or "ft",
            "special": ""
        }
    if target:
        activity["target"] = target
    item_data.setdefault("system", {})
    item_data["system"]["activities"] = {activity_id: activity}


def apply_utility_activity_to_feat(item_data, section_label, name):
    activity_id = random_id()
    activation_type = get_activation_type_from_section(section_label)
    item_data.setdefault("system", {})
    item_data["system"]["activities"] = {
        activity_id: {
            "_id": activity_id,
            "type": "utility",
            "name": name or "Utility",
            "activation": {"type": activation_type, "value": 1, "condition": ""},
            "roll": {"formula": "", "name": "", "prompt": False, "visible": False}
        }
    }


def make_item_data(name, itype):
    return {"_id": random_id(), "name": name, "type": itype, "system": {}}


def make_actor_data(name, atype="npc"):
    return {"_id": random_id(), "name": name, "type": atype, "system": {}, "items": []}


def parse_creature_from_lines(lines, page_number):
    idx_ac = next((i for i, l in enumerate(lines) if re.match(r"^Armor Class\b", l, re.I)), -1)
    idx_hp = next((i for i, l in enumerate(lines) if re.match(r"^Hit Points\b", l, re.I)), -1)
    idx_speed = next((i for i, l in enumerate(lines) if re.match(r"^Speed\b", l, re.I)), -1)
    if idx_ac < 0 or idx_hp < 0 or idx_speed < 0:
        return None

    idx_size = next((i for i, l in enumerate(lines)
                     if re.match(r"^(Tiny|Small|Medium|Large|Huge|Gargantuan)\b", l, re.I) and "," in l), -1)
    if idx_size > 0:
        name = norm_name(lines[idx_size - 1])
    else:
        before = [l for l in lines[:idx_ac] if l and not re.match(r"^Proficiency Bonus\b", l, re.I)]
        name = norm_name(before[-1] if before else "Unknown Creature")
    if not name or re.match(r"^Hit Points\b", name, re.I):
        return None

    ac = parse_ac(lines)
    hp = parse_hp(lines)
    speed = parse_speed(lines)
    abilities = parse_abilities(lines)

    if not has_required_creature_stats(ac, hp, speed, abilities):
        return None

    raw_dr = parse_trait_csv_line(lines, "Damage Resistances")
    raw_di = parse_trait_csv_line(lines, "Damage Immunities")
    raw_dv = parse_trait_csv_line(lines, "Damage Vulnerabilities")
    raw_ci = parse_trait_csv_line(lines, "Condition Immunities")

    actions_idx = next((i for i, l in enumerate(lines) if re.match(r"^Actions\b", l, re.I)), -1)
    reactions_idx = next((i for i, l in enumerate(lines) if re.match(r"^Reactions\b", l, re.I)), -1)
    legendary_idx = next((i for i, l in enumerate(lines) if re.match(r"^Legendary Actions\b", l, re.I)), -1)

    end_stats_idx = max(
        next((i for i, l in enumerate(lines) if re.match(r"^Challenge\b", l, re.I)), -1),
        next((i for i, l in enumerate(lines) if re.match(r"^Languages\b", l, re.I)), -1),
        next((i for i, l in enumerate(lines) if re.match(r"^Senses\b", l, re.I)), -1)
    )
    traits_start = end_stats_idx + 1 if end_stats_idx >= 0 else idx_speed + 1
    # Label alone on its line (two-column layouts): the value "18 (20,000 XP) +6" is on the next line.
    if end_stats_idx >= 0 and traits_start < len(lines) and re.match(rf"^{CR_VALUE_RE}\s*(\(|\+|$)", lines[traits_start]):
        traits_start += 1
    traits_end = actions_idx if actions_idx >= 0 else len(lines)
    trait_lines = [l for l in lines[traits_start:traits_end] if l and not re.match(r"^\d{3,}$", l)]
    traits = parse_named_blocks(trait_lines)

    actions_end = reactions_idx if reactions_idx >= 0 else (legendary_idx if legendary_idx >= 0 else len(lines))
    action_lines = [l for l in lines[actions_idx + 1:actions_end] if l and not re.match(r"^\d{3,}$", l)] if actions_idx >= 0 else []
    actions = parse_named_blocks(action_lines)

    reaction_lines = [l for l in lines[reactions_idx + 1:(legendary_idx if legendary_idx >= 0 else len(lines))]
                      if l and not re.match(r"^\d{3,}$", l)] if reactions_idx >= 0 else []
    reactions = parse_named_blocks(reaction_lines)

    legendary_lines = [l for l in lines[legendary_idx + 1:] if l and not re.match(r"^\d{3,}$", l)] if legendary_idx >= 0 else []
    legendary = parse_named_blocks(legendary_lines)

    creature = {
        "kind": "creature",
        "page": page_number,
        "name": name,
        "ac": ac,
        "hp": hp,
        "speed": speed,
        "abilities": abilities,
        "traits": {
            "dr": map_damage_list(raw_dr),
            "di": map_damage_list(raw_di),
            "dv": map_damage_list(raw_dv),
            "ci": map_condition_list(raw_ci)
        },
        "features": traits,
        "actions": actions,
        "reactions": reactions,
        "legendary": legendary
    }
    return apply_stat_lines(creature, lines)


def parse_magic_item_from_lines(lines, page_number):
    idx_wi = next((i for i, l in enumerate(lines) if re.search(r"\bWondrous Item\b", l, re.I)), -1)
    if idx_wi < 0:
        return None
    title_parts = []
    for i in range(max(0, idx_wi - 3), idx_wi):
        s = norm_name(lines[i])
        if not s or re.match(r"^Proficiency Bonus\b", s, re.I) or re.match(r"^\d{3,}$", s):
            continue
        title_parts.append(s)
    title = norm_name(" ".join(title_parts[-2:]))
    if not title:
        return None
    type_line = norm_name(lines[idx_wi])
    body = norm_name("\n".join(lines[idx_wi + 1:]))
    return {"kind": "magicItem", "page": page_number, "name": title, "typeLine": type_line, "body": body}


def parse_spells_inside_text(text):
    spells = []
    for m in re.finditer(r"(^|\n)([A-Z][A-Za-z' \-]{2,60})\n(\d+(?:st|nd|rd|th)-level\s+[^\n]+)\n", text):
        spells.append({"name": norm_name(m.group(2)), "header": norm_name(m.group(3))})
    seen = set()
    out = []
    for s in spells:
        key = s["name"].lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(s)
    return out

def build_items_for_creature(creature):
    embedded = []
    created = []

    for feat in creature.get("features", []):
        base_name = feat["name"]
        item = make_item_data(base_name, "feat")
        item.setdefault("system", {})
        item["system"].setdefault("description", {})
        item["system"]["description"]["value"] = f"<p><strong>{feat['name']}{f' ({feat['meta']})' if feat.get('meta') else ''}.</strong> {feat['text']}</p>"
        created.append(item)

        emb = deepcopy(item)
        emb["name"] = base_name
        embedded.append(emb)

    def handle_action_block(block, section_label):
        base_name = block["name"]
        parsed_attack = parse_attack_from_text(block["text"])
        if parsed_attack and parsed_attack.get("actionType"):
            wpn = make_item_data(base_name, "weapon")
            wpn.setdefault("system", {})
            wpn["system"].setdefault("description", {})
            meta = f"<em>{block['meta']}</em><br/>" if block.get("meta") else ""
            wpn["system"]["description"]["value"] = f"<p>{meta}{block['text']}</p>"
            apply_parsed_attack_to_weapon_item(wpn, creature, parsed_attack, section_label, block["name"])
            created.append(wpn)

            emb = deepcopy(wpn)
            emb["name"] = base_name
            embedded.append(emb)
            return

        feat = make_item_data(base_name, "feat")
        feat.setdefault("system", {})
        feat["system"].setdefault("description", {})
        meta = f"{block['name']} ({block['meta']})" if block.get("meta") else block["name"]
        feat["system"]["description"]["value"] = f"<p><small>{section_label}</small><br/><strong>{meta}.</strong> {block['text']}</p>"
        parsed_save = parse_save_from_text(block["text"])
        if parsed_save:
            apply_save_activity_to_feat(feat, parsed_save, section_label, block["name"])
        else:
            apply_utility_activity_to_feat(feat, section_label, block["name"])
        created.append(feat)

        emb = deepcopy(feat)
        emb["name"] = base_name
        embedded.append(emb)

    for a in creature.get("actions", []):
        handle_action_block(a, "Action")
    for r in creature.get("reactions", []):
        handle_action_block(r, "Reaction")
    for l in creature.get("legendary", []):
        handle_action_block(l, "Legendary Action")

    return embedded, created


def build_items_for_magic_item(magic_item):
    created = []
    eq = make_item_data(magic_item["name"], "equipment")
    eq.setdefault("system", {})
    eq["system"].setdefault("description", {})
    eq["system"]["description"]["value"] = f"<p><em>{magic_item['typeLine']}</em></p>\n{magic_item['body']}"
    created.append(eq)

    for sp in parse_spells_inside_text(magic_item["body"]):
        spell = make_item_data(sp["name"], "spell")
        spell.setdefault("system", {})
        spell["system"].setdefault("description", {})
        spell["system"]["description"]["value"] = f"<p><strong>{sp['name']}</strong></p><p><em>{sp['header']}</em></p><p>(Full description in PDF)</p>"
        created.append(spell)
    return created


def build_actor(creature, embedded_items, pdf_name):
    actor = make_actor_data(creature["name"], "npc")
    actor["img"] = "icons/svg/mystery-man.svg"
    actor.setdefault("flags", {})
    actor["flags"]["pdf-importer"] = {"source": pdf_name, "page": creature["page"]}
    actor["items"] = embedded_items

    if creature.get("hp"):
        actor["system"].setdefault("attributes", {})
        actor["system"]["attributes"].setdefault("hp", {})
        actor["system"]["attributes"]["hp"]["value"] = creature["hp"]["value"]
        actor["system"]["attributes"]["hp"]["max"] = creature["hp"]["value"]
        if creature["hp"].get("formula"):
            actor["system"]["attributes"]["hp"]["formula"] = creature["hp"]["formula"]
    if creature.get("ac"):
        actor["system"].setdefault("attributes", {})
        actor["system"]["attributes"].setdefault("ac", {})
        actor["system"]["attributes"]["ac"]["value"] = creature["ac"]["value"]
    if creature.get("speed"):
        actor["system"].setdefault("attributes", {})
        actor["system"]["attributes"].setdefault("movement", {})
        for k, v in creature["speed"].items():
            actor["system"]["attributes"]["movement"][k] = v
    if creature.get("abilities"):
        actor["system"].setdefault("abilities", {})
        for ab, val in creature["abilities"].items():
            actor["system"]["abilities"].setdefault(ab, {})
            actor["system"]["abilities"][ab]["value"] = val
    if creature.get("traits"):
        actor["system"].setdefault("traits", {})
        for key, target in [("dr", "dr"), ("di", "di"), ("dv", "dv"), ("ci", "ci")]:
            if creature["traits"].get(key):
                actor["system"]["traits"].setdefault(target, {})
                actor["system"]["traits"][target]["value"] = creature["traits"][key]["value"]
                actor["system"]["traits"][target]["custom"] = creature["traits"][key]["custom"]
    # dnd5e 6.0.6: details.cr (number), attributes.senses.ranges, traits.languages, abilities.<x>.proficient,
    # skills.<x>.value. The proficiency bonus of an NPC is derived from the CR by the system (attributes.prof is not
    # stored), so the printed value only goes to the flag.
    if creature.get("cr") is not None:
        actor["system"].setdefault("details", {})["cr"] = creature["cr"]
    if creature.get("xp") is not None:
        actor["flags"]["pdf-importer"]["xp"] = creature["xp"]
    if creature.get("prof") is not None:
        actor["flags"]["pdf-importer"]["proficiencyBonus"] = creature["prof"]
    if creature.get("senses"):
        actor["system"].setdefault("attributes", {})["senses"] = deepcopy(creature["senses"])
    if creature.get("languages"):
        languages = deepcopy(creature["languages"])
        if not languages.get("communication"):
            languages.pop("communication", None)
        actor["system"].setdefault("traits", {})["languages"] = languages
    for ab in creature.get("saves") or {}:
        actor["system"].setdefault("abilities", {}).setdefault(ab, {})["proficient"] = 1
    for skill, level in (creature.get("skills") or {}).items():
        actor["system"].setdefault("skills", {})[skill] = {"value": level, "ability": SKILL_ABILITIES[skill]}
    return actor


def write_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def write_db(path, entries):
    with open(path, "w", encoding="utf-8") as f:
        for entry in entries:
            f.write(json.dumps(entry, ensure_ascii=False))
            f.write("\n")


def main():
    parser = argparse.ArgumentParser(description="Extract actors and items from a PDF.")
    parser.add_argument("--pdf", required=True, help="Path to PDF file.")
    parser.add_argument("--out-dir", default=".", help="Output directory.")
    parser.add_argument("--max-pages", type=int, default=0, help="Limit pages processed (0 = all).")
    parser.add_argument("--min-text", type=int, default=40, help="Skip pages with fewer chars.")
    parser.add_argument("--llm", action="store_true", help="Enable LLM parsing (local Llama via HTTP).")
    parser.add_argument("--llm-provider", choices=["ollama", "openai"], default=LLM_DEFAULT_PROVIDER,
                        help="LLM provider: ollama or openai compatible.")
    parser.add_argument("--llm-url", default="", help="LLM endpoint URL. Defaults by provider if empty.")
    parser.add_argument("--llm-model", default=LLM_DEFAULT_MODEL, help="LLM model name.")
    parser.add_argument("--llm-mode", choices=["fallback", "prefer", "only"], default="fallback",
                        help="LLM usage: fallback, prefer, or only.")
    parser.add_argument("--llm-timeout", type=int, default=60, help="LLM request timeout in seconds.")
    parser.add_argument("--llm-temperature", type=float, default=0.0, help="LLM sampling temperature.")
    parser.add_argument("--llm-api-key", default="", help="API key for openai-compatible endpoints.")
    parser.add_argument("--log-level", default="INFO", help="Logging level (DEBUG, INFO, WARNING, ERROR).")
    args = parser.parse_args()

    log_level = getattr(logging, args.log_level.upper(), logging.INFO)
    logging.basicConfig(level=log_level, format="%(levelname)s:%(message)s", force=True)

    pdf_path = args.pdf
    out_dir = args.out_dir
    os.makedirs(out_dir, exist_ok=True)

    llm_config = None
    if args.llm:
        provider = args.llm_provider
        llm_url = args.llm_url or LLM_DEFAULT_URLS.get(provider, "")
        if not llm_url:
            raise ValueError(f"No default URL for LLM provider: {provider}")
        api_key = args.llm_api_key or os.getenv("LLM_API_KEY") or os.getenv("OPENAI_API_KEY")
        llm_config = {
            "provider": provider,
            "url": llm_url,
            "model": args.llm_model,
            "mode": args.llm_mode,
            "timeout": args.llm_timeout,
            "temperature": args.llm_temperature,
            "api_key": api_key,
        }
        logging.info(
            "LLM enabled: provider=%s model=%s mode=%s url=%s timeout=%ss",
            llm_config["provider"],
            llm_config["model"],
            llm_config["mode"],
            llm_config["url"],
            llm_config["timeout"],
        )

    found_creatures = []
    found_magic_items = []

    with pdfplumber.open(pdf_path) as pdf:
        total_pages = len(pdf.pages)
        max_pages = args.max_pages or total_pages
        for page_num in range(1, max_pages + 1):
            logging.info("Page %s/%s: extracting text", page_num, max_pages)
            page = pdf.pages[page_num - 1]
            lines = extract_lines_from_page(page)
            joined = norm_name(" ".join(lines))
            if not joined or len(joined) < args.min_text:
                logging.debug("Page %s: skipped (min text)", page_num)
                continue

            if llm_config and llm_config["mode"] in {"prefer", "only"}:
                logging.info("Page %s: LLM parse (prefer/only)", page_num)
                parsed = parse_page_with_llm(lines, page_num, llm_config)
                if parsed:
                    if parsed.get("kind") == "creature":
                        found_creatures.append(apply_stat_lines(parsed, lines))
                    elif parsed.get("kind") == "magicItem":
                        found_magic_items.append(parsed)
                    continue
                if llm_config["mode"] == "only":
                    logging.info("Page %s: LLM only mode, skipping fallback", page_num)
                    continue

            creature = parse_creature_from_lines(lines, page_num)
            if creature:
                logging.info("Page %s: regex creature detected", page_num)
                found_creatures.append(creature)
                continue

            magic_item = parse_magic_item_from_lines(lines, page_num)
            if magic_item:
                logging.info("Page %s: regex magic item detected", page_num)
                found_magic_items.append(magic_item)
                continue

            if llm_config and llm_config["mode"] == "fallback":
                logging.info("Page %s: LLM parse (fallback)", page_num)
                parsed = parse_page_with_llm(lines, page_num, llm_config)
                if parsed:
                    if parsed.get("kind") == "creature":
                        found_creatures.append(apply_stat_lines(parsed, lines))
                    elif parsed.get("kind") == "magicItem":
                        found_magic_items.append(parsed)
                    continue

    items = []
    actors = []
    pdf_name = os.path.basename(pdf_path)

    for creature in found_creatures:
        embedded, created_items = build_items_for_creature(creature)
        items.extend(created_items)
        actor = build_actor(creature, embedded, pdf_name)
        actors.append(actor)

    for magic_item in found_magic_items:
        items.extend(build_items_for_magic_item(magic_item))

    actors = [a for a in actors if a.get("system", {}).get("attributes")]

    items_json = os.path.join(out_dir, "items.json")
    actors_json = os.path.join(out_dir, "actors.json")
    items_db = os.path.join(out_dir, "items.db")
    actors_db = os.path.join(out_dir, "actors.db")

    write_json(items_json, items)
    write_json(actors_json, actors)
    write_db(items_db, items)
    write_db(actors_db, actors)

    print(f"Creatures: {len(found_creatures)}")
    print(f"Magic items: {len(found_magic_items)}")
    print(f"Items written: {len(items)} -> {items_json}, {items_db}")
    print(f"Actors written: {len(actors)} -> {actors_json}, {actors_db}")


if __name__ == "__main__":
    main()

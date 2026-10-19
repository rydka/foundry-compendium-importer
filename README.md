# Compendium JSON Importer

Foundry VTT v14 module to import compendium entries from `.json` or `.db` files, with a conformity check
against the dnd5e 6 data model. Requires dnd5e 6.0.0 or later (verified with 6.0.6).

## Install

1) Copy this repository into your Foundry `Data/modules/compendium-json-importer/` folder, or use the manifest URL
   from `module.json`.
2) Enable the module in a dnd5e world.

## Use

Only the GM can import.

1) Open the importer: **Import** button in the **Compendiums** tab, or **Settings -> Module Settings -> Open Importer**.
2) Choose a `.json` or `.db` file, a type filter (actors, items, all) and a target: an existing compendium or a new
   one (label and name are suggested from the file name).
3) Set the options **Overwrite** and **Remove _id**, then click **Analyze**. Nothing is written yet.
4) Read the summary: conforming documents, documents updated by dnd5e migrations, rejected documents with their
   reasons, documents of other types, and documents that will be replaced.
5) Click **Import** to confirm, or **Cancel** to go back. The compendium is created, documents are overwritten and
   created (in batches of 50) only at this point.

Your last choices are remembered per user.

## Supported input formats

- `.db`: newline-delimited JSON (one document per line).
- `.json`:
  - Array of document objects.
  - Foundry compendium export format with `entries` array.
  - Object with `documents`, `items`, or `data` array.

## Options and `_id` conflicts

- **Overwrite** deletes existing entries that match by name (and type when present) before creating the new ones.
- **Remove _id** gives every document, embedded document and activity a new `_id` and rewrites the internal
  references (activity to effect links stay valid).
- With **Remove _id** unchecked, the `_id` values of the file are kept. If one is already used in the target
  compendium (and not removed by Overwrite), the summary lists the document: select those to import, then choose to
  replace the existing document or to import it with a new `_id`. Unselected documents are ignored.

## Completion from the text (0.3.0)

Requires the module **dnd5e Text Parser** (`dnd5e-text-parser`, API 1.x). With the option **Complete activities from
the text**, the analysis reads the descriptions of the items and fills what the file leaves empty:

- Empty "utility" activities become attacks, saving throws or damage; item uses and recharge, legendary actions and
  legendary resistances (Legendary Resistance (n/Day) moves from the legendary activation to `special`), damage
  resistances, immunities and vulnerabilities (union with the existing values), spellcasting (ability, level, slots).
- Values already in the file are never replaced. Two exceptions are signalled in the summary: Legendary Resistance
  and "Costs N Actions" in the text, which wins over the legendary cost of the file.
- For actors, items and spells are looked up in the compendiums (settings menu **Compendium sources**: choose the
  packs and their order). A match replaces the item, keeps the name and the description of the file (the PDF text is
  appended) and adjusts attack bonus, damage, DC, range, uses and activation to the file. The summary lists what was
  taken from a compendium, what was built from the text, and what was ambiguous.
- A document that cannot be enriched, or whose enriched version is refused by dnd5e, is imported as it is.

## dnd5e conformity

Actors and items are built in memory with the dnd5e 6 data model, without writing anything:

- Older data (for example dnd5e 3.x or 4.x items) goes through the dnd5e migrations and is flagged as updated.
- A document is rejected, with a readable reason, if its type is unknown, a value is invalid, or a field is not part
  of the dnd5e 6 model and would be dropped (unless dnd5e updated the document, in which case it is only noted).
- Invalid values that cleaning would silently replace by a default (text turned into null, NaN or an empty object) are
  rejected with the field and the value provided. Documents older than dnd5e 6.0.0 (declared `_stats.systemVersion`)
  are migrated by dnd5e and do not go through this check of replaced values.
- Documents of other types (journals, tables, and so on, in a matching compendium) are imported without checks.

## Macro API

`game.modules.get("compendium-json-importer").api` (available after `ready`, GM only for writes):

- `open()`: open the importer window.
- `analyze(entries, documentName, options)`: check and migrate entries in memory, returns
  `{ accepted, rejected, other }`; options `enrich` and `compendiums` complete the documents from the text (and
  add `enrichment`, the summary).
- `runImport(analysis, options)`: write an analysis, options `{ pack, newPackSpec, overwrite, stripIds,
  conflictSelection, conflictAction }`, returns `{ created, replaced, ignored, rejected }`.

```js
const api = game.modules.get("compendium-json-importer").api;
const entries = JSON.parse(await (await fetch("worlds/my-world/monsters.json")).text());
const analysis = await api.analyze(entries, "Actor");
console.log(analysis.rejected);
const pack = game.packs.get("world.monsters");
const result = await api.runImport(analysis, { pack, overwrite: true, stripIds: true });
ui.notifications.info(`${result.created} created, ${result.replaced} replaced`);
```

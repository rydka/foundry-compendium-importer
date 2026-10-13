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

## dnd5e conformity

Actors and items are built in memory with the dnd5e 6 data model, without writing anything:

- Older data (for example dnd5e 3.x or 4.x items) goes through the dnd5e migrations and is flagged as updated.
- A document is rejected, with a readable reason, if its type is unknown, a value is invalid, or a field is not part
  of the dnd5e 6 model and would be dropped (unless dnd5e updated the document, in which case it is only noted).
- Documents of other types (journals, tables, and so on, in a matching compendium) are imported without checks.

## Macro API

`game.modules.get("compendium-json-importer").api` (available after `ready`, GM only for writes):

- `open()`: open the importer window.
- `analyze(entries, documentName, options)`: check and migrate entries in memory, returns
  `{ accepted, rejected, other }`.
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

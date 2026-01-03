# Compendium JSON Importer

Foundry VTT v13 module to import compendium entries from `.json` or `.db` files.
Tested with dnd5e 5.2.24.

## Install

1) Copy `compendium-json-importer` into your Foundry `Data/modules/` folder.
2) Enable the module in your world.

## Use

1) Open **Settings -> Module Settings**.
2) Click **Open Importer** under **Compendium JSON Importer**.
3) Choose a `.json` or `.db` file and select a target pack.

## Supported input formats

- `.db`: newline-delimited JSON (one document per line).
- `.json`:
  - Array of document objects.
  - Foundry compendium export format with `entries` array.
  - Object with `documents`, `items`, or `data` array.

## Notes

- **Overwrite** deletes existing entries that match by name (and type when present).
- **Strip _id** removes `_id` fields (including embedded documents) to avoid conflicts.

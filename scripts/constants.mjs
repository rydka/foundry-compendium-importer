export const MODULE_ID = "compendium-json-importer";

export const SETTINGS = {
  typeFilter: "lastTypeFilter",
  targetPack: "lastTargetPack",
  overwrite: "lastOverwrite",
  stripIds: "lastStripIds"
};

export const BATCH_SIZE = 50;
export const TYPE_FILTERS = { all: null, actors: "Actor", items: "Item" };
export const CHECKED_DOCUMENTS = ["Actor", "Item"];
export const LEGACY_TYPE_ALIASES = { Item: { backpack: "container" } };

import { MODULE_ID } from "../constants.mjs";

const DEFAULTS = {
  lastTypeFilter: "all",
  lastTargetPack: "new",
  lastOverwrite: true,
  lastStripIds: true,
  lastEnrich: true,
  lastUseCompendiums: true
};

/** Register the internal client settings that remember the last choices (C16). */
export function registerSettings() {
  for ( const [key, value] of Object.entries(DEFAULTS) ) {
    game.settings.register(MODULE_ID, key, { scope: "client", config: false, type: value.constructor, default: value });
  }
  // Order and choice of the compendiums used to take items from: [] means the default order (C18, C24)
  const { ArrayField, SchemaField, StringField, BooleanField } = foundry.data.fields;
  game.settings.register(MODULE_ID, "compendiumSources", {
    scope: "world",
    config: false,
    type: new ArrayField(new SchemaField({
      pack: new StringField({ required: true, blank: false }),
      enabled: new BooleanField({ initial: true })
    })),
    default: []
  });
}

/**
 * Read the last choices.
 * @returns {{typeFilter: string, targetPack: string, overwrite: boolean, stripIds: boolean, enrich: boolean, useCompendiums: boolean}}
 */
export function loadChoices() {
  const get = key => game.settings.get(MODULE_ID, key);
  return {
    typeFilter: get("lastTypeFilter"),
    targetPack: get("lastTargetPack"),
    overwrite: get("lastOverwrite"),
    stripIds: get("lastStripIds"),
    enrich: get("lastEnrich"),
    useCompendiums: get("lastUseCompendiums")
  };
}

/**
 * Store the choices for the next opening.
 * @param {{typeFilter: string, targetPack: string, overwrite: boolean, stripIds: boolean, enrich: boolean, useCompendiums: boolean}} choices
 */
export async function saveChoices(choices) {
  const set = (key, value) => game.settings.set(MODULE_ID, key, value);
  await Promise.all([
    set("lastTypeFilter", choices.typeFilter),
    set("lastTargetPack", choices.targetPack),
    set("lastOverwrite", !!choices.overwrite),
    set("lastStripIds", !!choices.stripIds),
    set("lastEnrich", !!choices.enrich),
    set("lastUseCompendiums", !!choices.useCompendiums)
  ]);
}

import { MODULE_ID } from "../constants.mjs";

const DEFAULTS = {
  lastTypeFilter: "all",
  lastTargetPack: "new",
  lastOverwrite: true,
  lastStripIds: true
};

/** Register the internal client settings that remember the last choices (C16). */
export function registerSettings() {
  for ( const [key, value] of Object.entries(DEFAULTS) ) {
    game.settings.register(MODULE_ID, key, { scope: "client", config: false, type: value.constructor, default: value });
  }
}

/**
 * Read the last choices.
 * @returns {{typeFilter: string, targetPack: string, overwrite: boolean, stripIds: boolean}}
 */
export function loadChoices() {
  const get = key => game.settings.get(MODULE_ID, key);
  return {
    typeFilter: get("lastTypeFilter"),
    targetPack: get("lastTargetPack"),
    overwrite: get("lastOverwrite"),
    stripIds: get("lastStripIds")
  };
}

/**
 * Store the choices for the next opening.
 * @param {{typeFilter: string, targetPack: string, overwrite: boolean, stripIds: boolean}} choices
 */
export async function saveChoices(choices) {
  const set = (key, value) => game.settings.set(MODULE_ID, key, value);
  await Promise.all([
    set("lastTypeFilter", choices.typeFilter),
    set("lastTargetPack", choices.targetPack),
    set("lastOverwrite", !!choices.overwrite),
    set("lastStripIds", !!choices.stripIds)
  ]);
}

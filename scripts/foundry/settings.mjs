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
  registerAiSettings();
}

const AI_DEFAULT_URL = "http://localhost:11434";
const AI_DEFAULT_MODEL = "llama3.1:8b";
const AI_DEFAULT_TIMEOUT_S = 120;
const ITEM_CONFIGURATOR = "item-configurator";

/** Register the world settings of the local AI for the PDF blocks the rules cannot read (C5). Off by default. */
export function registerAiSettings() {
  const name = key => ({ name: `${MODULE_ID}.Settings.${key}.Name`, hint: `${MODULE_ID}.Settings.${key}.Hint` });
  game.settings.register(MODULE_ID, "pdfAi", { ...name("pdfAi"), scope: "world", config: true, restricted: true, type: Boolean, default: false });
  // Empty: the values of item-configurator when it is active, else the defaults
  game.settings.register(MODULE_ID, "ollamaUrl", { ...name("ollamaUrl"), scope: "world", config: true, restricted: true, type: String, default: "" });
  game.settings.register(MODULE_ID, "ollamaModel", { ...name("ollamaModel"), scope: "world", config: true, restricted: true, type: String, default: "" });
  game.settings.register(MODULE_ID, "aiTimeout", {
    ...name("aiTimeout"), scope: "world", config: true, restricted: true, type: Number, default: AI_DEFAULT_TIMEOUT_S,
    range: { min: 10, max: 600, step: 10 }
  });
}

/** A setting of item-configurator, when that module is active and registered it. */
function itemConfiguratorSetting(key) {
  if ( !game.modules.get(ITEM_CONFIGURATOR)?.active || !game.settings.settings.has(`${ITEM_CONFIGURATOR}.${key}`) ) return "";
  return String(game.settings.get(ITEM_CONFIGURATOR, key) ?? "");
}

/**
 * Local AI configuration for the PDF blocks the rules cannot read (C5): the module's settings, then those of
 * item-configurator, then the defaults (`http://localhost:11434`, `llama3.1:8b`, 120 s).
 * @returns {{enabled: boolean, url: string, model: string, timeoutMs: number}}
 */
export function aiConfig() {
  const get = key => (game.settings.settings.has(`${MODULE_ID}.${key}`) ? game.settings.get(MODULE_ID, key) : undefined);
  const url = String(get("ollamaUrl") ?? "").trim() || itemConfiguratorSetting("ollamaUrl") || AI_DEFAULT_URL;
  const model = String(get("ollamaModel") ?? "").trim() || itemConfiguratorSetting("ollamaModel") || AI_DEFAULT_MODEL;
  const seconds = Number(get("aiTimeout")) || AI_DEFAULT_TIMEOUT_S;
  return { enabled: get("pdfAi") === true, url, model, timeoutMs: Math.max(10, Math.min(600, seconds)) * 1000 };
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

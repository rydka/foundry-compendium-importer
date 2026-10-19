import { MODULE_ID } from "./constants.mjs";
import { registerSettings } from "./foundry/settings.mjs";
import { SourcesApp } from "./foundry/sources-app.mjs";
import { ImporterApp, openImporter } from "./foundry/importer-app.mjs";
import { onRenderCompendiumDirectory } from "./foundry/directory-button.mjs";
import { analyzeEntries } from "./foundry/validator.mjs";
import { importFromAnalysis } from "./foundry/import-runner.mjs";
import { invalidateIndexes } from "./foundry/enrichment.mjs";

Hooks.once("init", () => {
  registerSettings();
  game.settings.registerMenu(MODULE_ID, "importer", {
    name: `${MODULE_ID}.Menu.Name`,
    label: `${MODULE_ID}.Menu.Label`,
    hint: `${MODULE_ID}.Menu.Hint`,
    icon: "fa-solid fa-file-import",
    type: ImporterApp,
    restricted: true
  });
  game.settings.registerMenu(MODULE_ID, "sources", {
    name: `${MODULE_ID}.Sources.MenuName`,
    label: `${MODULE_ID}.Sources.MenuLabel`,
    hint: `${MODULE_ID}.Sources.MenuHint`,
    icon: "fa-solid fa-list-ol",
    type: SourcesApp,
    restricted: true
  });
  Hooks.on("renderCompendiumDirectory", onRenderCompendiumDirectory);
  // Contents of a pack changed (documents created, updated or deleted): the preloaded indexes are stale.
  // Packs created or deleted need no hook: the source order read at each analysis reflects them.
  Hooks.on("updateCompendium", invalidateIndexes);
  // Compile the templates of both windows now: the first opening no longer waits for one request per part.
  const templates = [ImporterApp, SourcesApp].flatMap(app => Object.values(app.PARTS).map(part => part.template));
  foundry.applications.handlebars.loadTemplates(templates)
    .catch(err => console.warn(`${MODULE_ID} | preloading the templates failed`, err));
});

Hooks.once("ready", () => {
  game.modules.get(MODULE_ID).api = { open: openImporter, analyze: analyzeEntries, runImport: importFromAnalysis };
});

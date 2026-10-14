import { MODULE_ID } from "./constants.mjs";
import { registerSettings } from "./foundry/settings.mjs";
import { SourcesApp } from "./foundry/sources-app.mjs";
import { ImporterApp, openImporter } from "./foundry/importer-app.mjs";
import { onRenderCompendiumDirectory } from "./foundry/directory-button.mjs";
import { analyzeEntries } from "./foundry/validator.mjs";
import { importFromAnalysis } from "./foundry/import-runner.mjs";

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
});

Hooks.once("ready", () => {
  game.modules.get(MODULE_ID).api = { open: openImporter, analyze: analyzeEntries, runImport: importFromAnalysis };
});

import { MODULE_ID } from "../constants.mjs";
import { openImporter } from "./importer-app.mjs";

/**
 * Add the "Import" button to the Compendiums tab header (GM only, C5).
 * Listens to `renderCompendiumDirectory`.
 */
export function onRenderCompendiumDirectory(app, element, context, options) {
  if ( !game.user.isGM ) return;
  if ( options?.parts && !options.parts.includes("header") ) return;
  const actions = element.querySelector(".directory-header .header-actions");
  if ( !actions || actions.querySelector(".cji-open-importer") ) return;
  const button = document.createElement("button");
  Object.assign(button, { type: "button", className: "cji-open-importer" });
  button.innerHTML = `<i class="fa-solid fa-file-import" inert></i> <span>${game.i18n.localize(`${MODULE_ID}.Button.Import`)}</span>`;
  button.addEventListener("click", event => {
    event.preventDefault();
    openImporter();
  });
  actions.append(button);
}

import { MODULE_ID } from "../constants.mjs";
import { defaultSources, itemPacks, resolveSources } from "./enrichment.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const TPL = `modules/${MODULE_ID}/templates`;

/** Settings window: which Item compendiums feed the import, and in which order (C24). */
export class SourcesApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-sources`,
    tag: "form",
    classes: [MODULE_ID, "cji-sources"],
    window: { title: `${MODULE_ID}.Sources.Title`, icon: "fa-solid fa-list-ol" },
    position: { width: 520 },
    form: { handler: SourcesApp.#onSubmit, closeOnSubmit: true },
    actions: { moveUp: SourcesApp.#onMove, moveDown: SourcesApp.#onMove, resetSources: SourcesApp.#onReset }
  };

  static PARTS = {
    list: { template: `${TPL}/sources.hbs` },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  /** Rows in display order: `{ pack, enabled }`. */
  #rows = resolveSources();

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const packs = new Map(itemPacks().map(p => [p.collection, p]));
    context.rows = this.#rows.filter(row => packs.has(row.pack)).map((row, i, rows) => ({
      ...row,
      label: packs.get(row.pack).label,
      first: i === 0,
      last: i === rows.length - 1
    }));
    context.buttons = [{ type: "submit", icon: "fa-solid fa-floppy-disk", label: "Save", cssClass: "primary" }];
    return context;
  }

  /** Copy the checkboxes into the rows before the list is redrawn. */
  #readRows() {
    for ( const box of this.element.querySelectorAll("input[name=enabled]") ) {
      const row = this.#rows.find(r => r.pack === box.value);
      if ( row ) row.enabled = box.checked;
    }
  }

  static async #onMove(event, target) {
    this.#readRows();
    const i = this.#rows.findIndex(row => row.pack === target.dataset.pack);
    const j = i + (target.dataset.action === "moveUp" ? -1 : 1);
    if ( (i < 0) || !this.#rows[j] ) return;
    [this.#rows[i], this.#rows[j]] = [this.#rows[j], this.#rows[i]];
    await this.render({ parts: ["list"] });
  }

  static async #onReset() {
    this.#rows = defaultSources();
    await this.render({ parts: ["list"] });
  }

  static async #onSubmit() {
    this.#readRows();
    await game.settings.set(MODULE_ID, "compendiumSources", this.#rows.map(({ pack, enabled }) => ({ pack, enabled })));
  }
}

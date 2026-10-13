import { MODULE_ID, TYPE_FILTERS } from "../constants.mjs";
import { parseImportFile, ImportFormatError } from "../core/parse.mjs";
import { remapIds } from "../core/ids.mjs";
import { findOverwriteTargets, findIdConflicts } from "../core/matching.mjs";
import { slugify, suggestPackFields } from "../core/naming.mjs";
import { analyzeEntries } from "./validator.mjs";
import { resolveTarget, runImport } from "./import-runner.mjs";
import { loadChoices, saveChoices } from "./settings.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const { FormDataExtended } = foundry.applications.ux;
const TPL = `modules/${MODULE_ID}/templates/importer`;
const t = (key, data) => (data
  ? game.i18n.format(`${MODULE_ID}.${key}`, data)
  : game.i18n.localize(`${MODULE_ID}.${key}`));

/** Translate a `{ key, data }` reason produced by the core or the validator. */
function reasonText(reason) {
  if ( typeof reason === "string" ) return reason;
  for ( const key of [reason.key, `${MODULE_ID}.${reason.key}`] ) {
    if ( game.i18n.has(key) ) return game.i18n.format(key, reason.data ?? {});
  }
  return `${reason.key} ${JSON.stringify(reason.data ?? {})}`;
}

/** Open the importer window, or bring the existing one to the front. */
export function openImporter() {
  const app = foundry.applications.instances.get(MODULE_ID) ?? new ImporterApp();
  return app.render({ force: true });
}

export class ImporterApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: MODULE_ID,
    tag: "form",
    classes: [MODULE_ID],
    window: { title: `${MODULE_ID}.Title`, icon: "fa-solid fa-file-import" },
    position: { width: 560 },
    form: { handler: ImporterApp.#onSubmit, submitOnChange: false, closeOnSubmit: false },
    actions: { confirmImport: ImporterApp.#onConfirm, backToForm: ImporterApp.#onBack }
  };

  static PARTS = {
    source: { template: `${TPL}/source.hbs` },
    target: { template: `${TPL}/target.hbs` },
    options: { template: `${TPL}/options.hbs` },
    summary: { template: `${TPL}/summary.hbs` },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  #state = { ...loadChoices(), newPackLabel: "", newPackName: "", newPackType: "Actor" };

  #step = "choose";

  #file = null;

  #nameTouched = false;

  #analysis = null;

  #busy = false;

  /* -------------------------------------------- */
  /*  Rendering                                   */
  /* -------------------------------------------- */

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const s = this.#state;
    const review = this.#step === "review";
    const filterType = TYPE_FILTERS[s.typeFilter];
    const packs = game.packs.filter(p => p.visible && (!filterType || p.documentName === filterType));
    const packChoices = [{ value: "new", label: t("Target.NewPack") },
      ...packs.map(p => ({ value: p.collection, label: `${p.metadata.label} (${p.collection})` }))];
    if ( !packChoices.some(c => c.value === s.targetPack) ) s.targetPack = "new";
    const filterLabels = { all: "Filter.All", actors: "Filter.Actors", items: "Filter.Items" };
    const typeChoices = CONST.COMPENDIUM_DOCUMENT_TYPES.map(type => ({
      value: type, label: game.i18n.localize(CONFIG[type].documentClass.metadata.label)
    }));
    return Object.assign(context, {
      locked: review,
      fileName: this.#file?.name ?? "",
      typeFilter: s.typeFilter,
      typeFilters: Object.keys(TYPE_FILTERS).map(value => ({ value, label: t(filterLabels[value]) })),
      packChoices,
      targetPack: s.targetPack,
      isNew: s.targetPack === "new",
      showType: s.typeFilter === "all",
      typeChoices,
      newPackLabel: s.newPackLabel,
      newPackName: s.newPackName,
      newPackType: filterType ?? s.newPackType,
      overwrite: s.overwrite,
      stripIds: s.stripIds,
      review,
      summary: review ? this.#summaryContext() : null,
      buttons: this.#buttons()
    });
  }

  #summaryContext() {
    const a = this.#analysis;
    return {
      counts: {
        conform: a.accepted.length,
        updated: a.accepted.filter(d => d.updated).length,
        rejected: a.rejected.length,
        other: a.other.length,
        toReplace: a.overwriteIds.length
      },
      rejected: a.rejected.map(r => ({ name: r.name, type: r.type, reasons: r.reasons.map(reasonText) })),
      notes: a.accepted.filter(d => d.notes?.length).map(d => ({ name: d.name, notes: d.notes.map(reasonText) })),
      warnings: a.warnings,
      conflicts: a.conflicts,
      actions: [
        { value: "replace", label: t("Summary.ActionReplace") },
        { value: "newId", label: t("Summary.ActionNewId") }
      ],
      target: a.pack ? a.pack.metadata.label : a.newPackSpec.label
    };
  }

  #buttons() {
    if ( this.#step === "choose" ) {
      return [{ type: "submit", icon: "fa-solid fa-magnifying-glass", label: t("Button.Analyze"), cssClass: "primary" }];
    }
    const count = this.#importCount();
    return [
      { type: "button", action: "confirmImport", icon: "fa-solid fa-file-import", cssClass: "primary",
        label: t("Button.Confirm", { count }), disabled: count === 0 || this.#busy },
      { type: "button", action: "backToForm", icon: "fa-solid fa-xmark", label: t("Button.Cancel") }
    ];
  }

  #importCount() {
    const a = this.#analysis;
    if ( !a ) return 0;
    return a.documents.length - a.conflicts.length + this.#selectedConflicts().size;
  }

  #selectedConflicts() {
    const boxes = this.element?.querySelectorAll("input[name=conflictSelected]:checked") ?? [];
    return new Set(Array.from(boxes, box => box.value));
  }

  /* -------------------------------------------- */
  /*  Form changes                                */
  /* -------------------------------------------- */

  #readState() {
    const data = new FormDataExtended(this.form).object;
    const s = this.#state;
    s.typeFilter = data.typeFilter ?? s.typeFilter;
    s.targetPack = data.targetPack ?? s.targetPack;
    s.newPackLabel = data.newPackLabel ?? s.newPackLabel;
    s.newPackName = data.newPackName ?? s.newPackName;
    s.newPackType = data.newPackType ?? s.newPackType;
    s.overwrite = !!data.overwrite;
    s.stripIds = !!data.stripIds;
  }

  #setField(name, value) {
    const input = this.form.elements[name];
    if ( input ) input.value = value;
    this.#state[name] = value;
  }

  /** @override */
  _onChangeForm(formConfig, event) {
    super._onChangeForm(formConfig, event);
    const target = event.target;
    if ( this.#step === "review" ) return this.#onConflictChange(target);
    this.#readState();
    const s = this.#state;
    switch ( target.name ) {
      case "sourceFile": {
        this.#file = target.files[0] ?? null;
        this.form.querySelector(".cji-file-name").textContent = this.#file?.name ?? t("Source.NoFile");
        if ( this.#file && !s.newPackLabel ) {
          const suggestion = suggestPackFields(this.#file.name);
          this.#setField("newPackLabel", suggestion.label);
          if ( !this.#nameTouched ) this.#setField("newPackName", suggestion.name);
        }
        break;
      }
      case "newPackLabel":
        if ( !this.#nameTouched ) this.#setField("newPackName", slugify(s.newPackLabel));
        break;
      case "newPackName":
        this.#nameTouched = !!s.newPackName;
        break;
      case "typeFilter":
        if ( TYPE_FILTERS[s.typeFilter] ) s.newPackType = TYPE_FILTERS[s.typeFilter];
        this.render({ parts: ["target"] });
        break;
      case "targetPack":
        this.form.querySelectorAll(".cji-new-pack").forEach(el => el.toggleAttribute("hidden", s.targetPack !== "new"));
        break;
    }
  }

  #onConflictChange(target) {
    const boxes = Array.from(this.element.querySelectorAll("input[name=conflictSelected]"));
    if ( target.name === "selectAll" ) boxes.forEach(box => { box.checked = target.checked; });
    else if ( target.name !== "conflictSelected" ) return;
    const all = this.element.querySelector("input[name=selectAll]");
    if ( all ) all.checked = boxes.length > 0 && boxes.every(box => box.checked);
    this.render({ parts: ["footer"] });
  }

  /* -------------------------------------------- */
  /*  Step 1: analysis                            */
  /* -------------------------------------------- */

  static async #onSubmit() {
    await this.#analyze();
  }

  #fail(key, data) {
    ui.notifications.error(t(key, data));
  }

  async #analyze() {
    if ( !game.user.isGM ) return this.#fail("Error.NotGM");
    if ( !this.#file ) return this.#fail("Error.NoFile");
    this.#readState();
    const s = this.#state;
    const filterType = TYPE_FILTERS[s.typeFilter];
    if ( filterType ) s.newPackType = filterType;
    const existing = s.targetPack === "new" ? null : game.packs.get(s.targetPack);
    if ( existing && filterType && (existing.documentName !== filterType) ) {
      return this.#fail("Error.PackType", { pack: existing.metadata.label, type: filterType });
    }

    let parsed;
    try {
      parsed = parseImportFile(await this.#file.text(), this.#file.name);
    } catch(err) {
      if ( err instanceof ImportFormatError ) return this.#fail(`Error.Format.${err.code}`, { line: err.line });
      throw err;
    }
    const { pack, newPackSpec, errors } = resolveTarget(s);
    if ( errors?.length ) {
      errors.forEach(error => ui.notifications.error(reasonText(error)));
      return;
    }
    const documentName = pack ? pack.documentName : newPackSpec.type;
    const warnings = [];
    if ( parsed.meta?.docType && (parsed.meta.docType !== documentName) ) {
      warnings.push(t("Warning.DocType", { file: parsed.meta.docType, pack: documentName }));
      ui.notifications.warn(warnings.at(-1));
    }

    const idGen = () => foundry.utils.randomID();
    const migrationData = await dnd5e.migrations.getMigrationData();
    const result = await analyzeEntries(parsed.entries, documentName, { migrationData, idGen });
    const documents = [...result.accepted, ...result.other.map(o => {
      const data = o.data ?? o;
      return { data, name: o.name ?? data.name, type: o.type ?? data.type };
    })];
    if ( s.stripIds ) documents.forEach(d => { d.data = remapIds(d.data, idGen); });

    const index = pack ? await pack.getIndex({ fields: ["name", "type"] }) : [];
    const overwriteIds = (s.overwrite && pack) ? findOverwriteTargets(index, documents.map(d => d.data)) : [];
    const conflictIds = (!s.stripIds && pack)
      ? findIdConflicts(index, documents.map(d => d.data), new Set(overwriteIds)) : new Set();
    const conflicts = documents.filter(d => conflictIds.has(d.data._id)).map(d => ({
      id: d.data._id, name: d.name, type: d.type, existing: index.get(d.data._id)?.name ?? d.data._id
    }));

    this.#analysis = {
      pack, newPackSpec, accepted: result.accepted, rejected: result.rejected, other: result.other,
      documents, overwriteIds, conflicts, warnings
    };
    await saveChoices(s);
    this.#step = "review";
    await this.render();
  }

  /* -------------------------------------------- */
  /*  Step 2: confirmation                        */
  /* -------------------------------------------- */

  static async #onBack() {
    this.#step = "choose";
    this.#analysis = null;
    await this.render();
  }

  static async #onConfirm() {
    await this.#confirm();
  }

  async #confirm() {
    if ( !game.user.isGM ) return this.#fail("Error.NotGM");
    const a = this.#analysis;
    if ( !a || this.#busy ) return;
    const selected = this.#selectedConflicts();
    const action = this.element.querySelector("[name=conflictAction]")?.value ?? "replace";
    const conflictIds = new Set(a.conflicts.map(c => c.id));
    const deleteIds = new Set(a.overwriteIds);
    const documents = [];
    let ignored = 0;
    for ( const doc of a.documents ) {
      const id = doc.data._id;
      if ( conflictIds.has(id) ) {
        if ( !selected.has(id) ) {
          ignored++;
          continue;
        }
        if ( action === "replace" ) deleteIds.add(id);
        else doc.data = remapIds(doc.data, () => foundry.utils.randomID());
      }
      documents.push(doc.data);
    }
    this.#busy = true;
    let result;
    try {
      result = await runImport({ pack: a.pack, newPackSpec: a.newPackSpec, documents, deleteIds: Array.from(deleteIds) });
    } catch(err) {
      console.error(err);
      return this.#fail("Error.ImportFailed", { message: err.message });
    } finally {
      this.#busy = false;
    }
    await saveChoices(this.#state);
    ui.notifications.info(t("Notify.Done", {
      created: result.created,
      replaced: result.replaced,
      ignored,
      rejected: a.rejected.length,
      target: a.pack ? a.pack.metadata.label : a.newPackSpec.label
    }));
    await this.close();
  }
}

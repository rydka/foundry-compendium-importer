import { MODULE_ID, TYPE_FILTERS } from "../constants.mjs";
import { parseImportFile, ImportFormatError } from "../core/parse.mjs";
import { slugify, suggestPackFields, worldPackId } from "../core/naming.mjs";
import { analyzeEntries, loadMigrationData } from "./validator.mjs";
import { applyConflictChoices, planImport, resolveTarget, runImport } from "./import-runner.mjs";
import { aiConfig, loadChoices, saveChoices } from "./settings.mjs";
import { loadParser, preloadIndexes } from "./enrichment.mjs";
import { describeReport } from "./enrich-summary.mjs";
import { extractFromPdf, PdfImportError } from "./pdf-import.mjs";

const PDF_FILE = /\.pdf$/i;

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
    classes: [MODULE_ID, "standard-form"],
    window: { title: `${MODULE_ID}.Title`, icon: "fa-solid fa-file-import", resizable: true },
    position: { width: 560 },
    form: { handler: ImporterApp.#onSubmit, submitOnChange: false, closeOnSubmit: false },
    actions: {
      confirmImport: ImporterApp.#onConfirm, backToForm: ImporterApp.#onBack, useExistingPack: ImporterApp.#onUseExisting,
      cancelAnalysis: ImporterApp.#onCancelAnalysis
    }
  };

  static PARTS = {
    source: { template: `${TPL}/source.hbs` },
    target: { template: `${TPL}/target.hbs` },
    options: { template: `${TPL}/options.hbs` },
    summary: { template: `${TPL}/summary.hbs` },
    // The footer holds the buttons and the progress line; it sticks to the bottom of the scrolling content
    footer: { template: `${TPL}/footer.hbs` }
  };

  #state = { ...loadChoices(), newPackLabel: "", newPackName: "", newPackType: "Actor" };

  #step = "choose";
  #file = null;
  #fileText = null; // read as soon as the file is chosen
  #nameTouched = false;
  #analysis = null;
  #busy = false;
  #analyzing = false;
  #abort = null; // AbortController of a PDF read in progress (the Cancel button)

  /** The chosen file is a PDF: read by pdf.js at analysis time, never as text. */
  #isPdf() {
    return PDF_FILE.test(this.#file?.name ?? "");
  }

  /** @override */
  _attachFrameListeners() {
    super._attachFrameListeners();
    // Typing in the name field protects it before the change event, so a suggestion never overwrites it
    this.element.addEventListener("input", event => {
      if ( event.target.name === "newPackName" ) this.#nameTouched = !!event.target.value;
    });
  }

  // Rendering

  /** @override */
  _onClose(options) {
    super._onClose(options);
    // Closing the window cancels a PDF read in progress: pdf.js task and worker, and the Ollama queue
    this.#abort?.abort();
    this.#abort = null;
  }

  /** @override */
  async _onRender(context, options) {
    await super._onRender(context, options);
    if ( this.#step === "choose" ) this.#preload();
    // The review summary follows the form: bring its title to the top of the scrolling content (the window keeps
    // the height of the screen, the footer stays visible below)
    else if ( !options.parts || options.parts.includes("summary") ) {
      this.element.querySelector(".cji-summary h3")?.scrollIntoView({ block: "start" });
    }
  }

  /**
   * Start in the background what the analysis will wait for: the dnd5e migration data, and the source indexes
   * when the enrichment and the compendium lookup are on. A failure is only logged (the analysis reports it).
   */
  #preload() {
    if ( !game.user.isGM ) return;
    const quiet = err => console.warn(`${MODULE_ID} | preloading failed`, err);
    loadMigrationData().catch(quiet);
    const s = this.#state;
    if ( !s.enrich || !s.useCompendiums ) return;
    loadParser().then(parser => parser && preloadIndexes()).catch(quiet);
  }

  /** The text of the chosen file, read once; read again if the first read failed (file changed on disk). */
  #readFile() {
    const read = this.#file.text();
    read.catch(() => { this.#fileText = null; });
    return read;
  }

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const s = this.#state;
    const review = this.#step === "review";
    const enrichAvailable = !!(await loadParser());
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
      targetProblem: review ? null : this.#targetProblem(),
      overwrite: s.overwrite,
      stripIds: s.stripIds,
      enrichAvailable,
      enrich: enrichAvailable && s.enrich,
      useCompendiums: s.useCompendiums,
      review,
      summary: review ? this.#summaryContext() : null,
      buttons: this.#buttons()
    });
  }

  #summaryContext() {
    const a = this.#analysis;
    return {
      pdf: this.#pdfContext(),
      enrich: this.#enrichContext(),
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

  /**
   * What the PDF read found and what went wrong (C4): pages, stat blocks found and read, magic items, entries of
   * the other type ignored, problems (name, page, reason) first, the blocks read with their page and a badge for
   * those read by the local AI. Null for a .json or .db file.
   */
  #pdfContext() {
    const report = this.#analysis.pdf;
    if ( !report ) return null;
    const page = p => (p ? t("Pdf.Page", { page: p }) : "");
    const ignored = [];
    if ( report.ignoredOtherType?.Item ) ignored.push(t("Pdf.IgnoredItems", { count: report.ignoredOtherType.Item }));
    if ( report.ignoredOtherType?.Actor ) ignored.push(t("Pdf.IgnoredActors", { count: report.ignoredOtherType.Actor }));
    const blocks = report.blocks.filter(b => b.status !== "failed");
    const seconds = ((report.timings?.open ?? 0) + (report.timings?.pages ?? 0) + (report.timings?.extract ?? 0) + (report.timings?.ai ?? 0)) / 1000;
    return {
      fileName: report.fileName,
      pages: report.pages,
      seconds: seconds.toFixed(1),
      found: report.stats?.blocksFound ?? report.blocks.length,
      read: blocks.length,
      aiCount: blocks.filter(b => b.status === "ai").length,
      items: report.items.length,
      ignored,
      problems: report.problems.map(p => ({
        name: p.name ?? t("Pdf.WholePage"), page: page(p.page),
        reason: t(`Pdf.Reason.${p.reason}`, { ...(p.detail ?? {}), missing: (p.detail?.missing ?? []).join(", ") })
      })),
      blocks: blocks.map(b => ({ name: b.name, page: page(b.page), ai: b.status === "ai" })),
      itemList: report.items.map(i => ({ name: i.name, page: page(i.page) }))
    };
  }

  /** Counts and one block per enriched document, or null when the enrichment was not requested. */
  #enrichContext() {
    const enrichment = this.#analysis.enrichment;
    if ( !enrichment || enrichment.unavailable ) return null;
    const { counts } = enrichment;
    const documents = this.#analysis.accepted.filter(d => d.enrichment && (d.enrichment.status !== "unchanged"))
      .map(d => ({
        name: d.name,
        status: d.enrichment.status,
        statusLabel: t(`Enrich.Status.${d.enrichment.status}`),
        ...describeReport(d.enrichment)
      }));
    return {
      counts: { enriched: counts.enriched, unchanged: counts.unchanged, notEnriched: counts.notEnriched + counts.reverted },
      documents,
      skipped: enrichment.skipped.map(s => t("Enrich.SourceSkipped", s))
    };
  }

  /** Buttons of the footer (labels already translated). */
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

  // Target name, status line and buttons

  /**
   * The new compendium name is already taken: `{ message, pack }`, where `pack` is the existing collection when
   * the window can import into it (visible, and of the type the filter allows), else null.
   */
  #targetProblem() {
    const s = this.#state;
    if ( s.targetPack !== "new" ) return null;
    const name = String(s.newPackName ?? "").trim() || slugify(String(s.newPackLabel ?? "").trim());
    const existing = name ? game.packs.get(worldPackId(name)) : null;
    if ( !existing ) return null;
    const filterType = TYPE_FILTERS[s.typeFilter];
    const usable = existing.visible && (!filterType || (existing.documentName === filterType));
    return {
      message: t("Target.Exists", { name: existing.metadata.label, id: existing.collection }),
      pack: usable ? existing.collection : null
    };
  }

  /** Show (or hide) the target problem next to the name field, without a render. Returns the problem. */
  #showTargetProblem(problem = this.#targetProblem()) {
    const box = this.element?.querySelector(".cji-target-problem");
    if ( !box ) return problem;
    box.toggleAttribute("hidden", !problem);
    box.querySelector(".cji-target-message").textContent = problem?.message ?? "";
    const button = box.querySelector("button");
    button.toggleAttribute("hidden", !problem?.pack);
    button.dataset.pack = problem?.pack ?? "";
    return problem;
  }

  /** The step in progress (italic) or an error (kept until the next analysis); null hides the line. */
  #status(text, { error = false } = {}) {
    const line = this.element?.querySelector(".cji-status");
    if ( !line ) return;
    line.textContent = text ?? "";
    line.toggleAttribute("hidden", !text);
    line.classList.toggle("cji-error", !!text && error);
  }

  /**
   * Disable the footer buttons while the analysis runs. The Cancel button of the analysis is shown only while a
   * cancellable (PDF) analysis runs.
   */
  #setButtons(enabled, { cancellable = false } = {}) {
    // The file field too: the result must be the one of the file shown
    const file = this.element?.querySelector("input[name=sourceFile]");
    if ( file ) file.disabled = !enabled;
    this.element?.querySelectorAll("footer button").forEach(button => {
      if ( button.dataset.action === "cancelAnalysis" ) {
        button.hidden = enabled || !cancellable;
        button.disabled = false;
      } else button.disabled = !enabled;
    });
  }

  static async #onCancelAnalysis() {
    if ( !this.#abort ) return;
    this.#status(t("Progress.cancelling"));
    this.#abort.abort();
  }

  static async #onUseExisting(event, target) {
    if ( !target.dataset.pack ) return;
    this.#readState();
    this.#state.targetPack = target.dataset.pack;
    await this.render({ parts: ["target"] });
  }

  // Form changes

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
    // A disabled checkbox is not part of the form: keep the last choice
    const { enrich, useCompendiums } = this.form.elements;
    if ( !enrich.disabled ) s.enrich = !!data.enrich;
    if ( !useCompendiums.disabled ) s.useCompendiums = !!data.useCompendiums;
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
        // A PDF is read by pdf.js at analysis time (200 MB decoded as text would be wasted)
        this.#fileText = (this.#file && !this.#isPdf()) ? this.#readFile() : null;
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
      case "enrich":
        this.form.elements.useCompendiums.disabled = !s.enrich;
        this.#preload();
        break;
      case "useCompendiums":
        this.#preload();
        break;
      case "targetPack":
        this.form.querySelectorAll(".cji-new-pack").forEach(el => el.toggleAttribute("hidden", s.targetPack !== "new"));
        break;
    }
    if ( ["newPackLabel", "newPackName", "targetPack"].includes(target.name) ) this.#showTargetProblem();
  }

  #onConflictChange(target) {
    const boxes = Array.from(this.element.querySelectorAll("input[name=conflictSelected]"));
    if ( target.name === "selectAll" ) boxes.forEach(box => { box.checked = target.checked; });
    else if ( target.name !== "conflictSelected" ) return;
    const all = this.element.querySelector("input[name=selectAll]");
    if ( all ) all.checked = boxes.length > 0 && boxes.every(box => box.checked);
    this.render({ parts: ["footer"] });
  }

  // Step 1: analysis

  static async #onSubmit() {
    if ( this.#analyzing ) return;
    this.#analyzing = true;
    this.#setButtons(false, { cancellable: this.#isPdf() });
    this.#status(null);
    try {
      await this.#analyze();
    } catch(err) {
      console.error(`${MODULE_ID} | analysis failed`, err);
      this.#fail("Error.AnalysisFailed", { message: err.message });
    } finally {
      this.#analyzing = false;
      this.#abort = null;
      if ( this.#step === "choose" ) {
        // Back to a usable form: buttons on, the progress line gone, an error (if any) left in place
        this.#setButtons(true);
        if ( !this.element?.querySelector(".cji-status.cji-error") ) this.#status(null);
      }
    }
  }

  /** Notify and show the message in the window. */
  #fail(key, data) {
    const message = t(key, data);
    ui.notifications.error(message);
    this.#status(message, { error: true });
  }

  async #analyze() {
    if ( !game.user.isGM ) return this.#fail("Error.NotGM");
    this.#readState();
    const s = this.#state;
    const filterType = TYPE_FILTERS[s.typeFilter];
    if ( filterType ) s.newPackType = filterType;
    // The target is checked before anything else: a taken name is shown next to the field, not as a failure
    if ( this.#showTargetProblem() ) return;
    const existing = s.targetPack === "new" ? null : game.packs.get(s.targetPack);
    if ( existing && filterType && (existing.documentName !== filterType) ) {
      return this.#fail("Error.PackType", { pack: existing.metadata.label, type: filterType });
    }
    const { pack, newPackSpec, errors } = resolveTarget(s);
    if ( errors.length ) {
      errors.forEach(error => ui.notifications.error(reasonText(error)));
      return this.#status(errors.map(reasonText).join(" "), { error: true });
    }
    if ( !this.#file ) return this.#fail("Error.NoFile");
    const documentName = pack ? pack.documentName : newPackSpec.type;
    const onProgress = ({ stage, done, total, name }) => this.#status(t(`Progress.${stage}`, { done, total, name }));
    let parsed;
    if ( this.#isPdf() ) {
      this.#abort = new AbortController();
      try {
        parsed = await extractFromPdf(this.#file, {
          fileName: this.#file.name, documentName, signal: this.#abort.signal, onProgress, ai: aiConfig()
        });
      } catch(err) {
        if ( err instanceof PdfImportError ) {
          if ( err.code === "aborted" ) return this.#status(null);
          return this.#fail(`Error.Pdf.${err.code}`, { message: err.message, ...(err.data ?? {}) });
        }
        throw err;
      }
    } else {
      try {
        parsed = parseImportFile(await (this.#fileText ??= this.#readFile()), this.#file.name);
      } catch(err) {
        if ( err instanceof ImportFormatError ) return this.#fail(`Error.Format.${err.code}`, { line: err.line });
        throw err;
      }
    }
    const warnings = [];
    if ( parsed.meta?.docType && (parsed.meta.docType !== documentName) ) {
      warnings.push(t("Warning.DocType", { file: parsed.meta.docType, pack: documentName }));
      ui.notifications.warn(warnings.at(-1));
    }
    const idGen = () => foundry.utils.randomID();
    const migrationData = await loadMigrationData();
    const enrich = s.enrich && !!(await loadParser());
    const result = await analyzeEntries(parsed.entries, documentName,
      { migrationData, idGen, enrich, compendiums: enrich && s.useCompendiums, onProgress });
    const documents = [...result.accepted, ...result.other.map(o => {
      const data = o.data ?? o;
      return { data, name: o.name ?? data.name, type: o.type ?? data.type };
    })];
    onProgress({ stage: "checking" });
    const index = pack ? await pack.getIndex({ fields: ["name", "type"] }) : [];
    const plan = planImport(documents.map(d => d.data), index,
      { overwrite: s.overwrite, stripIds: s.stripIds, hasPack: !!pack, idGen });
    if ( plan.duplicateIds.length ) return this.#fail("Error.DuplicateIds", { ids: plan.duplicateIds.join(", ") });
    documents.forEach((d, i) => { d.data = plan.documents[i]; });
    const conflicts = documents.filter(d => plan.conflictIds.has(d.data._id)).map(d => ({
      id: d.data._id, name: d.name, type: d.type, existing: index.get(d.data._id)?.name ?? d.data._id
    }));
    this.#analysis = {
      pack, newPackSpec, accepted: result.accepted, rejected: result.rejected, other: result.other, enrichment: result.enrichment,
      documents, overwriteIds: plan.overwriteIds, conflictIds: plan.conflictIds, conflicts, warnings,
      pdf: parsed.report ?? null
    };
    await saveChoices(s);
    this.#step = "review";
    await this.render();
  }

  // Step 2: confirmation

  static async #onBack() {
    this.#step = "choose";
    this.#analysis = null;
    await this.render();
  }

  static async #onConfirm() {
    if ( !game.user.isGM ) return this.#fail("Error.NotGM");
    const a = this.#analysis;
    if ( !a || this.#busy ) return;
    const selected = this.#selectedConflicts();
    const action = this.element.querySelector("[name=conflictAction]")?.value ?? "replace";
    const { toCreate, deleteIds, ignored } = applyConflictChoices(a.documents.map(doc => doc.data), a,
      { selected, action, idGen: () => foundry.utils.randomID() });
    this.#busy = true;
    let result;
    try {
      result = await runImport({ pack: a.pack, newPackSpec: a.newPackSpec, documents: toCreate, deleteIds });
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

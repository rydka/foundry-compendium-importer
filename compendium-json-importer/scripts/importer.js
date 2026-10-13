export const MODULE_ID = "compendium-json-importer";

export class CompendiumJsonImporter extends FormApplication {
  constructor(...args) {
    super(...args);
    this._file = null;
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "compendium-json-importer",
      title: "Compendium JSON Importer",
      template: "modules/compendium-json-importer/templates/importer.html",
      width: 560,
      height: "auto",
      closeOnSubmit: false
    });
  }

  getData() {
    let docTypes = Object.keys(game.documentTypes ?? {}).sort();
    if (!docTypes.length) {
      docTypes = ["Actor", "Item", "JournalEntry", "RollTable", "Scene", "Macro"];
    }

    const packs = game.packs
      .filter((p) => p.documentName)
      .map((p) => {
        const label = p.metadata?.label ?? p.metadata?.name ?? p.collection;
        return {
          id: p.collection,
          label: `${label} (${p.collection})`,
          documentName: p.documentName
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label));

    return {
      packs,
      docTypes,
      targetPack: game.settings.get(MODULE_ID, "lastTargetPack") || "new",
      newPackType: game.settings.get(MODULE_ID, "lastDocType") || "Item",
      overwrite: game.settings.get(MODULE_ID, "lastOverwrite"),
      stripIds: game.settings.get(MODULE_ID, "lastStripIds"),
      newPackLabel: "",
      newPackName: ""
    };
  }

  activateListeners(html) {
    super.activateListeners(html);

    const fileInput = html.find('input[name="sourceFile"]')[0];
    const fileName = html.find(".file-name");
    if (fileInput) {
      fileInput.addEventListener("change", (event) => {
        this._file = event.target.files?.[0] ?? null;
        fileName.text(this._file ? this._file.name : "No file selected.");
        if (!this._file) return;

        const base = this._file.name.replace(/\.(json|db)$/i, "");
        const labelInput = html.find('input[name="newPackLabel"]');
        const nameInput = html.find('input[name="newPackName"]');
        if (!labelInput.val()) labelInput.val(base);
        if (!nameInput.val()) nameInput.val(slugify(base));
      });
    }

    const packSelect = html.find('select[name="targetPack"]');
    const toggleNewPack = () => {
      const isNew = packSelect.val() === "new";
      html.find(".new-pack").toggle(isNew);
    };
    packSelect.on("change", toggleNewPack);
    toggleNewPack();
  }

  async _updateObject(event, formData) {
    if (!game.user.isGM) return ui.notifications.warn("GM only.");
    if (!this._file) return ui.notifications.error("Select a .json or .db file.");

    const overwrite = !!formData.overwrite;
    const stripIds = !!formData.stripIds;

    const pack = await this._resolveTargetPack(formData);
    if (!pack) return;

    let parsed;
    try {
      parsed = await this._loadEntries(this._file);
    } catch (err) {
      console.error(err);
      return ui.notifications.error(`Import failed: ${err.message ?? err}`);
    }

    if (!parsed.entries.length) {
      return ui.notifications.warn("No entries found in file.");
    }

    if (parsed.meta?.docType && pack.documentName && parsed.meta.docType !== pack.documentName) {
      ui.notifications.warn(`File type is ${parsed.meta.docType} but pack type is ${pack.documentName}.`);
    }

    const entries = parsed.entries
      .filter((e) => e && typeof e === "object")
      .map((e) => foundry.utils.deepClone(e));

    if (stripIds) {
      for (const entry of entries) stripIdsDeep(entry);
    }
    for (const entry of entries) ensureActivityIdsDeep(entry);

    const index = await pack.getIndex({ fields: ["name", "type"] });
    const removedCount = overwrite ? await deleteExisting(pack, index, entries) : 0;

    const createdCount = await createInBatches(pack, entries, 50);

    game.settings.set(MODULE_ID, "lastTargetPack", formData.targetPack);
    game.settings.set(MODULE_ID, "lastDocType", formData.newPackType);
    game.settings.set(MODULE_ID, "lastOverwrite", overwrite);
    game.settings.set(MODULE_ID, "lastStripIds", stripIds);

    ui.notifications.info(
      `Imported ${createdCount} entries into ${pack.metadata?.label ?? pack.collection}.` +
      (removedCount ? ` Removed ${removedCount} existing entries.` : "")
    );
    this.close();
  }

  async _resolveTargetPack(formData) {
    const targetPack = formData.targetPack;
    if (targetPack && targetPack !== "new") {
      const pack = game.packs.get(targetPack);
      if (!pack) ui.notifications.error(`Pack not found: ${targetPack}`);
      return pack ?? null;
    }

    const label = String(formData.newPackLabel ?? "").trim();
    const type = String(formData.newPackType ?? "").trim();
    let name = String(formData.newPackName ?? "").trim();
    if (!name) name = slugify(label);

    if (!label) return ui.notifications.error("New pack label is required.");
    if (!name) return ui.notifications.error("New pack name is required.");
    if (!type) return ui.notifications.error("Document type is required.");

    const packId = `world.${name}`;
    if (game.packs.get(packId)) {
      return ui.notifications.error(`Pack already exists: ${packId}`);
    }

    await CompendiumCollection.createCompendium({
      label,
      name,
      type,
      system: game.system.id
    });
    return game.packs.get(packId);
  }

  async _loadEntries(file) {
    const contents = await readFileText(file);
    const lower = file.name.toLowerCase();

    if (lower.endsWith(".db")) {
      return parseDb(contents);
    }

    const data = JSON.parse(contents);
    return parseJson(data);
  }
}

Hooks.once("init", () => {
  game.settings.registerMenu(MODULE_ID, "importer", {
    name: "Compendium JSON Importer",
    label: "Open Importer",
    hint: "Import compendium entries from JSON or DB files.",
    icon: "fas fa-file-import",
    type: CompendiumJsonImporter,
    restricted: true
  });

  game.settings.register(MODULE_ID, "lastTargetPack", {
    scope: "client",
    config: false,
    type: String,
    default: "new"
  });
  game.settings.register(MODULE_ID, "lastDocType", {
    scope: "client",
    config: false,
    type: String,
    default: "Item"
  });
  game.settings.register(MODULE_ID, "lastOverwrite", {
    scope: "client",
    config: false,
    type: Boolean,
    default: true
  });
  game.settings.register(MODULE_ID, "lastStripIds", {
    scope: "client",
    config: false,
    type: Boolean,
    default: true
  });
});

function slugify(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 64);
}

function lcName(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function stripIdsDeep(data) {
  if (!data || typeof data !== "object") return;
  if (Array.isArray(data)) {
    for (const entry of data) stripIdsDeep(entry);
    return;
  }
  delete data._id;
  for (const value of Object.values(data)) {
    stripIdsDeep(value);
  }
}

function ensureActivityIdsDeep(data) {
  if (!data || typeof data !== "object") return;
  if (Array.isArray(data)) {
    for (const entry of data) ensureActivityIdsDeep(entry);
    return;
  }

  const system = data.system;
  const activities = system?.activities;
  if (activities && typeof activities === "object") {
    if (Array.isArray(activities)) {
      const rebuilt = {};
      for (const activity of activities) {
        if (!activity || typeof activity !== "object") continue;
        const id = activity._id || activity.id || foundry.utils.randomID();
        activity._id = id;
        rebuilt[id] = activity;
      }
      system.activities = rebuilt;
    } else {
      const entries = Object.entries(activities);
      for (const [key, activity] of entries) {
        if (!activity || typeof activity !== "object") continue;
        const id = activity._id || activity.id || key || foundry.utils.randomID();
        activity._id = id;
        if (key !== id) {
          delete activities[key];
          activities[id] = activity;
        }
      }
    }
  }

  for (const value of Object.values(data)) {
    ensureActivityIdsDeep(value);
  }
}

async function readFileText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file."));
    reader.readAsText(file);
  });
}

function parseDb(contents) {
  const lines = contents.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const entries = [];
  for (const line of lines) {
    entries.push(JSON.parse(line));
  }
  return { entries, meta: {} };
}

function parseJson(data) {
  if (Array.isArray(data)) return { entries: data, meta: {} };
  if (data && typeof data === "object") {
    if (Array.isArray(data.entries)) {
      return {
        entries: data.entries,
        meta: {
          docType: data.type ?? data.documentName,
          packName: data.name ?? "",
          packLabel: data.label ?? ""
        }
      };
    }
    if (Array.isArray(data.documents)) return { entries: data.documents, meta: {} };
    if (Array.isArray(data.items)) return { entries: data.items, meta: {} };
    if (Array.isArray(data.data)) return { entries: data.data, meta: {} };
  }
  return { entries: [], meta: {} };
}

async function deleteExisting(pack, index, entries) {
  const byKey = new Map();
  const byName = new Map();
  for (const doc of index) {
    const nameKey = lcName(doc.name);
    const typeKey = String(doc.type ?? "");
    if (nameKey) {
      byKey.set(`${nameKey}::${typeKey}`, doc._id);
      if (!byName.has(nameKey)) byName.set(nameKey, doc._id);
    }
  }

  const ids = new Set();
  for (const entry of entries) {
    const nameKey = lcName(entry.name);
    const typeKey = String(entry.type ?? "");
    if (!nameKey) continue;
    let id = byKey.get(`${nameKey}::${typeKey}`);
    if (!id) id = byName.get(nameKey);
    if (id) ids.add(id);
  }

  if (!ids.size) return 0;
  await pack.documentClass.deleteDocuments(Array.from(ids), { pack: pack.collection });
  return ids.size;
}

async function createInBatches(pack, entries, batchSize) {
  let created = 0;
  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, i + batchSize);
    const docs = await pack.documentClass.createDocuments(batch, { pack: pack.collection });
    created += Array.isArray(docs) ? docs.length : 0;
  }
  return created;
}

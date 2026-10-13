/** Error raised for an unreadable import file. `code` is one of empty, invalidJson, invalidLine, noDocuments. */
export class ImportFormatError extends Error {
  constructor(code, line = null, detail = "") {
    super(`${code}${line ? ` (line ${line})` : ""}${detail ? `: ${detail}` : ""}`);
    this.name = "ImportFormatError";
    this.code = code;
    this.line = line;
  }
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function parseDb(text) {
  const entries = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    try {
      entries.push(JSON.parse(line));
    } catch (err) {
      throw new ImportFormatError("invalidLine", i + 1, err.message);
    }
  });
  return { entries, meta: {} };
}

function parseJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new ImportFormatError("invalidJson", null, err.message);
  }
  if (Array.isArray(data)) return { entries: data, meta: {} };
  if (isObject(data)) {
    if (Array.isArray(data.entries)) {
      return {
        entries: data.entries,
        meta: { docType: data.type ?? data.documentName, packName: data.name, packLabel: data.label }
      };
    }
    for (const key of ["documents", "items", "data"]) {
      if (Array.isArray(data[key])) return { entries: data[key], meta: {} };
    }
  }
  return { entries: [], meta: {} };
}

/**
 * Read the text of a .db (one JSON document per line) or .json file.
 * @param {string} text
 * @param {string} fileName
 * @returns {{entries: object[], meta: {docType?: string, packName?: string, packLabel?: string}}}
 */
export function parseImportFile(text, fileName) {
  const clean = String(text ?? "").replace(/^\uFEFF/, "");
  if (!clean.trim()) throw new ImportFormatError("empty");
  const result = /\.db$/i.test(String(fileName ?? "")) ? parseDb(clean) : parseJson(clean);
  result.entries = result.entries.filter(isObject);
  if (!result.entries.length) throw new ImportFormatError("noDocuments");
  return result;
}

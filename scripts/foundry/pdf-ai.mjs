import { MODULE_ID } from "../constants.mjs";
import { chat, warmUp } from "../core/ai/ollama.mjs";
import { buildBlockRequest, validateAiBlock } from "../core/pdf/ai-block.mjs";
import { toActorSource } from "../core/pdf/creature.mjs";
import { hasRequiredStats, parseSizeLine, parseStatLines } from "../core/pdf/stat-lines.mjs";

/**
 * Local AI (Ollama) for the blocks the rules could not read (C5). One request at a time, a warm-up before the
 * first, two consecutive unreachable or timed-out requests stop the rest. The stat lines the rules read (CR,
 * senses, languages, saves, skills, traits) always win over the answer; the texts come from the source.
 */

const RULE_FAILURES = new Set(["noTitle", "missingStats", "noEntries", "fontUnknown"]);
const MAX_FAILURES = 2;

/** Replace (or remove, when `reason` is null) the problem of a block. */
function setProblem(extraction, job, reason, detail = null) {
  const index = extraction.problems.findIndex(p => (p.name === job.name) && (p.page === job.page) && RULE_FAILURES.has(p.reason));
  if ( index >= 0 ) extraction.problems.splice(index, 1);
  if ( reason ) extraction.problems.push({ name: job.name, page: job.page, reason, detail });
}

function setBlockStatus(extraction, job, status) {
  const block = extraction.blocks.find(b => (b.name === job.name) && (b.page === job.page));
  if ( block ) block.status = status;
}

/**
 * Submit the queued blocks to the local AI and add the accepted actors to the extraction.
 * @param {object} extraction  Result of `extractDocument` (modified in place: `actors`, `blocks`, `problems`).
 * @param {{ai: {url: string, model: string, timeoutMs: number}, parser: object, fileName: string,
 *   signal?: AbortSignal, onProgress?: Function, fetch?: Function}} ctx
 * @returns {Promise<void>}
 */
export async function readBlocksWithAi(extraction, { ai, parser, fileName, signal, onProgress, fetch = globalThis.fetch.bind(globalThis) }) {
  const queue = extraction.aiQueue;
  const options = { fetch, signal, timeoutMs: ai.timeoutMs };
  let failures = 0;
  let stopped = false;
  let warmed = false;
  for ( const [i, job] of queue.entries() ) {
    if ( signal?.aborted ) return;
    onProgress?.({ stage: "pdfAi", done: i + 1, total: queue.length, name: job.name });
    if ( stopped ) { setProblem(extraction, job, "aiUnreachable"); continue; }
    if ( !warmed ) {
      await warmUp(ai.url, ai.model, options);
      warmed = true;
    }
    const answer = await chat(ai.url, buildBlockRequest(job.lines, { model: ai.model }), options);
    if ( !answer.ok ) {
      if ( answer.status === "aborted" ) return;
      const transient = ["unreachable", "timeout"].includes(answer.status);
      failures = transient ? failures + 1 : 0;
      if ( failures >= MAX_FAILURES ) stopped = true;
      setProblem(extraction, job, answer.status === "timeout" ? "aiTimeout" : "aiUnreachable", { status: answer.status, error: answer.error ?? null });
      console.warn(`${MODULE_ID} | local AI failed on ${job.name} (p. ${job.page})`, answer);
      continue;
    }
    failures = 0;
    const { stats: aiStats, entries, rejected, firstEntryLine } = validateAiBlock(answer.json, job.lines);
    // The rules win for every stat line they read (the lines before the first entry)
    const ruleStats = parseStatLines(job.lines.slice(0, firstEntryLine), { toFeet: parser.toFeet });
    const merged = { ...ruleStats };
    for ( const key of ["ac", "hp", "speed", "abilities", "senses", "cr"] ) merged[key] = ruleStats[key] ?? aiStats[key];
    if ( !hasRequiredStats(merged) || !entries.length ) {
      const fields = ["ac", "hp", "speed", "abilities"].filter(k => !merged[k]);
      if ( !entries.length ) fields.push("entries");
      setProblem(extraction, job, "aiRejected", { fields: fields.join(", "), rejected });
      continue;
    }
    const block = { title: job.name, page: job.page, features: [], actions: [], bonus: [], reactions: [], legendary: [] };
    for ( const entry of entries ) block[entry.sectionKey].push({ name: entry.name, meta: entry.meta, text: entry.text });
    const sizeText = job.block?.sizeLine?.text ?? job.lines.find(l => parseSizeLine(l)) ?? "";
    const actor = toActorSource(block, merged, { parser, source: fileName, page: job.page, rank: job.rank ?? 0, readBy: "ai", size: parseSizeLine(sizeText) });
    extraction.actors.push(actor);
    setBlockStatus(extraction, job, "ai");
    setProblem(extraction, job, null);
    if ( rejected.length ) {
      extraction.problems.push({ name: job.name, page: job.page, reason: "aiPartial", detail: { fields: rejected.map(r => r.field).join(", "), rejected } });
    }
  }
}

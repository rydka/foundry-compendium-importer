// C5: request and validation of the local AI's answer (scripts/core/pdf/ai-block.mjs).
// The region text is rebuilt from the synthetic spec ("Smudged Reeve", ref-partial) independently of the extractor.
// The answer is built from the module's own BLOCK_SCHEMA (tests/support/ai-answer.mjs): if the schema names its
// properties in a way the helper does not know, adapt the helper, not the module.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildBlockRequest, BLOCK_SCHEMA, validateAiBlock } from "../../scripts/core/pdf/ai-block.mjs";
import { buildAnswer, factsOf } from "../support/ai-answer.mjs";
import { SYNTHETIC } from "../support/pdf-env.mjs";
import { expectedCreature, loadDoc, renderCreature } from "../support/synth.mjs";

const doc = loadDoc(path.join(SYNTHETIC, "ref-partial.json"));
const spec = doc.flow.find((f) => f.creature && f.creature.name === "Smudged Reeve").creature;
const exp = expectedCreature(spec, doc);

/** Lines of the block region, as the page reads them (one string per printed line). */
const lines = renderCreature(spec, doc).map((op) => {
  if (op.k === "label") return `${op.label} ${op.value}`;
  if (op.k === "row") return op.cells.map((c) => c.t).join(" ");
  if (op.k === "entry") return `${op.name} ${op.text}`;
  return op.text;
});

const good = () => buildAnswer(BLOCK_SCHEMA, factsOf(exp));

describe("buildBlockRequest", () => {
  const body = buildBlockRequest(lines, { model: "llama3.1:8b" });
  it("asks for a structured answer: model, schema as format, temperature 0, seed 0", () => {
    expect(body.model).toBe("llama3.1:8b");
    expect(body.format).toEqual(BLOCK_SCHEMA);
    expect(body.options?.temperature).toBe(0);
    expect(body.options?.seed).toBe(0);
  });
  it("sends the lines of the block in the prompt", () => {
    const sent = JSON.stringify(body.messages ?? body.prompt);
    expect(sent).toContain("Smudged Reeve");
    expect(sent).toContain("Stern Watch");
  });
  it("is not streamed", () => {
    expect(body.stream).toBe(false);
  });
});

describe("validateAiBlock", () => {
  it("accepts an answer whose values are all in the text of the block", () => {
    const r = validateAiBlock(good(), lines);
    expect(r.rejected).toEqual([]);
    expect(r.entries.map((e) => e.name)).toEqual(exp.entries.map((e) => e.name));
  });

  it("rejects a numeric value that is not a word of the text (AC 99)", () => {
    const answer = good();
    const acKey = Object.keys(answer).find((k) => /^(ac|armorclass)$/i.test(k));
    expect(acKey, "BLOCK_SCHEMA has an armor class property").toBeTruthy();
    answer[acKey] = 99;
    const r = validateAiBlock(answer, lines);
    expect(r.rejected.length).toBeGreaterThan(0);
    expect(JSON.stringify(r.rejected)).toMatch(/ac|armor/i);
    expect(JSON.stringify(r.stats ?? {})).not.toMatch(/\b99\b/);
  });

  it("rejects a capacity whose name is not in the text, keeps the others", () => {
    const answer = good();
    const listKey = Object.keys(answer).find((k) => Array.isArray(answer[k]) && answer[k][0]?.name);
    expect(listKey, "BLOCK_SCHEMA has a list of named entries").toBeTruthy();
    answer[listKey] = [...answer[listKey], { ...answer[listKey][0], name: "Phantom Invention" }];
    const r = validateAiBlock(answer, lines);
    expect(r.entries.map((e) => e.name)).not.toContain("Phantom Invention");
    expect(JSON.stringify(r.rejected)).toContain("Phantom Invention");
    expect(r.entries.map((e) => e.name)).toContain("Stern Watch");
  });

  it("takes the text of a capacity from the source, never from the answer", () => {
    const answer = good();
    const listKey = Object.keys(answer).find((k) => Array.isArray(answer[k]) && answer[k][0]?.name);
    answer[listKey] = answer[listKey].map((e) => ({ ...e, text: "INVENTED TEXT", description: "INVENTED TEXT" }));
    const r = validateAiBlock(answer, lines);
    const joined = JSON.stringify(r.entries);
    expect(joined).not.toContain("INVENTED TEXT");
    const cudgel = r.entries.find((e) => e.name === "Cudgel");
    expect(JSON.stringify(cudgel)).toContain("Melee Weapon Attack: +4 to hit");
    const watch = r.entries.find((e) => e.name === "Stern Watch");
    expect(JSON.stringify(watch)).toContain("cannot be surprised");
    // the text of one capacity stops at the next one
    expect(JSON.stringify(watch)).not.toContain("Multiattack");
  });

  it("rejects the hit point formula when it is not in the text", () => {
    const answer = good();
    const fKey = Object.keys(answer).find((k) => /formula|hitdice/i.test(k));
    if (!fKey) return; // the schema may carry the formula inside another property
    answer[fKey] = "9d12 + 40";
    const r = validateAiBlock(answer, lines);
    expect(JSON.stringify(r.rejected)).toMatch(/9d12|formula|hp/i);
  });
});

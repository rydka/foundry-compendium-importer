// C13, C23: "Strip _ids" renumbers everything and rewrites internal references.
import { describe, expect, it } from "vitest";
import { remapIds } from "../../scripts/core/ids.mjs";
import { ACTIVITY_LINK_IDS, buildActivityLink, makeIdGen } from "../fixtures/generate.mjs";

function collect(value, out = []) {
  if (Array.isArray(value)) value.forEach((v) => collect(v, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k === "_id") out.push(v);
      collect(v, out);
    }
  }
  return out;
}

const sample = () => ({
  _id: "actorAAAAAAAAAA1",
  name: "Boss",
  type: "npc",
  system: {},
  items: [{
    _id: "itemBBBBBBBBBBB1", name: "Ring", type: "equipment",
    system: { activities: { actvCCCCCCCCCC01: { _id: "actvCCCCCCCCCC01", type: "save", effects: [{ _id: "effcDDDDDDDDDD01" }] } } },
    effects: [{ _id: "effcDDDDDDDDDD01", name: "Burn" }]
  }],
  effects: [{ _id: "effcEEEEEEEEEE01", name: "Aura" }]
});

describe("remapIds: renumbering (C13)", () => {
  it("replaces every _id of the document, nested items and effects", () => {
    const out = remapIds(sample(), makeIdGen(1));
    const old = ["actorAAAAAAAAAA1", "itemBBBBBBBBBBB1", "effcDDDDDDDDDD01", "effcEEEEEEEEEE01", "actvCCCCCCCCCC01"];
    const ids = collect(out);
    expect(ids.length).toBeGreaterThanOrEqual(5);
    for (const id of ids) expect(old).not.toContain(id);
    expect(JSON.stringify(out)).not.toMatch(/actorAAAAAAAAAA1|itemBBBBBBBBBBB1|effcDDDDDDDDDD01|effcEEEEEEEEEE01|actvCCCCCCCCCC01/);
  });

  it("renumbers the keys of system.activities and keeps them equal to the activity _id", () => {
    const out = remapIds(sample(), makeIdGen(2));
    const activities = out.items[0].system.activities;
    const [key, activity] = Object.entries(activities)[0];
    expect(key).not.toBe("actvCCCCCCCCCC01");
    expect(activity._id).toBe(key);
  });

  it("uses the same new id everywhere an old id appeared", () => {
    const out = remapIds(sample(), makeIdGen(3));
    const effectId = out.items[0].effects[0]._id;
    expect(out.items[0].system.activities[Object.keys(out.items[0].system.activities)[0]].effects[0]._id).toBe(effectId);
  });

  it("keeps ids unique among distinct old ids", () => {
    const ids = collect(remapIds(sample(), makeIdGen(4)));
    const distinctOld = 4; // actor, item, effect D, effect E (the activity key is counted via its _id)
    expect(new Set(ids).size).toBeGreaterThanOrEqual(distinctOld);
  });

  it("keeps all non-id data untouched", () => {
    const out = remapIds(sample(), makeIdGen(5));
    expect(out.name).toBe("Boss");
    expect(out.items[0].name).toBe("Ring");
    expect(out.items[0].effects[0].name).toBe("Burn");
    expect(out.effects[0].name).toBe("Aura");
  });

  it("does not rewrite ordinary strings that merely look similar", () => {
    const data = { _id: "docAAAAAAAAAAA1", name: "docAAAAAAAAAAA1x", system: { description: { value: "see docAAAAAAAAAAA12" } } };
    const out = remapIds(data, makeIdGen(6));
    expect(out.name).toBe("docAAAAAAAAAAA1x");
    expect(out.system.description.value).toBe("see docAAAAAAAAAAA12");
  });
});

describe("remapIds: internal references (C23)", () => {
  it("rewrites activity -> effect links of the generated fixture", () => {
    const out = remapIds(buildActivityLink(), makeIdGen(8));
    const activity = Object.values(out.system.activities)[0];
    expect(out._id).not.toBe(ACTIVITY_LINK_IDS.item);
    expect(out.effects[0]._id).not.toBe(ACTIVITY_LINK_IDS.effect);
    expect(activity.effects[0]._id).toBe(out.effects[0]._id);
    expect(JSON.stringify(out)).not.toContain(ACTIVITY_LINK_IDS.effect);
    expect(JSON.stringify(out)).not.toContain(ACTIVITY_LINK_IDS.activity);
  });

  it("rewrites a reference that is a dotted path containing the old id", () => {
    const data = {
      _id: "itemBBBBBBBBBBB1", name: "X", type: "equipment",
      effects: [{ _id: "effcDDDDDDDDDD01", name: "Fx" }],
      flags: { dnd5e: { origin: "Item.itemBBBBBBBBBBB1.ActiveEffect.effcDDDDDDDDDD01" } }
    };
    const out = remapIds(data, makeIdGen(9));
    expect(out.flags.dnd5e.origin).toBe(`Item.${out._id}.ActiveEffect.${out.effects[0]._id}`);
  });

  it("rewrites a reference that is a bare id string (riders)", () => {
    const data = {
      _id: "itemBBBBBBBBBBB1", name: "X", type: "equipment",
      effects: [{ _id: "effcDDDDDDDDDD01", name: "Fx" }],
      system: { activities: { actvCCCCCCCCCC01: { _id: "actvCCCCCCCCCC01", type: "attack", riders: { effect: ["effcDDDDDDDDDD01"] } } } }
    };
    const out = remapIds(data, makeIdGen(10));
    const activity = Object.values(out.system.activities)[0];
    expect(activity.riders.effect).toEqual([out.effects[0]._id]);
  });

  it("leaves a document without ids or references intact", () => {
    const out = remapIds({ name: "Plain", system: { quantity: 1 } }, makeIdGen(11));
    expect(out).toMatchObject({ name: "Plain", system: { quantity: 1 } });
  });
});

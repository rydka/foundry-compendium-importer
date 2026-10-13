// Minimal stand-ins for the Foundry runtime globals used by unit tests.
// They only cover what modules commonly touch at load time; extend them per
// module as needed. Behaviour that depends on the real Foundry or dnd5e code
// belongs in integration tests, not here.
import { beforeEach, vi } from "vitest";

function createHooks() {
  const handlers = new Map();
  const add = (name, fn, once) => {
    if (!handlers.has(name)) handlers.set(name, []);
    handlers.get(name).push({ fn, once });
  };
  return {
    on: vi.fn((name, fn) => add(name, fn, false)),
    once: vi.fn((name, fn) => add(name, fn, true)),
    off: vi.fn(),
    callAll(name, ...args) {
      const list = handlers.get(name) ?? [];
      handlers.set(name, list.filter((h) => !h.once));
      for (const h of list) h.fn(...args);
      return true;
    },
    call(name, ...args) {
      const list = handlers.get(name) ?? [];
      handlers.set(name, list.filter((h) => !h.once));
      for (const h of list) if (h.fn(...args) === false) return false;
      return true;
    }
  };
}

function createSettings() {
  const defs = new Map();
  const values = new Map();
  const key = (ns, k) => `${ns}.${k}`;
  return {
    register: vi.fn((ns, k, def) => {
      defs.set(key(ns, k), def);
      values.set(key(ns, k), def.default);
    }),
    get: vi.fn((ns, k) => {
      if (!defs.has(key(ns, k))) throw new Error(`Setting ${key(ns, k)} is not registered`);
      return values.get(key(ns, k));
    }),
    set: vi.fn(async (ns, k, v) => {
      values.set(key(ns, k), v);
      return v;
    }),
    settings: defs
  };
}

export function installFoundryGlobals() {
  globalThis.Hooks = createHooks();
  globalThis.game = {
    system: { id: "dnd5e", version: "6.0.6" },
    version: "14.369",
    modules: new Map(),
    settings: createSettings(),
    i18n: { localize: vi.fn((k) => k), format: vi.fn((k) => k) },
    user: { isGM: true }
  };
  globalThis.ui = { notifications: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } };
  globalThis.CONFIG = { DND5E: {} };
}

beforeEach(() => {
  installFoundryGlobals();
  vi.resetModules();
});

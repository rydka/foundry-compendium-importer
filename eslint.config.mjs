import js from "@eslint/js";
import globals from "globals";

const foundryGlobals = {
  game: "readonly",
  ui: "readonly",
  canvas: "readonly",
  CONFIG: "readonly",
  CONST: "readonly",
  Hooks: "readonly",
  foundry: "readonly",
  dnd5e: "readonly",
  fromUuid: "readonly",
  fromUuidSync: "readonly",
  ChatMessage: "readonly",
  Roll: "readonly"
};

export default [
  { ignores: [".atelier/**", "tools/**", "dist/**", "node_modules/**"] },
  js.configs.recommended,
  {
    files: ["scripts/**/*.{js,mjs}"],
    ignores: ["scripts/core/**"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser, ...foundryGlobals }
    }
  },
  {
    // Pure core: ECMAScript built-ins only, so any Foundry or browser dependency fails the lint.
    files: ["scripts/core/**/*.mjs"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module", globals: {} }
  },
  {
    files: ["tests/**/*.{js,mjs}", "*.config.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node, ...foundryGlobals }
    }
  }
];

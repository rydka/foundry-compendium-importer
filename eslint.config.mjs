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
  { ignores: ["tools/**", "dist/**", "node_modules/**"] },
  js.configs.recommended,
  {
    files: ["scripts/**/*.{js,mjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser, ...foundryGlobals }
    }
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

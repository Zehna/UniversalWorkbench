import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

const nodeGlobals = {
  Buffer: "readonly",
  console: "readonly",
  process: "readonly",
  URL: "readonly",
};

const browserGlobals = {
  console: "readonly",
  document: "readonly",
  fetch: "readonly",
  window: "readonly",
};

export default tseslint.config(
  { ignores: ["**/dist/**", "**/coverage/**", "**/node_modules/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: [
      "**/*.mjs",
      "apps/server/**/*.ts",
      "packages/**/*.ts",
      "**/*.config.ts",
    ],
    languageOptions: { globals: nodeGlobals },
  },
  {
    files: ["apps/web/src/**/*.{ts,tsx}", "apps/web/test/**/*.{ts,tsx}"],
    languageOptions: { globals: browserGlobals },
  },
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
);

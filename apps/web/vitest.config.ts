import { configDefaults, defineProject } from "vitest/config";

export default defineProject({
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    exclude: [...configDefaults.exclude, "e2e/**"],
  },
});

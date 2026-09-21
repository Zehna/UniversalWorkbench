import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "@uw/contracts";
import { validateToolConfig } from "../src/config.js";

function definition(configSchema: ToolDefinition["configSchema"]): ToolDefinition {
  return {
    id: "test.config",
    version: "1",
    displayName: "Config",
    description: "Config validation fixture",
    executionMode: "worker",
    accepts: [],
    produces: [],
    configSchema,
    requiredCapabilities: [],
    defaults: { timeoutMs: 1_000, maxAttempts: 1 },
  };
}

describe("validateToolConfig", () => {
  it("accepts required string properties and string-valued maps", () => {
    const result = validateToolConfig(
      definition({
        type: "object",
        required: ["url"],
        additionalProperties: false,
        properties: {
          url: { type: "string", minLength: 1 },
          method: { type: "string", enum: ["GET", "POST"] },
          headers: {
            type: "object",
            additionalProperties: { type: "string" },
          },
        },
      }),
      {
        url: "https://example.test",
        method: "GET",
        headers: { accept: "application/json" },
      },
    );

    expect(result).toEqual({ ok: true, issues: [] });
  });

  it("rejects missing, extra, wrongly typed, and out-of-range values", () => {
    const result = validateToolConfig(
      definition({
        type: "object",
        required: ["title"],
        additionalProperties: false,
        properties: {
          title: { type: "string", minLength: 1, maxLength: 4 },
          mode: { type: "string", enum: ["a", "b"] },
        },
      }),
      { title: "", mode: "c", extra: true },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.path)).toEqual(
        expect.arrayContaining(["$.title", "$.mode", "$.extra"]),
      );
    }
  });

  it("compares enum objects and arrays by JSON value", () => {
    expect(
      validateToolConfig(
        definition({
          type: "object",
          required: ["shape"],
          properties: {
            shape: {
              enum: [{ values: [1, 2], enabled: true }],
            },
          },
        }),
        { shape: { enabled: true, values: [1, 2] } },
      ),
    ).toEqual({ ok: true, issues: [] });
  });
});

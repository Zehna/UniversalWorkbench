import { describe, expect, it } from "vitest";
import {
  AiResponsePayloadSchema,
  AiToolConfigSchema,
  ContextEnvelopeSchema,
  ContextTypeSchema,
  ExecutionUsageV2Schema,
  SecretRefSchema,
  isSecretLikeKey,
  migrateLegacyUsage,
  parseSecretRef,
} from "../src/index.js";

const CONTEXT_ID = "55555555-5555-4555-8555-555555555555";

function envelope(type: string, payload: unknown) {
  return {
    id: CONTEXT_ID,
    type,
    schemaVersion: 1,
    mimeType: "application/json",
    metadata: {},
    payload,
    provenance: { sourceContextIds: [] },
    capabilities: [],
  };
}

describe("phase 4 contracts", () => {
  it("parses an ai_response envelope", () => {
    const payload = {
      text: "hello",
      model: "gpt-4o-mini",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      usageSource: "provider",
    };
    const parsed = ContextEnvelopeSchema.parse(
      envelope("ai_response", payload),
    );
    expect(parsed.type).toBe("ai_response");
    expect(AiResponsePayloadSchema.parse(payload)).toEqual(payload);
  });

  it("keeps the five legacy context types parsing (backward compat)", () => {
    for (const t of [
      "text",
      "markdown",
      "json",
      "api_response",
      "artifact_ref",
    ]) {
      expect(ContextTypeSchema.parse(t)).toBe(t);
      expect(
        ContextEnvelopeSchema.safeParse(envelope(t, t === "json" ? {} : "x"))
          .success,
      ).toBe(true);
    }
  });

  it("accepts AiToolConfig text and json-schema variants", () => {
    const text = {
      providerId: "openai",
      model: "gpt-4o-mini",
      prompt: "summarize",
      secretRef: "secret://vault/openai",
      responseFormat: { kind: "text" },
    };
    expect(AiToolConfigSchema.parse(text)).toEqual(text);

    const json = {
      providerId: "openai",
      model: "gpt-4o-mini",
      prompt: "extract",
      secretRef: "secret://local/x",
      responseFormat: {
        kind: "json",
        jsonSchema: { type: "object", properties: { a: { type: "string" } } },
      },
      maxOutputTokens: 100,
      timeoutMs: 30000,
    };
    expect(AiToolConfigSchema.parse(json)).toEqual(json);
  });

  it("rejects secretRef without secret:// prefix", () => {
    const bad = {
      providerId: "openai",
      model: "m",
      prompt: "p",
      secretRef: "openai-key",
    };
    expect(AiToolConfigSchema.safeParse(bad).success).toBe(false);
    expect(SecretRefSchema.safeParse("openai-key").success).toBe(false);
    expect(SecretRefSchema.safeParse("https://vault/x").success).toBe(false);
  });

  it("rejects json format without jsonSchema", () => {
    const bad = {
      providerId: "openai",
      model: "m",
      prompt: "p",
      secretRef: "secret://vault/k",
      responseFormat: { kind: "json" },
    };
    expect(AiToolConfigSchema.safeParse(bad).success).toBe(false);
  });

  it("requires non-negative integer token fields on ExecutionUsageV2", () => {
    const good = {
      attempts: 1,
      inputBytes: 10,
      outputBytes: 20,
      promptTokens: 5,
      completionTokens: 7,
      totalTokens: 12,
    };
    expect(ExecutionUsageV2Schema.parse(good)).toEqual(good);
    expect(
      ExecutionUsageV2Schema.safeParse({ ...good, promptTokens: -1 }).success,
    ).toBe(false);
    expect(
      ExecutionUsageV2Schema.safeParse({ ...good, totalTokens: 1.5 }).success,
    ).toBe(false);
  });

  it("migrates legacy usage with zero tokens", () => {
    expect(
      migrateLegacyUsage({ attempts: 2, inputBytes: 9, outputBytes: 4 }),
    ).toEqual({
      attempts: 2,
      inputBytes: 9,
      outputBytes: 4,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    });
  });

  it("parses secret refs and detects secret-like keys", () => {
    expect(parseSecretRef("secret://vault/openai")).toEqual({
      scope: "vault",
      name: "openai",
    });
    expect(parseSecretRef("secret://local/x")).toEqual({
      scope: "local",
      name: "x",
    });
    expect(() => parseSecretRef("https://x")).toThrow();
    expect(isSecretLikeKey("apiKey")).toBe(true);
    expect(isSecretLikeKey("Authorization")).toBe(true);
    expect(isSecretLikeKey("model")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  isSecretLikeKey,
  parseSecretRef,
  redactSecrets,
} from "../src/index.js";

describe("secret reference core", () => {
  it("parses secret://vault/openai", () => {
    expect(parseSecretRef("secret://vault/openai")).toEqual({
      scope: "vault",
      name: "openai",
    });
  });

  it("parses secret://local/x scope", () => {
    expect(parseSecretRef("secret://local/x")).toEqual({
      scope: "local",
      name: "x",
    });
  });

  it("rejects https:// URLs", () => {
    expect(() => parseSecretRef("https://vault/x")).toThrow();
  });

  it("rejects empty name", () => {
    expect(() => parseSecretRef("secret://vault/")).toThrow();
    expect(() => parseSecretRef("secret://vault")).toThrow();
  });

  it("rejects uppercase scope", () => {
    expect(() => parseSecretRef("secret://VAULT/openai")).toThrow();
    expect(() => parseSecretRef("secret://Vault/openai")).toThrow();
  });

  it("rejects path traversal", () => {
    expect(() => parseSecretRef("secret://vault/../etc")).toThrow();
    expect(() => parseSecretRef("secret://vault/a/b")).toThrow();
  });

  it("enforces Vault name limit: 128 chars pass, 129 chars fail (regression)", () => {
    const okName = "a".repeat(128);
    const tooLong = "a".repeat(129);
    expect(parseSecretRef(`secret://vault/${okName}`)).toEqual({
      scope: "vault",
      name: okName,
    });
    expect(() => parseSecretRef(`secret://vault/${tooLong}`)).toThrow();
    expect(() => parseSecretRef(`secret://local/${tooLong}`)).toThrow();
  });
});

describe("redactSecrets", () => {
  it("replaces apiKey/Authorization values while leaving model/prompt intact", () => {
    const input = {
      model: "gpt-4o-mini",
      prompt: "summarize this",
      apiKey: "sk-live-secret-value",
    };
    const out = redactSecrets(input) as Record<string, unknown>;
    expect(out["apiKey"]).toBe("[REDACTED]");
    expect(out["model"]).toBe("gpt-4o-mini");
    expect(out["prompt"]).toBe("summarize this");
  });

  it("removes credentials, Authorization and api key variants", () => {
    const input = {
      authorization: "Bearer sk-abc123",
      Authorization: "Bearer sk-abc123",
      api_key: "key-1",
      "api-key": "key-2",
      password: "hunter2",
      clientSecret: "shh",
      accessToken: "tok-1",
      sessionId: "sess-1",
      bearer: "tok-2",
      model: "m",
    };
    const out = redactSecrets(input) as Record<string, unknown>;
    for (const k of [
      "authorization",
      "Authorization",
      "api_key",
      "api-key",
      "password",
      "clientSecret",
      "accessToken",
      "sessionId",
      "bearer",
    ]) {
      expect(out[k]).toBe("[REDACTED]");
    }
    expect(out["model"]).toBe("m");
  });

  it("preserves numeric token-usage fields already validated", () => {
    const input = {
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      model: "m",
      apiKey: "sk-secret",
    };
    const out = redactSecrets(input) as Record<string, unknown>;
    expect(out["promptTokens"]).toBe(10);
    expect(out["completionTokens"]).toBe(5);
    expect(out["totalTokens"]).toBe(15);
    expect(out["apiKey"]).toBe("[REDACTED]");
  });

  it("handles nested objects, arrays, and null without mutating input", () => {
    const inner = { apiKey: "sk-inner", promptTokens: 7 };
    const input = {
      nested: { deep: inner, list: [{ password: "p1" }, { model: "m" }] },
      items: ["a", null, { token: "t-secret" }],
      nothing: null,
      count: 3,
    };
    const snapshot = structuredClone(input);
    const out = redactSecrets(input) as Record<string, unknown>;
    expect(out).not.toBe(input);
    // input untouched
    expect(input).toEqual(snapshot);
    const nested = out["nested"] as Record<string, unknown>;
    const deep = nested["deep"] as Record<string, unknown>;
    expect(deep["apiKey"]).toBe("[REDACTED]");
    expect(deep["promptTokens"]).toBe(7);
    const list = nested["list"] as Array<Record<string, unknown>>;
    expect(list[0]?.["password"]).toBe("[REDACTED]");
    expect(list[1]?.["model"]).toBe("m");
    const items = out["items"] as unknown[];
    expect(items[1]).toBeNull();
    expect((items[2] as Record<string, unknown>)["token"]).toBe("[REDACTED]");
    expect(out["nothing"]).toBeNull();
  });

  it("does not rely on field names alone: scrubs known secret values inside error messages", () => {
    const rawKey = "sk-live-EXAMPLE-1234567890";
    const input = {
      message: `request failed with key ${rawKey} included`,
      model: "gpt-4o-mini",
      promptTokens: 4,
    };
    const out = redactSecrets(input, [rawKey]) as Record<string, unknown>;
    expect(String(out["message"])).not.toContain(rawKey);
    expect(String(out["message"])).toContain("[REDACTED]");
    expect(out["promptTokens"]).toBe(4);
  });

  it("scrubs Error.message containing a secret canary without mutating the original", () => {
    const canary = "sk-live-CANARY-9f8b7a6e5d4c3b2a10";
    const err = new Error(`vault put failed with key ${canary} included`);
    const originalMessage = err.message;
    const out = redactSecrets(err, [canary]) as Error;
    expect(out).toBeInstanceOf(Error);
    expect(out).not.toBe(err);
    expect(String(out.message)).not.toContain(canary);
    expect(String(out.message)).toContain("[REDACTED]");
    expect(err.message).toBe(originalMessage);
    expect(String(out.stack ?? "")).not.toContain(canary);
  });

  it("isSecretLikeKey matches the contract pattern", () => {
    expect(isSecretLikeKey("apiKey")).toBe(true);
    expect(isSecretLikeKey("Authorization")).toBe(true);
    expect(isSecretLikeKey("model")).toBe(false);
    expect(isSecretLikeKey("prompt")).toBe(false);
  });
});

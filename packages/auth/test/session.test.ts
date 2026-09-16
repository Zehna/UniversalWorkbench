import { describe, expect, it } from "vitest";
import { createSessionToken, digestSessionToken } from "../src/index.js";

describe("session tokens", () => {
  it("creates an opaque 32-byte token and stores only its SHA-256 digest", () => {
    const token = createSessionToken();

    expect(Buffer.from(token.raw, "base64url")).toHaveLength(32);
    expect(token.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(token.digest).not.toBe(token.raw);
    expect(token.digest).toBe(digestSessionToken(token.raw));
  });

  it("creates different tokens across calls", () => {
    const first = createSessionToken();
    const second = createSessionToken();

    expect(first.raw).not.toBe(second.raw);
    expect(first.digest).not.toBe(second.digest);
  });
});

import { describe, expect, it } from "vitest";
import { createPasswordHasher } from "../src/index.js";

describe("password hashing", () => {
  it("uses a fresh salt for every hash of the same password", async () => {
    const hasher = createPasswordHasher();

    const first = await hasher.hash("correct horse battery staple");
    const second = await hasher.hash("correct horse battery staple");

    expect(first.algorithm).toBe("argon2id");
    expect(second.algorithm).toBe("argon2id");
    expect(first.salt).not.toBe(second.salt);
    expect(first.hash).not.toBe(second.hash);
    expect(first.parameters).toEqual({
      memory: 19 * 1024,
      passes: 2,
      parallelism: 1,
      tagLength: 32,
    });
  });

  it("accepts the correct password and rejects an incorrect password", async () => {
    const hasher = createPasswordHasher();
    const stored = await hasher.hash("phase-one-owner-password");

    await expect(
      hasher.verify("phase-one-owner-password", stored),
    ).resolves.toBe(true);
    await expect(hasher.verify("wrong-password", stored)).resolves.toBe(false);
  });
});

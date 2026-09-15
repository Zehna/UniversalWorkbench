import { describe, expect, it } from "vitest";
import { SystemClock, UuidGenerator } from "../src/index.js";

describe("shared primitives", () => {
  it("returns a Date from the system clock", () => {
    expect(new SystemClock().now()).toBeInstanceOf(Date);
  });

  it("returns distinct UUID-shaped identifiers", () => {
    const ids = new UuidGenerator();
    const a = ids.next();
    const b = ids.next();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f-]{36}$/i);
  });
});

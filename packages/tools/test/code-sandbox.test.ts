import { describe, expect, it } from "vitest";
import { SafeJavaScriptSandbox } from "../src/code/sandbox.js";

describe("SafeJavaScriptSandbox", () => {
  const sandbox = new SafeJavaScriptSandbox();

  it("evaluates basic calculation and returns result", async () => {
    const outcome = await sandbox.run({
      code: "const a = 15; const b = 25; return a + b;",
    });

    expect(outcome.success).toBe(true);
    expect(outcome.result).toBe(40);
    expect(outcome.error).toBeUndefined();
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("captures console.log into stdout", async () => {
    const outcome = await sandbox.run({
      code: `
        console.log("Starting analysis");
        console.log({ step: 1, metric: 99 });
        return "done";
      `,
    });

    expect(outcome.success).toBe(true);
    expect(outcome.result).toBe("done");
    expect(outcome.stdout).toContain("Starting analysis");
    expect(outcome.stdout).toContain('{"step":1,"metric":99}');
  });

  it("accesses passed input payload safely", async () => {
    const outcome = await sandbox.run({
      input: { numbers: [2, 4, 6, 8] },
      code: "return input.numbers.reduce((acc, n) => acc + n, 0);",
    });

    expect(outcome.success).toBe(true);
    expect(outcome.result).toBe(20);
  });

  it("captures runtime error in stderr and sets success to false", async () => {
    const outcome = await sandbox.run({
      code: "return nonExistentVariable.value;",
    });

    expect(outcome.success).toBe(false);
    expect(outcome.stderr).toContain("nonExistentVariable");
    expect(outcome.error).toBeDefined();
  });

  it("traps syntax error gracefully without throwing", async () => {
    const outcome = await sandbox.run({
      code: "const x = ;",
    });

    expect(outcome.success).toBe(false);
    expect(outcome.stderr).toContain("SyntaxError");
    expect(outcome.error).toBeDefined();
  });

  it("enforces timeout on long-running code", async () => {
    const outcome = await sandbox.run({
      code: "await new Promise((resolve) => setTimeout(resolve, 500));",
      timeoutMs: 150,
    });

    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain("TIMEOUT");
  });

  it("blocks dangerous host globals", async () => {
    const outcome = await sandbox.run({
      code: "return typeof process;",
    });

    expect(outcome.success).toBe(true);
    expect(outcome.result).toBe("undefined");
  });
});

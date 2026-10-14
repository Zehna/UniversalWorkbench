import { describe, expect, it } from "vitest";
import {
  CodeInterpreterConfigSchema,
  CodeExecutionResultSchema,
  CodeResultEnvelopeSchema,
  ContextEnvelopeSchema,
  ContextTypeSchema,
} from "../src/index.js";

describe("phase 10 code interpreter contracts", () => {
  it("includes code_result in ContextTypeSchema", () => {
    expect(ContextTypeSchema.options).toContain("code_result");
  });

  describe("CodeInterpreterConfigSchema", () => {
    it("applies defaults for valid code", () => {
      const parsed = CodeInterpreterConfigSchema.parse({
        code: "const x = 10 + 20; return x;",
      });
      expect(parsed.language).toBe("javascript");
      expect(parsed.timeoutMs).toBe(3000);
      expect(parsed.memoryLimitMb).toBe(64);
      expect(parsed.code).toBe("const x = 10 + 20; return x;");
    });

    it("accepts custom language and timeout limits", () => {
      const parsed = CodeInterpreterConfigSchema.parse({
        language: "typescript",
        code: "const a: number = 42; return a;",
        timeoutMs: 5000,
        memoryLimitMb: 128,
      });
      expect(parsed.language).toBe("typescript");
      expect(parsed.timeoutMs).toBe(5000);
      expect(parsed.memoryLimitMb).toBe(128);
    });

    it("rejects empty code", () => {
      expect(() =>
        CodeInterpreterConfigSchema.parse({ code: "   " }),
      ).toThrow();
    });

    it("rejects timeoutMs out of bounds (< 100 or > 10000)", () => {
      expect(() =>
        CodeInterpreterConfigSchema.parse({
          code: "return 1;",
          timeoutMs: 50,
        }),
      ).toThrow();
      expect(() =>
        CodeInterpreterConfigSchema.parse({
          code: "return 1;",
          timeoutMs: 15000,
        }),
      ).toThrow();
    });
  });

  describe("CodeExecutionResultSchema", () => {
    it("parses valid execution result with defaults", () => {
      const parsed = CodeExecutionResultSchema.parse({
        success: true,
        result: 42,
        durationMs: 12,
      });
      expect(parsed.success).toBe(true);
      expect(parsed.result).toBe(42);
      expect(parsed.stdout).toBe("");
      expect(parsed.stderr).toBe("");
      expect(parsed.durationMs).toBe(12);
    });

    it("parses error result with stderr", () => {
      const parsed = CodeExecutionResultSchema.parse({
        success: false,
        stdout: "calculating...",
        stderr: "ReferenceError: y is not defined",
        durationMs: 5,
        error: "Execution error",
      });
      expect(parsed.success).toBe(false);
      expect(parsed.stdout).toBe("calculating...");
      expect(parsed.stderr).toBe("ReferenceError: y is not defined");
    });
  });

  describe("CodeResultEnvelopeSchema", () => {
    it("validates code_result context envelope", () => {
      const envelope = {
        id: "11111111-1111-4111-8111-111111111111",
        type: "code_result" as const,
        schemaVersion: 1 as const,
        mimeType: "application/json",
        metadata: {},
        payload: {
          success: true,
          result: { sum: 30 },
          stdout: "Done",
          stderr: "",
          durationMs: 25,
        },
        provenance: {
          sourceContextIds: [],
        },
        capabilities: ["json"],
      };

      const parsedContext = ContextEnvelopeSchema.parse(envelope);
      expect(parsedContext.type).toBe("code_result");

      const parsedCode = CodeResultEnvelopeSchema.parse(envelope);
      expect(parsedCode.payload.success).toBe(true);
      expect(parsedCode.payload.result).toEqual({ sum: 30 });
    });
  });
});

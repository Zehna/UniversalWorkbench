import type { CodeExecutionResult } from "@uw/contracts";
import type { CodeSandbox, SandboxRunOptions } from "./types.js";

/**
 * Isolated in-process JavaScript execution sandbox.
 * Runs code with safe globals and intercepts console output.
 * Traps syntax errors, runtime exceptions, and enforces timeout limits.
 */
export class SafeJavaScriptSandbox implements CodeSandbox {
  async run(options: SandboxRunOptions): Promise<CodeExecutionResult> {
    const startTime = Date.now();
    const timeoutMs = options.timeoutMs ?? 3000;
    const stdoutLogs: string[] = [];
    const stderrLogs: string[] = [];

    const mockConsole = {
      log: (...args: unknown[]) => {
        stdoutLogs.push(args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" "));
      },
      info: (...args: unknown[]) => {
        stdoutLogs.push(args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" "));
      },
      warn: (...args: unknown[]) => {
        stderrLogs.push(args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" "));
      },
      error: (...args: unknown[]) => {
        stderrLogs.push(args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" "));
      },
    };

    // Safe isolated sandbox globals
    const sandboxScope: Record<string, unknown> = {
      console: mockConsole,
      input: options.input,
      JSON,
      Math,
      Date,
      Number,
      String,
      Boolean,
      Array,
      Object,
      RegExp,
      Map,
      Set,
      parseInt,
      parseFloat,
      isNaN,
      isFinite,
      TextEncoder: typeof TextEncoder !== "undefined" ? TextEncoder : undefined,
      TextDecoder: typeof TextDecoder !== "undefined" ? TextDecoder : undefined,
      // Block hazardous host primitives
      process: undefined,
      require: undefined,
      global: undefined,
      globalThis: undefined,
      fetch: undefined,
    };

    const scopeKeys = Object.keys(sandboxScope);
    const scopeValues = Object.values(sandboxScope);

    const wrappedScript = `
      "use strict";
      return (async function() {
        ${options.code}
      })();
    `;

    let executionPromise: Promise<unknown>;
    try {
      // Evaluate function inside closed sandbox parameter scope
      const runnerFn = new Function(...scopeKeys, wrappedScript);
      executionPromise = Promise.resolve(runnerFn(...scopeValues));
    } catch (syntaxOrPrepError) {
      const durationMs = Date.now() - startTime;
      const errMsg = syntaxOrPrepError instanceof Error ? syntaxOrPrepError.message : String(syntaxOrPrepError);
      stderrLogs.push(`SyntaxError: ${errMsg}`);
      return {
        success: false,
        stdout: stdoutLogs.join("\n"),
        stderr: stderrLogs.join("\n"),
        durationMs,
        error: errMsg,
      };
    }

    let timeoutTimer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutTimer = setTimeout(() => {
        reject(new Error(`TIMEOUT: Code execution exceeded limit of ${timeoutMs}ms`));
      }, timeoutMs);
    });

    try {
      const result = await Promise.race([executionPromise, timeoutPromise]);
      const durationMs = Date.now() - startTime;
      return {
        success: true,
        result: result !== undefined ? result : null,
        stdout: stdoutLogs.join("\n"),
        stderr: stderrLogs.join("\n"),
        durationMs,
      };
    } catch (runtimeError) {
      const durationMs = Date.now() - startTime;
      const errMsg = runtimeError instanceof Error ? runtimeError.message : String(runtimeError);
      stderrLogs.push(errMsg);
      return {
        success: false,
        stdout: stdoutLogs.join("\n"),
        stderr: stderrLogs.join("\n"),
        durationMs,
        error: errMsg,
      };
    } finally {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
    }
  }
}

export function createCodeSandbox(): CodeSandbox {
  return new SafeJavaScriptSandbox();
}

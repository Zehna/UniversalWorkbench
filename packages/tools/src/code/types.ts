import type { CodeExecutionResult } from "@uw/contracts";

export interface SandboxRunOptions {
  code: string;
  timeoutMs?: number;
  input?: unknown;
}

export interface CodeSandbox {
  run(options: SandboxRunOptions): Promise<CodeExecutionResult>;
}

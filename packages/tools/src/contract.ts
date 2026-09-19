import type {
  ContextEnvelope,
  ToolCapability,
  ToolDefinition,
} from "@uw/contracts";

export interface ToolRunContext {
  ownerId: string;
  projectId: string;
  executionId: string;
  stepExecutionId: string;
  traceId: string;
  config: unknown;
  inputs: Record<string, ContextEnvelope>;
  signal: AbortSignal;
}

export interface ToolRunResult {
  outputs: Record<string, ContextEnvelope>;
  usage: {
    outputBytes: number;
    httpRequests: number;
  };
}

export interface ToolRunner {
  run(context: ToolRunContext): Promise<ToolRunResult>;
}

export interface RegisteredTool {
  definition: ToolDefinition;
  runner: ToolRunner;
}

export interface CompatibleToolTarget {
  definition: ToolDefinition;
  inputPort: ToolDefinition["accepts"][number];
}

export interface ToolPermissionSummary {
  required: readonly ToolCapability[];
  missing: readonly ToolCapability[];
}

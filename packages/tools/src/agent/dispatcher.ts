import type {
  AgentObservation,
  ContextEnvelope,
  ToolDescriptor,
} from "@uw/contracts";
import { runTool } from "../runtime.js";
import type { ToolExecutor, ToolRunContext } from "../runtime.js";

export interface FunctionCallingSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AgentToolCallInput {
  id?: string;
  name: string;
  tool?: string;
  arguments?: Record<string, unknown>;
}

export interface AgentDispatchObservation {
  toolCallId?: string;
  output: unknown;
  durationMs: number;
  isError: boolean;
}

export interface AgentToolDispatcherOptions {
  tools: ToolExecutor[];
  allowedTools: readonly string[];
}

export function toToolName(descriptor: Pick<ToolDescriptor, "id" | "version">): string {
  return `${descriptor.id}@${descriptor.version}`;
}

export function toFunctionCallingSpec(
  descriptor: ToolDescriptor,
): FunctionCallingSpec {
  return {
    name: toToolName(descriptor),
    description: descriptor.description,
    parameters: { ...(descriptor.configSchema as Record<string, unknown>) },
  };
}

export function toFunctionCallingSpecs(
  descriptors: ToolDescriptor[],
): FunctionCallingSpec[] {
  return descriptors.map((descriptor) => toFunctionCallingSpec(descriptor));
}

function resolveCallName(call: AgentToolCallInput): string {
  const raw = call.name ?? call.tool ?? "";
  return typeof raw === "string" ? raw.trim() : "";
}

function unauthorizedError(tool: string, message: string): AgentObservation["output"] {
  return {
    error: {
      code: "UNAUTHORIZED_TOOL",
      message,
      tool,
    },
  };
}

export class AgentToolDispatcher {
  private readonly executors = new Map<string, ToolExecutor>();
  private readonly allowed: ReadonlySet<string>;
  private readonly allowedList: readonly string[];

  constructor(options: AgentToolDispatcherOptions) {
    this.allowedList = [...(options.allowedTools ?? [])];
    this.allowed = new Set(this.allowedList);
    for (const tool of options.tools ?? []) {
      this.executors.set(toToolName(tool.descriptor), tool);
    }
  }

  get allowedTools(): readonly string[] {
    return this.allowedList;
  }

  listSpecs(): FunctionCallingSpec[] {
    return [...this.executors.values()]
      .filter((tool) => this.allowed.has(toToolName(tool.descriptor)))
      .map((tool) => toFunctionCallingSpec(tool.descriptor))
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  }

  async dispatch(
    call: AgentToolCallInput,
    input: ContextEnvelope,
    context: ToolRunContext,
  ): Promise<AgentDispatchObservation> {
    const startedAt = Date.now();
    const toolCallId = call?.id;
    const name = resolveCallName(call);

    const finish = (output: unknown, isError: boolean): AgentDispatchObservation => ({
      ...(toolCallId !== undefined ? { toolCallId } : {}),
      output,
      durationMs: Math.max(0, Date.now() - startedAt),
      isError,
    });

    if (!name || !this.allowed.has(name)) {
      return finish(
        unauthorizedError(
          name,
          name
            ? `Tool is not permitted by the allowedTools whitelist: ${name}`
            : "Tool call is missing a tool name",
        ),
        true,
      );
    }

    const executor = this.executors.get(name);
    if (!executor) {
      return finish(
        {
          error: {
            code: "UNKNOWN_TOOL",
            message: `Tool is allowed but not registered: ${name}`,
            tool: name,
          },
        },
        true,
      );
    }

    const config: Record<string, unknown> = call.arguments ?? {};
    try {
      const result = await runTool(executor, input, config, context);
      return finish(result, false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code =
        error instanceof Error && "code" in error && typeof (error as { code: unknown }).code === "string"
          ? ((error as { code: string }).code as string)
          : undefined;
      return finish(
        {
          error: {
            code: "TOOL_EXECUTION_FAILED",
            message,
            tool: name,
            ...(code ? { cause: code } : {}),
          },
        },
        true,
      );
    }
  }
}

export function createAgentToolDispatcher(
  options: AgentToolDispatcherOptions,
): AgentToolDispatcher {
  return new AgentToolDispatcher(options);
}

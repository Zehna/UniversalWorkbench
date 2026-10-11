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

export interface AgentPendingApproval {
  tool: string;
  toolCallId?: string;
  arguments?: Record<string, unknown>;
  reason: string;
}

export interface AgentApprovalResolutionInput {
  decision: "approved" | "rejected";
  rejectionReason?: string;
}

export interface AgentDispatchObservation {
  toolCallId?: string;
  output: unknown;
  durationMs: number;
  isError: boolean;
  requiresApproval?: boolean;
  pendingApproval?: AgentPendingApproval;
}

export interface AgentToolDispatcherOptions {
  tools: ToolExecutor[];
  allowedTools: readonly string[];
}

export function toToolName(
  descriptor: Pick<ToolDescriptor, "id" | "version">,
): string {
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

function unauthorizedError(
  tool: string,
  message: string,
): AgentObservation["output"] {
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
      .sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
      );
  }

  async dispatch(
    call: AgentToolCallInput,
    input: ContextEnvelope,
    context: ToolRunContext,
    approval?: AgentApprovalResolutionInput,
  ): Promise<AgentDispatchObservation> {
    const startedAt = Date.now();
    const toolCallId = call?.id;
    const name = resolveCallName(call);

    const finish = (
      output: unknown,
      isError: boolean,
      extra?: Pick<
        AgentDispatchObservation,
        "requiresApproval" | "pendingApproval"
      >,
    ): AgentDispatchObservation => ({
      ...(toolCallId !== undefined ? { toolCallId } : {}),
      output,
      durationMs: Math.max(0, Date.now() - startedAt),
      isError,
      ...(extra ?? {}),
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

    if (executor.descriptor.requiresApproval === true) {
      if (approval?.decision === "approved") {
        // Approved: fall through to execution below.
      } else if (approval?.decision === "rejected") {
        const reason = approval.rejectionReason?.trim() || "rejected by user";
        return finish(`Action was rejected by user: ${reason}`, true);
      } else {
        const pending: AgentPendingApproval = {
          tool: name,
          ...(toolCallId !== undefined ? { toolCallId } : {}),
          arguments: call.arguments ?? {},
          reason: `Tool ${name} requires approval`,
        };
        return finish({ pendingApproval: pending }, false, {
          requiresApproval: true,
          pendingApproval: pending,
        });
      }
    }

    const config: Record<string, unknown> = call.arguments ?? {};
    try {
      const result = await runTool(executor, input, config, context);
      return finish(result, false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code =
        error instanceof Error &&
        "code" in error &&
        typeof (error as { code: unknown }).code === "string"
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

  async dispatchMany(
    calls: AgentToolCallInput[],
    input: ContextEnvelope,
    context: ToolRunContext,
    approvals?: Record<string, AgentApprovalResolutionInput>,
  ): Promise<AgentDispatchObservation[]> {
    const tasks = calls.map((call) => {
      const name = resolveCallName(call);
      const approval =
        (call?.id !== undefined ? approvals?.[call.id] : undefined) ??
        (name !== "" ? approvals?.[name] : undefined);
      return this.dispatch(call, input, context, approval);
    });
    const settled = await Promise.allSettled(tasks);
    return settled.map((result, index) => {
      if (result.status === "fulfilled") return result.value;
      const call = calls[index];
      const toolCallId = call?.id;
      const message =
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason);
      return {
        ...(toolCallId !== undefined ? { toolCallId } : {}),
        output: {
          error: {
            code: "TOOL_EXECUTION_FAILED",
            message,
            tool: resolveCallName(call as AgentToolCallInput),
          },
        },
        durationMs: 0,
        isError: true,
      } satisfies AgentDispatchObservation;
    });
  }
}

export function createAgentToolDispatcher(
  options: AgentToolDispatcherOptions,
): AgentToolDispatcher {
  return new AgentToolDispatcher(options);
}

import {
  ExecutionSchema,
  ToolDefinitionSchema,
  ToolInputPortSchema,
  type ContextType,
  type Execution,
  type StepExecutionStatus,
  type ToolDefinition,
  type ToolInputPort,
} from "@uw/contracts";

export interface CompatibleToolTarget {
  definition: ToolDefinition;
  inputPort: ToolInputPort;
}

export interface ExecutionStepSummary {
  id: string;
  nodeId: string;
  toolId: string;
  toolVersion: string;
  status: StepExecutionStatus;
  attempt: number;
  startedAt: string | null;
  finishedAt: string | null;
  error: unknown | null;
}

export interface ExecutionSnapshot {
  execution: Execution;
  steps: ExecutionStepSummary[];
}

export interface ExecutionReceiptSnapshot {
  receipts: unknown[];
  provenance: unknown[];
}

export interface WorkflowApiClient {
  listTools(): Promise<ToolDefinition[]>;
  compatibleTargets(type: ContextType): Promise<CompatibleToolTarget[]>;
  validateWorkflow(
    projectId: string,
    workflowId: string,
    workflowRevisionId: string,
  ): Promise<{ valid: boolean }>;
  runWorkflow(
    projectId: string,
    workflowId: string,
    workflowRevisionId: string,
    idempotencyKey: string,
  ): Promise<{ execution: Execution; steps?: ExecutionStepSummary[] }>;
  getExecution(
    projectId: string,
    executionId: string,
  ): Promise<ExecutionSnapshot>;
  getReceipt(
    projectId: string,
    executionId: string,
  ): Promise<ExecutionReceiptSnapshot>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set("content-type", "application/json");

  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: "include",
    headers,
  });
  const text = await response.text();
  const body =
    text.length === 0
      ? undefined
      : (() => {
          try {
            return JSON.parse(text) as unknown;
          } catch {
            return undefined;
          }
        })();

  if (!response.ok) {
    const error =
      isRecord(body) && isRecord(body.error) ? body.error : undefined;
    const message =
      error && typeof error.message === "string"
        ? error.message
        : `Workflow request failed with status ${response.status}`;
    throw new Error(message);
  }

  return body;
}

function parseSteps(value: unknown): ExecutionStepSummary[] {
  if (!Array.isArray(value)) throw new Error("Invalid execution step list");

  return value.map((item) => {
    if (!isRecord(item)) throw new Error("Invalid execution step");
    const status = item.status;
    if (
      typeof item.id !== "string" ||
      typeof item.nodeId !== "string" ||
      typeof item.toolId !== "string" ||
      typeof item.toolVersion !== "string" ||
      typeof item.attempt !== "number" ||
      ![
        "pending",
        "queued",
        "running",
        "succeeded",
        "failed",
        "skipped",
        "cancelled",
        "timed_out",
      ].includes(String(status))
    ) {
      throw new Error("Invalid execution step");
    }

    return {
      id: item.id,
      nodeId: item.nodeId,
      toolId: item.toolId,
      toolVersion: item.toolVersion,
      status: status as StepExecutionStatus,
      attempt: item.attempt,
      startedAt: typeof item.startedAt === "string" ? item.startedAt : null,
      finishedAt: typeof item.finishedAt === "string" ? item.finishedAt : null,
      error: item.error ?? null,
    };
  });
}

export function createWorkflowApiClient(): WorkflowApiClient {
  return {
    async listTools() {
      const body = await request("/tools");
      if (!isRecord(body)) throw new Error("Invalid tools response");
      return ToolDefinitionSchema.array().parse(body.tools);
    },

    async compatibleTargets(type) {
      const body = await request("/tools/compatibility", {
        method: "POST",
        body: JSON.stringify({ type }),
      });
      if (!isRecord(body) || !Array.isArray(body.targets)) {
        throw new Error("Invalid compatibility response");
      }

      return body.targets.map((target) => {
        if (!isRecord(target)) throw new Error("Invalid compatibility target");
        return {
          definition: ToolDefinitionSchema.parse(target.definition),
          inputPort: ToolInputPortSchema.parse(target.inputPort),
        };
      });
    },

    async validateWorkflow(projectId, workflowId, workflowRevisionId) {
      const body = await request(
        `/projects/${projectId}/workflows/${workflowId}/validate`,
        {
          method: "POST",
          body: JSON.stringify({ workflowRevisionId }),
        },
      );
      if (!isRecord(body) || body.valid !== true) {
        throw new Error("Workflow validation did not succeed");
      }
      return { valid: true };
    },

    async runWorkflow(
      projectId,
      workflowId,
      workflowRevisionId,
      idempotencyKey,
    ) {
      const body = await request(`/projects/${projectId}/executions`, {
        method: "POST",
        body: JSON.stringify({
          kind: "workflow",
          workflowId,
          workflowRevisionId,
          idempotencyKey,
        }),
      });
      if (!isRecord(body)) throw new Error("Invalid execution response");
      const execution = ExecutionSchema.parse(body.execution);
      return {
        execution,
        ...(Array.isArray(body.steps) ? { steps: parseSteps(body.steps) } : {}),
      };
    },

    async getExecution(projectId, executionId) {
      const body = await request(
        `/projects/${projectId}/executions/${executionId}`,
      );
      if (!isRecord(body)) throw new Error("Invalid execution response");
      return {
        execution: ExecutionSchema.parse(body.execution),
        steps: parseSteps(body.steps),
      };
    },

    async getReceipt(projectId, executionId) {
      const body = await request(
        `/projects/${projectId}/executions/${executionId}/receipt`,
      );
      if (
        !isRecord(body) ||
        !Array.isArray(body.receipts) ||
        !Array.isArray(body.provenance)
      ) {
        throw new Error("Invalid execution receipt response");
      }
      return {
        receipts: body.receipts,
        provenance: body.provenance,
      };
    },
  };
}

import type {
  ContextEnvelope,
  WorkflowDefinition,
  WorkflowNode,
} from "@uw/contracts";
import { createJsonExtractTool, createToolRegistry } from "@uw/tools";
import type { ToolExecutor, ToolRegistry } from "@uw/tools";
import { validateWorkflow } from "@uw/workflow";
import type { ExecutionBudget } from "../src/budget.js";
import type { ExecuteWorkflowInput } from "../src/engine.js";
import type {
  ExecutionRecord,
  ExecutionStepRecord,
  ExecutionView,
  StructuredExecutionError,
} from "../src/model.js";
import type {
  ExecutionSubmission,
  FinishStepInput,
  StoredWorkflowRun,
  WorkflowExecutionStore,
} from "../src/store.js";

export function uuid(n: number): string {
  return "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
}

export const ownerId = uuid(90);
export const projectId = uuid(91);
export const defaultBudget: ExecutionBudget = {
  maxSteps: 12,
  maxDurationMs: 10_000,
  maxOutputBytes: 100_000,
};

export function context(
  type: ContextEnvelope["type"],
  payload: unknown,
  id = uuid(80),
): ContextEnvelope {
  return {
    id,
    type,
    schemaVersion: 1,
    mimeType: type === "json" ? "application/json" : "text/plain",
    metadata: {},
    payload,
    provenance: { sourceContextIds: [] },
    capabilities: [],
  };
}

export function node(
  n: number,
  toolId: string,
  input: WorkflowNode["input"] = { source: "workflow_input" },
  options: Partial<WorkflowNode> = {},
): WorkflowNode {
  return {
    id: uuid(n),
    toolId,
    toolVersion: "1.0.0",
    config: {},
    input,
    ...options,
  };
}

export function workflow(
  nodes: WorkflowNode[],
  edges: WorkflowDefinition["edges"] = [],
): WorkflowDefinition {
  return {
    id: uuid(70),
    projectId,
    name: "Execution fixture",
    schemaVersion: 1,
    nodes,
    edges,
  };
}

export class MemoryStore implements WorkflowExecutionStore {
  readonly rows = new Map<string, StoredWorkflowRun>();
  async submit(input: ExecutionSubmission): Promise<ExecutionRecord> {
    const execution: ExecutionRecord = {
      id: input.id,
      ownerId: input.ownerId,
      projectId: input.projectId,
      workflowDefinitionId: input.workflowDefinitionId,
      status: "queued",
      traceId: input.traceId,
      inputContext: input.inputContext,
      startedAt: null,
      finishedAt: null,
      error: null,
      usage: {},
      createdAt: input.createdAt,
    };
    this.rows.set(input.id, {
      view: { execution, steps: [], provenanceEdges: [], receipt: null },
      workflow: input.workflow,
      workflowVersion: input.workflowVersion,
      grantedPermissions: input.grantedPermissions,
      budget: input.budget,
    });
    return execution;
  }
  async load(id: string): Promise<StoredWorkflowRun | null> {
    return this.rows.get(id) ?? null;
  }
  async createExecution(): Promise<ExecutionRecord> {
    throw new Error("Use atomic submit");
  }
  async get(
    owner: string,
    project: string,
    id: string,
  ): Promise<ExecutionView | null> {
    const row = await this.load(id);
    return row &&
      row.view.execution.ownerId === owner &&
      row.view.execution.projectId === project
      ? row.view
      : null;
  }
  async markRunning(id: string, startedAt: Date): Promise<void> {
    const row = this.rows.get(id)!;
    if (row.view.execution.status !== "queued")
      throw new Error("Invalid state");
    row.view.execution.status = "running";
    row.view.execution.startedAt = startedAt;
  }
  async suspendExecution(
    id: string,
    usage: Record<string, unknown>,
  ): Promise<void> {
    const row = this.rows.get(id)!;
    if (row.view.execution.status !== "running")
      throw new Error("Invalid state");
    row.view.execution.status = "awaiting_approval";
    row.view.execution.usage = usage;
  }
  async resumeExecution(id: string): Promise<void> {
    const row = this.rows.get(id)!;
    if (row.view.execution.status !== "awaiting_approval")
      throw new Error("Invalid state");
    row.view.execution.status = "running";
  }
  async suspend(input: {
    executionId: string;
    usage: Record<string, unknown>;
  }): Promise<void> {
    return this.suspendExecution(input.executionId, input.usage);
  }
  async resume(id: string): Promise<void> {
    return this.resumeExecution(id);
  }
  async startStep(step: ExecutionStepRecord): Promise<void> {
    const row = this.rows.get(step.executionId)!;
    if (
      row.view.steps.some(
        (candidate) =>
          candidate.nodeId === step.nodeId &&
          candidate.attempt === step.attempt,
      )
    )
      throw new Error("Duplicate attempt");
    row.view.steps.push({ ...step });
  }
  async finishStep(input: FinishStepInput): Promise<void> {
    const row = this.rows.get(input.executionId)!;
    const step = row.view.steps.find((candidate) => candidate.id === input.id)!;
    if (step.status !== "running") throw new Error("Already finished");
    step.status = input.status;
    step.finishedAt = input.finishedAt;
    step.outputContexts = input.outputContexts;
    step.error = input.error;
    for (const output of input.outputContexts) {
      for (const sourceId of output.provenance.sourceContextIds) {
        row.view.provenanceEdges.push({
          fromContextId: sourceId,
          toContextId: output.id,
          nodeId: input.nodeId,
        });
      }
    }
  }
  async recordStep(step: ExecutionStepRecord): Promise<void> {
    this.rows.get(step.executionId)!.view.steps.push(step);
  }
  async complete(input: {
    executionId: string;
    finishedAt: Date;
    usage: Record<string, unknown>;
    receipt: Record<string, unknown>;
  }): Promise<void> {
    const view = this.rows.get(input.executionId)!.view;
    view.execution.status = "completed";
    view.execution.finishedAt = input.finishedAt;
    view.execution.usage = input.usage;
    view.receipt = input.receipt;
  }
  async fail(input: {
    executionId: string;
    finishedAt: Date;
    usage: Record<string, unknown>;
    receipt: Record<string, unknown>;
    error: StructuredExecutionError;
  }): Promise<void> {
    const view = this.rows.get(input.executionId)!.view;
    view.execution.status = "failed";
    view.execution.finishedAt = input.finishedAt;
    view.execution.usage = input.usage;
    view.execution.error = input.error;
    view.receipt = input.receipt;
  }
  async cancel(
    id: string,
    finishedAt: Date,
    receipt?: Record<string, unknown>,
  ): Promise<void> {
    const view = this.rows.get(id)!.view;
    view.execution.status = "cancelled";
    view.execution.finishedAt = finishedAt;
    view.receipt = receipt ?? { executionId: id, status: "cancelled" };
  }
}

export function tool(
  id: string,
  options: {
    accepts?: ContextEnvelope["type"][];
    produces?: ContextEnvelope["type"][];
    idempotency?: ToolExecutor["descriptor"]["idempotency"];
    handler: ToolExecutor["run"];
  },
): ToolExecutor {
  const base = createJsonExtractTool().descriptor;
  return {
    descriptor: {
      ...base,
      id,
      name: id,
      accepts: options.accepts ?? ["json"],
      produces: options.produces ?? ["text"],
      idempotency: options.idempotency ?? "safe",
      configSchema: {},
    },
    run: options.handler,
  };
}

export function inputFor(
  registry: ToolRegistry,
  definition: WorkflowDefinition,
  payload: ContextEnvelope = context("json", { name: "  work  " }),
  budget = defaultBudget,
): ExecuteWorkflowInput {
  return {
    ownerId,
    projectId,
    workflow: validateWorkflow(definition, registry),
    input: payload,
    permissions: new Set(),
    budget,
    traceId: uuid(92),
  };
}

export function registryWith(...items: ToolExecutor[]): ToolRegistry {
  const registry = createToolRegistry();
  for (const item of items) registry.register(item);
  return registry;
}

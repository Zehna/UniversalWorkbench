import { ContextEnvelopeSchema, WorkflowDefinitionSchema } from "@uw/contracts";
import type { ContextEnvelope, WorkflowDefinition } from "@uw/contracts";
import type { ToolRegistry } from "@uw/tools";
import { buildPreflightPlan, validateWorkflow } from "./preflight.js";
import type { ValidatedWorkflow } from "./preflight.js";
import { WorkflowNotFoundError } from "./repository.js";
import type { WorkflowRepository, WorkflowVersion } from "./repository.js";
import { WorkflowValidationError } from "./errors.js";

export interface WorkflowRunBudget {
  maxSteps: number;
  maxDurationMs: number;
  maxOutputBytes: number;
}

export interface WorkflowEnqueueInput {
  ownerId: string;
  projectId: string;
  workflow: ValidatedWorkflow;
  workflowVersion: number;
  input: ContextEnvelope;
  permissions: ReadonlySet<string>;
  budget: WorkflowRunBudget;
  traceId: string;
}

export interface WorkflowService {
  list(ownerId: string, projectId: string): Promise<WorkflowVersion[]>;
  get(
    ownerId: string,
    projectId: string,
    workflowId: string,
  ): Promise<WorkflowVersion>;
  save(
    ownerId: string,
    projectId: string,
    definition: WorkflowDefinition,
    expectedVersion?: number,
  ): Promise<WorkflowVersion>;
  run(input: {
    ownerId: string;
    projectId: string;
    workflowId: string;
    context: ContextEnvelope;
    traceId: string;
    budget?: WorkflowRunBudget;
  }): Promise<{ id: string; status: string; traceId: string }>;
}

export function createWorkflowService(deps: {
  repository: WorkflowRepository;
  registry: ToolRegistry;
  enqueue: (
    input: WorkflowEnqueueInput,
  ) => Promise<{ id: string; status: string; traceId: string }>;
  // This policy comes from trusted server composition, never from a request.
  allowedPermissions?: readonly string[];
  defaultBudget?: WorkflowRunBudget;
}): WorkflowService {
  const granted = new Set(deps.allowedPermissions ?? []);
  const defaultBudget = deps.defaultBudget ?? {
    maxSteps: 64,
    maxDurationMs: 60_000,
    maxOutputBytes: 1_048_576,
  };

  async function get(ownerId: string, projectId: string, workflowId: string) {
    const value = await deps.repository.get(ownerId, projectId, workflowId);
    if (!value) throw new WorkflowNotFoundError();
    return value;
  }

  return {
    list: (ownerId, projectId) => deps.repository.list(ownerId, projectId),
    get,
    async save(ownerId, projectId, definition, expectedVersion) {
      const parsed = WorkflowDefinitionSchema.safeParse(definition);
      if (!parsed.success || parsed.data.projectId !== projectId) {
        throw new WorkflowValidationError(
          "INVALID_WORKFLOW",
          "Workflow definition or project is invalid",
        );
      }
      validateWorkflow(parsed.data, deps.registry);
      return deps.repository.save(
        ownerId,
        projectId,
        parsed.data,
        expectedVersion,
      );
    },
    async run(input) {
      const record = await get(
        input.ownerId,
        input.projectId,
        input.workflowId,
      );
      const validated = validateWorkflow(record.definition, deps.registry);
      buildPreflightPlan(validated, granted);
      const parsed = ContextEnvelopeSchema.safeParse(input.context);
      if (!parsed.success) {
        throw new WorkflowValidationError(
          "INVALID_WORKFLOW",
          "Input context is invalid",
        );
      }
      for (const node of validated.definition.nodes) {
        if (node.input.source === "workflow_input") {
          const descriptor = validated.descriptors.get(node.id)!;
          if (!descriptor.accepts.includes(parsed.data.type)) {
            throw new WorkflowValidationError(
              "INCOMPATIBLE_CONTEXT",
              "Input context type is not accepted by a root tool",
            );
          }
        }
      }
      const budget = input.budget ?? defaultBudget;
      if (
        !Number.isSafeInteger(budget.maxSteps) ||
        budget.maxSteps < 1 ||
        budget.maxSteps > 10_000 ||
        !Number.isSafeInteger(budget.maxDurationMs) ||
        budget.maxDurationMs < 1 ||
        budget.maxDurationMs > 3_600_000 ||
        !Number.isSafeInteger(budget.maxOutputBytes) ||
        budget.maxOutputBytes < 1 ||
        budget.maxOutputBytes > 104_857_600
      ) {
        throw new WorkflowValidationError(
          "INVALID_WORKFLOW",
          "Execution budget is invalid",
        );
      }
      return deps.enqueue({
        ownerId: input.ownerId,
        projectId: input.projectId,
        workflow: validated,
        workflowVersion: record.version,
        input: parsed.data,
        permissions: new Set(granted),
        budget: { ...budget },
        traceId: input.traceId,
      });
    },
  };
}

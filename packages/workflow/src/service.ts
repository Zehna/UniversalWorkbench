import type {
  Execution,
  ExecutionBudget,
  ToolCapability,
  WorkflowDocumentView,
} from "@uw/contracts";
import type {
  EnqueueQueueJobInput,
  ExecutionQueue,
  ExecutionStepRecord,
  ExecutionStepRepository,
} from "@uw/execution";
import type { ToolRegistry } from "@uw/tools";
import {
  WorkflowExecutionConflictError,
  WorkflowPreflightError,
} from "./errors.js";
import { buildWorkflowPlan } from "./planner.js";
import { validateWorkflowDefinition } from "./validate.js";

export interface CanonicalWorkflowRevisionPort {
  assertCanonicalWorkflowRevision(
    ownerId: string,
    projectId: string,
    workflowId: string,
    workflowRevisionId: string,
  ): Promise<WorkflowDocumentView>;
}

export interface WorkflowExecutionEnqueuer {
  enqueueWorkflowExecution(input: {
    ownerId: string;
    projectId: string;
    workflowRevisionId: string;
    idempotencyKey: string;
    budget?: ExecutionBudget;
  }): Promise<Execution>;
}

export type WorkflowStepPort = Pick<
  ExecutionStepRepository,
  "listByExecution" | "create"
>;

export type WorkflowQueuePort = Pick<ExecutionQueue, "enqueue">;

export interface WorkflowClock {
  now(): Date;
}

export interface WorkflowIdGenerator {
  next(): string;
}

export interface EnqueueWorkflowRunInput {
  ownerId: string;
  projectId: string;
  workflowId: string;
  workflowRevisionId: string;
  idempotencyKey: string;
  budget: ExecutionBudget;
}

export interface EnqueueWorkflowRunResult {
  execution: Execution;
  steps: ExecutionStepRecord[];
}

export interface WorkflowService {
  validateRevision(input: {
    ownerId: string;
    projectId: string;
    workflowId: string;
    workflowRevisionId: string;
    budget: ExecutionBudget;
  }): Promise<WorkflowDocumentView>;
  enqueueRun(input: EnqueueWorkflowRunInput): Promise<EnqueueWorkflowRunResult>;
}

export interface CreateWorkflowServiceOptions {
  canonical: CanonicalWorkflowRevisionPort;
  executions: WorkflowExecutionEnqueuer;
  steps: WorkflowStepPort;
  queue: WorkflowQueuePort;
  tools: ToolRegistry;
  allowedCapabilities: Iterable<ToolCapability>;
  clock: WorkflowClock;
  idGenerator: WorkflowIdGenerator;
}

function newStep(
  executionId: string,
  node: WorkflowDocumentView["revision"]["content"]["workflow"]["nodes"][number],
  root: boolean,
  idGenerator: WorkflowIdGenerator,
): ExecutionStepRecord {
  return {
    id: idGenerator.next(),
    executionId,
    nodeId: node.id,
    toolId: node.tool.id,
    toolVersion: node.tool.version,
    config: structuredClone(node.config),
    status: root ? "queued" : "pending",
    attempt: 0,
    inputContextIds: [],
    outputContextIds: [],
    startedAt: null,
    finishedAt: null,
    error: null,
    usage: {
      outputBytes: 0,
      httpRequests: 0,
    },
  };
}

export function createWorkflowService(
  options: CreateWorkflowServiceOptions,
): WorkflowService {
  const {
    canonical,
    executions,
    steps,
    queue,
    tools,
    clock,
    idGenerator,
  } = options;
  const allowedCapabilities = [...options.allowedCapabilities];

  async function validateCanonical(input: {
    ownerId: string;
    projectId: string;
    workflowId: string;
    workflowRevisionId: string;
    budget: ExecutionBudget;
  }): Promise<WorkflowDocumentView> {
    const view = await canonical.assertCanonicalWorkflowRevision(
      input.ownerId,
      input.projectId,
      input.workflowId,
      input.workflowRevisionId,
    );
    const result = validateWorkflowDefinition(
      view.revision.content.workflow,
      tools,
      allowedCapabilities,
      input.budget,
    );
    if (!result.ok) {
      throw new WorkflowPreflightError(result.errors);
    }
    return view;
  }

  return {
    validateRevision(input) {
      return validateCanonical(input);
    },

    async enqueueRun(input) {
      const view = await validateCanonical(input);
      const execution = await executions.enqueueWorkflowExecution({
        ownerId: input.ownerId,
        projectId: input.projectId,
        workflowRevisionId: input.workflowRevisionId,
        idempotencyKey: input.idempotencyKey,
        budget: input.budget,
      });

      if (execution.workflowRevisionId !== input.workflowRevisionId) {
        throw new WorkflowExecutionConflictError(
          "Idempotency key already belongs to a different workflow revision",
        );
      }

      const definition = view.revision.content.workflow;
      const plan = buildWorkflowPlan(definition);
      const rootIds = new Set(plan.roots);
      const existing = await steps.listByExecution(execution.id);
      const byNode = new Map(existing.map((step) => [step.nodeId, step]));
      const reconciled: ExecutionStepRecord[] = [];

      for (const node of definition.nodes) {
        const current = byNode.get(node.id);
        if (current) {
          if (
            current.toolId !== node.tool.id ||
            current.toolVersion !== node.tool.version
          ) {
            throw new WorkflowPreflightError([
              {
                code: "UNKNOWN_TOOL",
                nodeId: node.id,
                message: `Persisted step ${node.id} does not match the pinned tool version`,
              },
            ]);
          }
          reconciled.push(current);
          continue;
        }

        const created = await steps.create(
          newStep(execution.id, node, rootIds.has(node.id), idGenerator),
        );
        reconciled.push(created);
      }

      const now = clock.now().toISOString();
      for (const step of reconciled) {
        if (!rootIds.has(step.nodeId) || step.status !== "queued") continue;
        const job: EnqueueQueueJobInput = {
          id: step.id,
          executionId: execution.id,
          stepExecutionId: step.id,
          queueType: "step",
          attempt: step.attempt,
          availableAt: now,
          createdAt: now,
        };
        await queue.enqueue(job);
      }

      return { execution, steps: reconciled };
    },
  };
}

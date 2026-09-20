import type { Execution, ExecutionBudget, ExecutionKind } from "@uw/contracts";
import type { Clock, IdGenerator } from "@uw/shared";
import { DEFAULT_EXECUTION_BUDGET, assertExecutionBudget } from "./budget.js";
import type { ExecutionReceiptRepository } from "./receipt.js";
import type { ExecutionRepository } from "./repository.js";
import type { ProvenanceRepository } from "./provenance.js";

export interface EnqueueExecutionBaseInput {
  ownerId: string;
  projectId: string;
  idempotencyKey: string;
  budget?: ExecutionBudget;
}

export interface EnqueueWorkflowExecutionInput extends EnqueueExecutionBaseInput {
  workflowRevisionId: string;
}

export type EnqueueToolExecutionInput = EnqueueExecutionBaseInput;

export interface ExecutionService {
  enqueueWorkflowExecution(
    input: EnqueueWorkflowExecutionInput,
  ): Promise<Execution>;
  enqueueToolExecution(input: EnqueueToolExecutionInput): Promise<Execution>;
  get(ownerId: string, executionId: string): Promise<Execution | null>;
  requestCancellation(
    ownerId: string,
    executionId: string,
  ): Promise<Execution | null>;
  listReceipts(
    ownerId: string,
    executionId: string,
  ): ReturnType<ExecutionReceiptRepository["listByExecution"]>;
  listProvenance(
    ownerId: string,
    executionId: string,
  ): ReturnType<ProvenanceRepository["listByExecution"]>;
}

interface ExecutionServiceDependencies {
  executions: ExecutionRepository;
  receipts: ExecutionReceiptRepository;
  provenance: ProvenanceRepository;
  clock: Clock;
  idGenerator: IdGenerator;
}

export function createExecutionService(
  dependencies: ExecutionServiceDependencies,
): ExecutionService {
  const { executions, receipts, provenance, clock, idGenerator } = dependencies;

  async function enqueue(
    kind: ExecutionKind,
    input: EnqueueExecutionBaseInput,
    workflowRevisionId?: string,
  ): Promise<Execution> {
    const existing = await executions.findByIdempotencyKey({
      ownerId: input.ownerId,
      projectId: input.projectId,
      kind,
      idempotencyKey: input.idempotencyKey,
    });
    if (existing) return existing;

    const now = clock.now().toISOString();
    const execution: Execution = {
      id: idGenerator.next(),
      ownerId: input.ownerId,
      projectId: input.projectId,
      kind,
      status: "queued",
      traceId: idGenerator.next(),
      idempotencyKey: input.idempotencyKey,
      budget: assertExecutionBudget(
        structuredClone(input.budget ?? DEFAULT_EXECUTION_BUDGET),
      ),
      queuedAt: now,
      ...(workflowRevisionId ? { workflowRevisionId } : {}),
    };

    return executions.create({ execution });
  }

  async function requireOwnedExecution(
    ownerId: string,
    executionId: string,
  ): Promise<Execution | null> {
    return executions.getById(ownerId, executionId);
  }

  return {
    enqueueWorkflowExecution(input) {
      return enqueue("workflow", input, input.workflowRevisionId);
    },

    enqueueToolExecution(input) {
      return enqueue("tool", input);
    },

    get(ownerId, executionId) {
      return requireOwnedExecution(ownerId, executionId);
    },

    requestCancellation(ownerId, executionId) {
      return executions.requestCancellation({
        ownerId,
        executionId,
        now: clock.now().toISOString(),
      });
    },

    async listReceipts(ownerId, executionId) {
      const execution = await requireOwnedExecution(ownerId, executionId);
      if (!execution) return [];
      return receipts.listByExecution(executionId);
    },

    async listProvenance(ownerId, executionId) {
      const execution = await requireOwnedExecution(ownerId, executionId);
      if (!execution) return [];
      return provenance.listByExecution(executionId);
    },
  };
}

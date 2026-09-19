import { describe, expect, it } from "vitest";
import type { Execution, ExecutionReceipt } from "@uw/contracts";
import type { Clock, IdGenerator } from "@uw/shared";
import {
  createExecutionService,
  type ExecutionRepository,
  type ExecutionReceiptRepository,
  type ProvenanceEdge,
  type ProvenanceRepository,
} from "../src/index.js";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const WORKFLOW_REVISION_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-09-20T00:00:00.000Z");

class FixedClock implements Clock {
  now(): Date {
    return NOW;
  }
}

class SequenceIds implements IdGenerator {
  #ids = [
    "44444444-4444-4444-8444-444444444444",
    "55555555-5555-4555-8555-555555555555",
    "66666666-6666-4666-8666-666666666666",
    "77777777-7777-4777-8777-777777777777",
  ];

  next(): string {
    const value = this.#ids.shift();
    if (!value) throw new Error("No IDs left");
    return value;
  }
}

class MemoryExecutions implements ExecutionRepository {
  readonly rows = new Map<string, Execution>();

  async create(input: { execution: Execution }): Promise<Execution> {
    const existing = await this.findByIdempotencyKey({
      ownerId: input.execution.ownerId,
      projectId: input.execution.projectId,
      kind: input.execution.kind,
      idempotencyKey: input.execution.idempotencyKey,
    });
    if (existing) return existing;
    this.rows.set(input.execution.id, structuredClone(input.execution));
    return structuredClone(input.execution);
  }

  async getById(ownerId: string, executionId: string) {
    const value = this.rows.get(executionId);
    return value?.ownerId === ownerId ? structuredClone(value) : null;
  }

  async findByIdempotencyKey(input: {
    ownerId: string;
    projectId: string;
    kind: "tool" | "workflow";
    idempotencyKey: string;
  }) {
    const value = [...this.rows.values()].find(
      (row) =>
        row.ownerId === input.ownerId &&
        row.projectId === input.projectId &&
        row.kind === input.kind &&
        row.idempotencyKey === input.idempotencyKey,
    );
    return value ? structuredClone(value) : null;
  }

  async transition() {
    throw new Error("not used");
  }

  async requestCancellation(input: {
    ownerId: string;
    executionId: string;
    now: string;
  }) {
    const current = this.rows.get(input.executionId);
    if (!current || current.ownerId !== input.ownerId) return null;
    if (
      ["succeeded", "failed", "cancelled", "timed_out"].includes(current.status)
    ) {
      return structuredClone(current);
    }
    const updated = {
      ...current,
      cancellationRequestedAt: input.now,
    };
    this.rows.set(updated.id, updated);
    return structuredClone(updated);
  }
}

class MemoryReceipts implements ExecutionReceiptRepository {
  readonly rows: ExecutionReceipt[] = [];
  async append(receipt: ExecutionReceipt) {
    this.rows.push(structuredClone(receipt));
  }
  async listByExecution(executionId: string) {
    return this.rows
      .filter((receipt) => receipt.executionId === executionId)
      .map((receipt) => structuredClone(receipt));
  }
}

class MemoryProvenance implements ProvenanceRepository {
  readonly rows: ProvenanceEdge[] = [];
  async append(edge: ProvenanceEdge) {
    this.rows.push(structuredClone(edge));
  }
  async listByExecution(executionId: string) {
    return this.rows
      .filter((edge) => edge.executionId === executionId)
      .map((edge) => structuredClone(edge));
  }
}

function service() {
  return createExecutionService({
    executions: new MemoryExecutions(),
    receipts: new MemoryReceipts(),
    provenance: new MemoryProvenance(),
    clock: new FixedClock(),
    idGenerator: new SequenceIds(),
  });
}

describe("ExecutionService", () => {
  it("returns the original workflow execution for a duplicate idempotency key", async () => {
    const sut = service();
    const input = {
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      workflowRevisionId: WORKFLOW_REVISION_ID,
      idempotencyKey: "same-run",
    };

    const first = await sut.enqueueWorkflowExecution(input);
    const duplicate = await sut.enqueueWorkflowExecution(input);

    expect(duplicate.id).toBe(first.id);
    expect(duplicate.traceId).toBe(first.traceId);
    expect(duplicate.status).toBe("queued");
  });

  it("scopes the same idempotency key by project and execution kind", async () => {
    const sut = service();

    const workflow = await sut.enqueueWorkflowExecution({
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      workflowRevisionId: WORKFLOW_REVISION_ID,
      idempotencyKey: "shared",
    });
    const tool = await sut.enqueueToolExecution({
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      idempotencyKey: "shared",
    });

    expect(tool.id).not.toBe(workflow.id);
  });

  it("records cancellation only for a non-terminal execution", async () => {
    const executions = new MemoryExecutions();
    const sut = createExecutionService({
      executions,
      receipts: new MemoryReceipts(),
      provenance: new MemoryProvenance(),
      clock: new FixedClock(),
      idGenerator: new SequenceIds(),
    });

    const queued = await sut.enqueueToolExecution({
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      idempotencyKey: "cancel-me",
    });
    const requested = await sut.requestCancellation(OWNER_ID, queued.id);

    expect(requested?.cancellationRequestedAt).toBe(NOW.toISOString());

    executions.rows.set(queued.id, {
      ...queued,
      status: "succeeded",
      finishedAt: NOW.toISOString(),
      cancellationRequestedAt: undefined,
    });

    const terminal = await sut.requestCancellation(OWNER_ID, queued.id);
    expect(terminal?.status).toBe("succeeded");
    expect(terminal?.cancellationRequestedAt).toBeUndefined();
  });
});

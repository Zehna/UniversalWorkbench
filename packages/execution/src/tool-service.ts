import { isDeepStrictEqual } from "node:util";
import type {
  Execution,
  ExecutionBudget,
  JsonObject,
  ToolReference,
} from "@uw/contracts";
import type { Clock, IdGenerator } from "@uw/shared";
import type { ToolRegistry } from "@uw/tools";
import type { ExecutionQueue } from "./queue.js";
import type {
  ExecutionStepRecord,
  ExecutionStepRepository,
} from "./repository.js";
import type { ExecutionService } from "./service.js";

export class DirectToolInputRequiredError extends Error {
  constructor(readonly toolId: string, readonly toolVersion: string) {
    super(
      `Tool ${toolId}@${toolVersion} requires bound input contexts; use a workflow`,
    );
    this.name = "DirectToolInputRequiredError";
  }
}

export class DirectToolExecutionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DirectToolExecutionConflictError";
  }
}

export interface EnqueueDirectToolRunInput {
  ownerId: string;
  projectId: string;
  idempotencyKey: string;
  tool: ToolReference;
  config: JsonObject;
  budget?: ExecutionBudget;
}

export interface DirectToolExecutionResult {
  execution: Execution;
  step: ExecutionStepRecord;
}

export interface DirectToolExecutionService {
  enqueueToolRun(
    input: EnqueueDirectToolRunInput,
  ): Promise<DirectToolExecutionResult>;
}

interface CreateDirectToolExecutionServiceOptions {
  executions: Pick<ExecutionService, "enqueueToolExecution">;
  steps: Pick<ExecutionStepRepository, "listByExecution" | "create">;
  queue: Pick<ExecutionQueue, "enqueue">;
  tools: ToolRegistry;
  clock: Clock;
  idGenerator: IdGenerator;
}

function assertSameStep(
  step: ExecutionStepRecord,
  input: EnqueueDirectToolRunInput,
): void {
  if (
    step.nodeId !== "tool" ||
    step.toolId !== input.tool.id ||
    step.toolVersion !== input.tool.version ||
    !isDeepStrictEqual(step.config, input.config)
  ) {
    throw new DirectToolExecutionConflictError(
      "Idempotency key already belongs to a different direct tool run",
    );
  }
}

export function createDirectToolExecutionService(
  options: CreateDirectToolExecutionServiceOptions,
): DirectToolExecutionService {
  const { executions, steps, queue, tools, clock, idGenerator } = options;

  return {
    async enqueueToolRun(input) {
      const registered = tools.resolve(input.tool.id, input.tool.version);
      if (registered.definition.accepts.some((port) => port.required)) {
        throw new DirectToolInputRequiredError(
          registered.definition.id,
          registered.definition.version,
        );
      }

      const execution = await executions.enqueueToolExecution({
        ownerId: input.ownerId,
        projectId: input.projectId,
        idempotencyKey: input.idempotencyKey,
        ...(input.budget === undefined ? {} : { budget: input.budget }),
      });

      const existing = await steps.listByExecution(execution.id);
      if (existing.length > 1) {
        throw new DirectToolExecutionConflictError(
          "Direct tool execution has multiple persisted steps",
        );
      }

      let step = existing[0];
      if (step) {
        assertSameStep(step, input);
      } else {
        step = await steps.create({
          id: idGenerator.next(),
          executionId: execution.id,
          nodeId: "tool",
          toolId: input.tool.id,
          toolVersion: input.tool.version,
          config: structuredClone(input.config),
          status: "queued",
          attempt: 0,
          inputContextIds: [],
          outputContextIds: [],
          startedAt: null,
          finishedAt: null,
          error: null,
          usage: { outputBytes: 0, httpRequests: 0 },
        });
        assertSameStep(step, input);
      }

      if (step.status === "queued" && execution.status === "queued") {
        const now = clock.now().toISOString();
        await queue.enqueue({
          id: step.id,
          executionId: execution.id,
          stepExecutionId: step.id,
          queueType: "step",
          attempt: step.attempt,
          availableAt: now,
          createdAt: now,
        });
      }

      return { execution, step };
    },
  };
}

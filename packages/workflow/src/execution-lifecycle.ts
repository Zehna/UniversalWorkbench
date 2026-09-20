import type {
  Execution,
  StepExecutionStatus,
  WorkflowDefinitionV1,
} from "@uw/contracts";
import type {
  EnqueueQueueJobInput,
  ExecutionOutputRepository,
  ExecutionQueue,
  ExecutionRepository,
  ExecutionStepLifecycle,
  ExecutionStepRecord,
  ExecutionStepRepository,
  ProvenanceRepository,
} from "@uw/execution";
import { buildWorkflowPlan } from "./planner.js";

const terminalStatuses = new Set<StepExecutionStatus>([
  "succeeded",
  "failed",
  "skipped",
  "cancelled",
  "timed_out",
]);

const failedStatuses = new Set<StepExecutionStatus>([
  "failed",
  "cancelled",
  "timed_out",
]);

export interface PinnedWorkflowRevisionLoader {
  loadPinnedRevision(input: {
    ownerId: string;
    projectId: string;
    workflowRevisionId: string;
  }): Promise<WorkflowDefinitionV1>;
}

export interface WorkflowLifecycleClock {
  now(): Date;
}

export interface WorkflowLifecycleIdGenerator {
  next(): string;
}

export interface WorkflowExecutionLifecycle extends ExecutionStepLifecycle {
  inspect(executionId: string): Promise<ExecutionStepRecord[]>;
}

export interface CreateWorkflowExecutionLifecycleOptions {
  workflows: PinnedWorkflowRevisionLoader;
  executions: ExecutionRepository;
  steps: ExecutionStepRepository;
  outputs: ExecutionOutputRepository;
  queue: Pick<ExecutionQueue, "enqueue">;
  provenance: ProvenanceRepository;
  clock: WorkflowLifecycleClock;
  edgeIds: WorkflowLifecycleIdGenerator;
}

function descendants(
  startNodeId: string,
  dependents: Record<string, string[]>,
): Set<string> {
  const found = new Set<string>();
  const pending = [...(dependents[startNodeId] ?? [])];

  while (pending.length > 0) {
    const nodeId = pending.shift()!;
    if (found.has(nodeId)) continue;
    found.add(nodeId);
    pending.push(...(dependents[nodeId] ?? []));
  }

  return found;
}

async function transitionWorkflowTerminal(
  executions: ExecutionRepository,
  execution: Execution,
  steps: readonly ExecutionStepRecord[],
  now: string,
): Promise<void> {
  if (
    execution.status === "succeeded" ||
    execution.status === "failed" ||
    execution.status === "cancelled" ||
    execution.status === "timed_out"
  ) {
    return;
  }

  if (!steps.every((step) => terminalStatuses.has(step.status))) return;

  const hasFailure = steps.some(
    (step) => step.status === "failed" || step.status === "timed_out",
  );
  const hasCancellation = steps.some((step) => step.status === "cancelled");
  const target = hasFailure
    ? "failed"
    : hasCancellation
      ? "cancelled"
      : "succeeded";

  if (execution.status !== "running") return;

  await executions.transition({
    ownerId: execution.ownerId,
    executionId: execution.id,
    from: "running",
    to: target,
    now,
    error:
      target === "failed"
        ? {
            code: "TOOL_BUG",
            message: "Workflow execution failed because a step failed",
          }
        : null,
  });
}

export function createWorkflowExecutionLifecycle(
  options: CreateWorkflowExecutionLifecycleOptions,
): WorkflowExecutionLifecycle {
  const {
    workflows,
    executions,
    steps,
    outputs,
    queue,
    provenance,
    clock,
    edgeIds,
  } = options;

  async function appendProvenance(
    execution: Execution,
    step: ExecutionStepRecord,
  ): Promise<void> {
    if (step.status !== "succeeded") return;

    const [stepOutputs, existing] = await Promise.all([
      outputs.listByStep(step.id),
      provenance.listByExecution(execution.id),
    ]);
    const existingKeys = new Set(
      existing.map(
        (edge) =>
          `${edge.sourceKind}:${edge.sourceId}->${edge.targetKind}:${edge.targetId}:${edge.relation}`,
      ),
    );

    for (const output of stepOutputs) {
      for (const parentId of output.context.provenance.parentContextIds) {
        const key = `context:${parentId}->context:${output.contextId}:derived-from`;
        if (existingKeys.has(key)) continue;

        await provenance.append({
          id: edgeIds.next(),
          projectId: execution.projectId,
          executionId: execution.id,
          stepExecutionId: step.id,
          sourceKind: "context",
          sourceId: parentId,
          targetKind: "context",
          targetId: output.contextId,
          relation: "derived-from",
          createdAt: clock.now().toISOString(),
        });
        existingKeys.add(key);
      }
    }
  }

  async function skipFailedDescendants(
    definition: WorkflowDefinitionV1,
    terminalStep: ExecutionStepRecord,
    current: ExecutionStepRecord[],
  ): Promise<void> {
    if (!failedStatuses.has(terminalStep.status)) return;

    const plan = buildWorkflowPlan(definition);
    const blocked = descendants(terminalStep.nodeId, plan.dependents);
    const now = clock.now().toISOString();

    for (const step of current) {
      if (!blocked.has(step.nodeId) || step.status !== "pending") continue;
      await steps.transition({
        stepExecutionId: step.id,
        from: "pending",
        to: "skipped",
        now,
        error: null,
        usage: step.usage,
      });
    }
  }

  async function inputContextIdsFor(
    definition: WorkflowDefinitionV1,
    nodeId: string,
    current: readonly ExecutionStepRecord[],
  ): Promise<string[]> {
    const stepByNode = new Map(current.map((step) => [step.nodeId, step]));
    const ids: string[] = [];

    for (const edge of definition.edges) {
      if (edge.to.nodeId !== nodeId) continue;
      const upstream = stepByNode.get(edge.from.nodeId);
      if (!upstream || upstream.status !== "succeeded") {
        throw new Error(
          `Workflow dependency ${edge.from.nodeId} is not succeeded`,
        );
      }

      const records = await outputs.listByStep(upstream.id);
      const record = records.find(
        (candidate) => candidate.portName === edge.from.output,
      );
      if (!record) {
        throw new Error(
          `Workflow output ${edge.from.nodeId}.${edge.from.output} is missing`,
        );
      }
      ids.push(record.contextId);
    }

    return ids;
  }

  async function queueReadyNodes(
    definition: WorkflowDefinitionV1,
    current: ExecutionStepRecord[],
  ): Promise<void> {
    const plan = buildWorkflowPlan(definition);
    const byNode = new Map(current.map((step) => [step.nodeId, step]));
    const now = clock.now().toISOString();

    for (const nodeId of plan.order) {
      const step = byNode.get(nodeId);
      if (!step) throw new Error(`Workflow step ${nodeId} is missing`);
      if (step.status !== "pending" && step.status !== "queued") continue;

      const dependencyIds = plan.dependencies[nodeId] ?? [];
      const ready = dependencyIds.every(
        (dependency) => byNode.get(dependency)?.status === "succeeded",
      );
      if (!ready) continue;

      let queuedStep = step;
      if (step.status === "pending") {
        const inputContextIds = await inputContextIdsFor(
          definition,
          nodeId,
          current,
        );
        const transitioned = await steps.transition({
          stepExecutionId: step.id,
          from: "pending",
          to: "queued",
          now,
          inputContextIds,
          error: null,
          usage: step.usage,
        });
        if (!transitioned) {
          const refreshed = await steps.getById(step.id);
          if (!refreshed) throw new Error(`Workflow step ${nodeId} disappeared`);
          queuedStep = refreshed;
        } else {
          queuedStep = transitioned;
        }
        byNode.set(nodeId, queuedStep);
      }

      if (queuedStep.status !== "queued") continue;
      const job: EnqueueQueueJobInput = {
        id: queuedStep.id,
        executionId: queuedStep.executionId,
        stepExecutionId: queuedStep.id,
        queueType: "step",
        attempt: queuedStep.attempt,
        availableAt: now,
        createdAt: now,
      };
      await queue.enqueue(job);
    }
  }

  return {
    inspect(executionId) {
      return steps.listByExecution(executionId);
    },

    async onTerminalStep({ execution, step }) {
      if (execution.kind !== "workflow") return;
      if (!execution.workflowRevisionId) {
        throw new Error("Workflow execution is missing workflowRevisionId");
      }

      const definition = await workflows.loadPinnedRevision({
        ownerId: execution.ownerId,
        projectId: execution.projectId,
        workflowRevisionId: execution.workflowRevisionId,
      });

      const durableStep = (await steps.getById(step.id)) ?? step;
      await appendProvenance(execution, durableStep);

      let current = await steps.listByExecution(execution.id);
      await skipFailedDescendants(definition, durableStep, current);

      current = await steps.listByExecution(execution.id);
      if (!current.some((candidate) => failedStatuses.has(candidate.status))) {
        await queueReadyNodes(definition, current);
      }

      current = await steps.listByExecution(execution.id);
      const durableExecution =
        (await executions.getByIdForWorker(execution.id)) ?? execution;
      await transitionWorkflowTerminal(
        executions,
        durableExecution,
        current,
        clock.now().toISOString(),
      );
    },
  };
}

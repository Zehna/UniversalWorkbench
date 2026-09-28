import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { ContextEnvelopeSchema } from "@uw/contracts";
import type { ContextEnvelope, WorkflowNode } from "@uw/contracts";
import { runTool } from "@uw/tools";
import type { ToolRegistry } from "@uw/tools";
import { buildPreflightPlan, validateWorkflow } from "@uw/workflow";
import type { ValidatedWorkflow } from "@uw/workflow";
import { outputSize, requireBudget, validateBudget } from "./budget.js";
import type { ExecutionBudget, ExecutionUsage } from "./budget.js";
import { ExecutionEngineError, safeExecutionError } from "./errors.js";
import type {
  ExecutionRecord,
  ExecutionStepRecord,
  ExecutionView,
} from "./model.js";
import { createExecutionReceipt } from "./receipt.js";
import { canRetry, retryClass } from "./retry.js";
import type { StoredWorkflowRun, WorkflowExecutionStore } from "./store.js";

export interface ExecuteWorkflowInput {
  ownerId: string;
  projectId: string;
  workflow: ValidatedWorkflow;
  input: ContextEnvelope;
  permissions: ReadonlySet<string>;
  budget: ExecutionBudget;
  traceId: string;
  workflowVersion?: number;
}

export interface WorkflowEngine {
  enqueue(input: ExecuteWorkflowInput): Promise<ExecutionRecord>;
  process(executionId: string, signal: AbortSignal): Promise<ExecutionView>;
}

export interface WorkflowEngineDependencies {
  store: WorkflowExecutionStore;
  registry: ToolRegistry;
  now?: () => Date;
  createId?: () => string;
}

function payloadBytes(payload: unknown): number {
  const json = JSON.stringify(payload);
  return json === undefined ? 0 : new TextEncoder().encode(json).byteLength;
}

function existingUsage(steps: readonly ExecutionStepRecord[]): ExecutionUsage {
  return {
    attempts: steps.length,
    inputBytes: steps.reduce(
      (total, step) => total + payloadBytes(step.inputContext.payload),
      0,
    ),
    outputBytes: steps.reduce(
      (total, step) => total + outputSize(step.outputContexts),
      0,
    ),
  };
}

function isTerminal(status: ExecutionRecord["status"]): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  );
}

async function waitFor<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    throw new ExecutionEngineError("CANCELLED", "Workflow was cancelled");
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () =>
      reject(new ExecutionEngineError("CANCELLED", "Workflow was cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    void task.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function bindingInput(
  node: WorkflowNode,
  initial: ContextEnvelope,
  results: ReadonlyMap<string, ContextEnvelope[]>,
): ContextEnvelope {
  if (node.input.source === "workflow_input") return initial;
  const source = results.get(node.input.nodeId);
  const value = source?.[node.input.outputIndex];
  if (!value) {
    throw new ExecutionEngineError(
      "INVALID_OUTPUT",
      "A required dependency output is missing",
    );
  }
  return value;
}

function resultFromStore(item: StoredWorkflowRun): ExecutionView {
  return item.view;
}

export function createWorkflowEngine(
  deps: WorkflowEngineDependencies,
): WorkflowEngine {
  const now = deps.now ?? (() => new Date());
  const createId = deps.createId ?? randomUUID;

  async function reload(executionId: string): Promise<StoredWorkflowRun> {
    const latest = await deps.store.load(executionId);
    if (!latest) {
      throw new ExecutionEngineError(
        "EXECUTION_NOT_FOUND",
        "Execution does not exist",
      );
    }
    return latest;
  }

  return {
    async enqueue(input) {
      const parsed = ContextEnvelopeSchema.safeParse(input.input);
      if (
        !parsed.success ||
        input.workflow.definition.projectId !== input.projectId
      ) {
        throw new ExecutionEngineError(
          "INVALID_INPUT",
          "Workflow input or project is invalid",
        );
      }
      const validated = validateWorkflow(
        input.workflow.definition,
        deps.registry,
      );
      buildPreflightPlan(validated, input.permissions);
      for (const node of validated.definition.nodes) {
        if (node.input.source === "workflow_input") {
          const descriptor = validated.descriptors.get(node.id)!;
          if (!descriptor.accepts.includes(parsed.data.type)) {
            throw new ExecutionEngineError(
              "INVALID_INPUT",
              "Workflow input type is not accepted by a root tool",
            );
          }
        }
      }
      const budget = validateBudget(input.budget);
      const version = input.workflowVersion ?? 1;
      if (!Number.isSafeInteger(version) || version < 1) {
        throw new ExecutionEngineError(
          "INVALID_INPUT",
          "Workflow version must be positive",
        );
      }
      return deps.store.submit({
        id: createId(),
        ownerId: input.ownerId,
        projectId: input.projectId,
        workflowDefinitionId: createId(),
        traceId: input.traceId,
        inputContext: parsed.data,
        createdAt: now(),
        workflow: validated.definition,
        workflowVersion: version,
        grantedPermissions: [...input.permissions].sort(),
        budget,
      });
    },

    async process(executionId, signal) {
      const item = await reload(executionId);
      if (isTerminal(item.view.execution.status)) return resultFromStore(item);

      const validated = validateWorkflow(item.workflow, deps.registry);
      const permissions = new Set(item.grantedPermissions);
      buildPreflightPlan(validated, permissions);
      const budget = validateBudget(item.budget);
      const run = item.view.execution;
      const startedAt = run.startedAt ?? now();
      if (run.status === "queued")
        await deps.store.markRunning(executionId, startedAt);
      const steps = [...item.view.steps];
      const usage = existingUsage(steps);
      const results = new Map<string, ContextEnvelope[]>();
      const initial = ContextEnvelopeSchema.parse(run.inputContext);
      const remainingMs =
        budget.maxDurationMs - (now().getTime() - startedAt.getTime());
      const timeout = AbortSignal.timeout(Math.max(1, remainingMs));
      const combined = AbortSignal.any([signal, timeout]);

      try {
        for (const nodeId of validated.orderedNodeIds) {
          if (signal.aborted) {
            throw new ExecutionEngineError(
              "CANCELLED",
              "Workflow was cancelled",
            );
          }
          requireBudget(budget, usage, startedAt, now(), "output");
          const node = validated.definition.nodes.find(
            (candidate) => candidate.id === nodeId,
          )!;
          const descriptor = validated.descriptors.get(nodeId)!;
          const history = steps
            .filter((step) => step.nodeId === nodeId)
            .sort((left, right) => left.attempt - right.attempt);
          const successful = history.find(
            (step) => step.status === "completed",
          );
          if (successful) {
            results.set(nodeId, successful.outputContexts);
            continue;
          }

          const last = history[history.length - 1];
          if (last?.status === "running") {
            if (retryClass(descriptor, node) === "unsafe") {
              throw new ExecutionEngineError(
                "UNCERTAIN_OUTCOME",
                "A non-idempotent tool has an unresolved previous attempt",
              );
            }
            const interrupted = safeExecutionError(
              new ExecutionEngineError(
                "UNCERTAIN_OUTCOME",
                "Previous attempt was interrupted",
              ),
            );
            await deps.store.finishStep({
              id: last.id,
              executionId,
              nodeId,
              attempt: last.attempt,
              status: "interrupted",
              finishedAt: now(),
              outputContexts: [],
              error: interrupted,
            });
            last.status = "interrupted";
            last.finishedAt = now();
            last.error = interrupted;
          }
          if (
            last &&
            !canRetry(
              descriptor,
              node,
              last.attempt,
              last.error?.code ?? "TOOL_FAILED",
            )
          ) {
            throw new ExecutionEngineError(
              "TOOL_FAILED",
              "Workflow step exhausted its permitted attempts",
            );
          }

          const source = bindingInput(node, initial, results);
          if (!descriptor.accepts.includes(source.type)) {
            throw new ExecutionEngineError(
              "INVALID_INPUT",
              "Runtime input type does not match the pinned tool descriptor",
            );
          }

          const max = node.retry?.maxAttempts ?? 1;
          for (
            let attempt = (last?.attempt ?? 0) + 1;
            attempt <= max;
            attempt++
          ) {
            requireBudget(budget, usage, startedAt, now());
            const started = now();
            const step: ExecutionStepRecord = {
              id: createId(),
              executionId,
              nodeId,
              toolId: descriptor.id,
              toolVersion: descriptor.version,
              attempt,
              status: "running",
              startedAt: started,
              finishedAt: null,
              inputContext: source,
              outputContexts: [],
              error: null,
              idempotencyKey: node.idempotencyKey ?? null,
            };
            await deps.store.startStep(step);
            steps.push(step);
            usage.attempts += 1;
            usage.inputBytes += payloadBytes(source.payload);
            const durationLeft =
              budget.maxDurationMs - (now().getTime() - startedAt.getTime());
            const nodeTimeout = AbortSignal.timeout(
              Math.max(
                1,
                Math.min(durationLeft, node.timeoutMs ?? durationLeft),
              ),
            );
            const callSignal = AbortSignal.any([combined, nodeTimeout]);
            try {
              const executor = deps.registry.resolve(
                node.toolId,
                node.toolVersion,
              );
              const tool = await waitFor(
                runTool(executor, source, node.config, {
                  executionId,
                  stepId: step.id,
                  projectId: run.projectId,
                  traceId: run.traceId,
                  signal: callSignal,
                  permissions,
                  ...(node.idempotencyKey
                    ? { idempotencyKey: node.idempotencyKey }
                    : {}),
                }),
                callSignal,
              );
              if (signal.aborted) {
                throw new ExecutionEngineError(
                  "CANCELLED",
                  "Workflow was cancelled",
                );
              }
              if (
                timeout.aborted ||
                now().getTime() - startedAt.getTime() >= budget.maxDurationMs
              ) {
                throw new ExecutionEngineError(
                  "BUDGET_DURATION",
                  "Workflow duration budget exceeded",
                );
              }
              if (nodeTimeout.aborted) {
                throw new ExecutionEngineError(
                  "TIMEOUT",
                  "Workflow step timed out",
                );
              }
              // Bindings are positional; a descriptor's produces[outputIndex]
              // must match the actual output at that index.
              if (
                tool.outputs.some(
                  (output, index) => descriptor.produces[index] !== output.type,
                )
              ) {
                throw new ExecutionEngineError(
                  "INVALID_OUTPUT",
                  "Tool output positions are incompatible",
                );
              }
              const bytes = outputSize(tool.outputs);
              if (usage.outputBytes + bytes > budget.maxOutputBytes) {
                throw new ExecutionEngineError(
                  "BUDGET_OUTPUT",
                  "Workflow output byte budget exceeded",
                );
              }
              await deps.store.finishStep({
                id: step.id,
                executionId,
                nodeId,
                attempt,
                status: "completed",
                finishedAt: now(),
                outputContexts: tool.outputs,
                error: null,
              });
              step.status = "completed";
              step.finishedAt = now();
              step.outputContexts = tool.outputs;
              usage.outputBytes += bytes;
              results.set(nodeId, tool.outputs);
              break;
            } catch (error) {
              const normalized = signal.aborted
                ? new ExecutionEngineError(
                    "CANCELLED",
                    "Workflow was cancelled",
                  )
                : timeout.aborted
                  ? new ExecutionEngineError(
                      "BUDGET_DURATION",
                      "Workflow duration budget exceeded",
                    )
                  : nodeTimeout.aborted
                    ? new ExecutionEngineError(
                        "TIMEOUT",
                        "Workflow step timed out",
                      )
                    : error;
              const structured = safeExecutionError(normalized);
              if (step.status === "running") {
                await deps.store.finishStep({
                  id: step.id,
                  executionId,
                  nodeId,
                  attempt,
                  status:
                    structured.code === "CANCELLED" ? "cancelled" : "failed",
                  finishedAt: now(),
                  outputContexts: [],
                  error: structured,
                });
                step.status =
                  structured.code === "CANCELLED" ? "cancelled" : "failed";
                step.finishedAt = now();
                step.error = structured;
              }
              if (!canRetry(descriptor, node, attempt, structured.code)) {
                throw new ExecutionEngineError(
                  structured.code === "CANCELLED"
                    ? "CANCELLED"
                    : structured.code === "BUDGET_OUTPUT"
                      ? "BUDGET_OUTPUT"
                      : structured.code === "BUDGET_DURATION"
                        ? "BUDGET_DURATION"
                        : structured.code === "TIMEOUT"
                          ? "TIMEOUT"
                          : "TOOL_FAILED",
                  structured.code === "CANCELLED"
                    ? "Workflow was cancelled"
                    : "Workflow step failed",
                );
              }
              try {
                await sleep(node.retry?.backoffMs ?? 0, undefined, {
                  signal: combined,
                });
              } catch {
                throw new ExecutionEngineError(
                  signal.aborted ? "CANCELLED" : "BUDGET_DURATION",
                  "Workflow was interrupted during retry backoff",
                );
              }
            }
          }
        }

        const finishedAt = now();
        requireBudget(budget, usage, startedAt, finishedAt, "output");
        const receipt = createExecutionReceipt({
          executionId,
          workflow: item.workflow,
          workflowVersion: item.workflowVersion,
          status: "completed",
          startedAt,
          finishedAt,
          usage,
          steps,
        });
        await deps.store.complete({
          executionId,
          finishedAt,
          usage: { ...usage },
          receipt,
        });
        return (await reload(executionId)).view;
      } catch (error) {
        // Storage failures must propagate to the queue for a fenced retry.
        // Only known engine-level failures cause terminal transitions.
        if (
          !(error instanceof ExecutionEngineError) &&
          !signal.aborted &&
          !timeout.aborted
        ) {
          throw error;
        }
        const issue = signal.aborted
          ? new ExecutionEngineError("CANCELLED", "Workflow was cancelled")
          : timeout.aborted
            ? new ExecutionEngineError(
                "BUDGET_DURATION",
                "Workflow duration budget exceeded",
              )
            : error;
        const structured = safeExecutionError(issue);
        const status = structured.code === "CANCELLED" ? "cancelled" : "failed";
        const finishedAt = now();
        const receipt = createExecutionReceipt({
          executionId,
          workflow: item.workflow,
          workflowVersion: item.workflowVersion,
          status,
          startedAt,
          finishedAt,
          usage,
          steps,
          errorCode: structured.code,
        });
        if (status === "cancelled") {
          await deps.store.cancel(executionId, finishedAt, receipt);
        } else {
          await deps.store.fail({
            executionId,
            finishedAt,
            error: structured,
            usage: { ...usage },
            receipt,
          });
        }
        return (await reload(executionId)).view;
      }
    },
  };
}

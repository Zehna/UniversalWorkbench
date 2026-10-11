import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { ContextEnvelopeSchema } from "@uw/contracts";
import type { ContextEnvelope, WorkflowNode } from "@uw/contracts";
import { redactSecrets } from "@uw/shared";
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
  resolveApproval(
    executionId: string,
    resolution: ResolveApprovalInput,
    signal?: AbortSignal,
  ): Promise<ExecutionView>;
}

export interface ResolveApprovalInput {
  decision: "approved" | "rejected";
  rejectionReason?: string;
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

function aiTokensOf(output: ContextEnvelope): {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
} {
  if (output.type !== "ai_response" && output.type !== "agent_response") {
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  }
  const payload = output.payload as unknown as {
    usage?: {
      promptTokens?: unknown;
      completionTokens?: unknown;
      totalTokens?: unknown;
    };
  };
  const usage = payload?.usage;
  const promptTokens =
    typeof usage?.promptTokens === "number" &&
    Number.isInteger(usage.promptTokens) &&
    usage.promptTokens >= 0
      ? usage.promptTokens
      : 0;
  const completionTokens =
    typeof usage?.completionTokens === "number" &&
    Number.isInteger(usage.completionTokens) &&
    usage.completionTokens >= 0
      ? usage.completionTokens
      : 0;
  const totalTokens =
    typeof usage?.totalTokens === "number" &&
    Number.isInteger(usage.totalTokens) &&
    usage.totalTokens >= 0
      ? usage.totalTokens
      : 0;
  return { promptTokens, completionTokens, totalTokens };
}

function addOutputTokens(
  usage: ExecutionUsage,
  outputs: readonly ContextEnvelope[],
): void {
  for (const output of outputs) {
    const tokens = aiTokensOf(output);
    usage.promptTokens = (usage.promptTokens ?? 0) + tokens.promptTokens;
    usage.completionTokens =
      (usage.completionTokens ?? 0) + tokens.completionTokens;
    usage.totalTokens = (usage.totalTokens ?? 0) + tokens.totalTokens;
  }
}

function existingUsage(steps: readonly ExecutionStepRecord[]): ExecutionUsage {
  const usage: ExecutionUsage = {
    attempts: steps.length,
    inputBytes: steps.reduce(
      (total, step) => total + payloadBytes(step.inputContext.payload),
      0,
    ),
    outputBytes: steps.reduce(
      (total, step) => total + outputSize(step.outputContexts),
      0,
    ),
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
  // Single source of truth is persisted steps: tokens come only from
  // completed ai_response/agent_response payloads, so interrupted/failed
  // attempts add 0 and reclaimed leases reusing completed steps never
  // double-count.
  for (const step of steps) {
    if (step.status !== "completed") continue;
    addOutputTokens(usage, step.outputContexts);
  }
  return usage;
}

function effectiveIdempotencyKey(
  executionId: string,
  node: WorkflowNode,
  descriptorIdempotency: string | undefined,
): string | null {
  if (node.idempotencyKey) return node.idempotencyKey;
  // Worker-generated keys are deterministic per logical step so retries and
  // lease reclaims reuse the same key for provider-side dedup.
  if (descriptorIdempotency === "keyed") return `${executionId}:${node.id}`;
  return null;
}

function isTerminal(status: ExecutionRecord["status"]): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  );
}

function isAwaitingApprovalOutput(
  outputs: readonly ContextEnvelope[],
): boolean {
  for (const output of outputs) {
    if (output.type !== "agent_response") continue;
    const payload = output.payload as unknown as { status?: unknown };
    if (payload?.status === "awaiting_approval") return true;
  }
  return false;
}

function extractPendingApprovals(
  outputs: readonly ContextEnvelope[],
): Array<{ tool: string; toolCallId?: string }> {
  const pending: Array<{ tool: string; toolCallId?: string }> = [];
  for (const output of outputs) {
    if (output.type !== "agent_response") continue;
    const payload = output.payload as unknown as {
      structured?: { pendingApprovals?: unknown };
    };
    const list = payload?.structured?.pendingApprovals;
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (entry === null || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const tool = typeof record["tool"] === "string" ? record["tool"] : "";
      if (!tool) continue;
      const toolCallId =
        typeof record["toolCallId"] === "string"
          ? (record["toolCallId"] as string)
          : undefined;
      pending.push(toolCallId !== undefined ? { tool, toolCallId } : { tool });
    }
  }
  return pending;
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

  const pendingResolutions = new Map<
    string,
    Record<string, ResolveApprovalInput>
  >();

  const engine: WorkflowEngine = {
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
      if (item.view.execution.status === "awaiting_approval") {
        if (!pendingResolutions.has(executionId)) return resultFromStore(item);
      }

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
          const awaitingStep =
            last?.status === "awaiting_approval" ? last : undefined;
          if (awaitingStep && !pendingResolutions.has(executionId)) {
            await deps.store.suspend({
              executionId,
              usage: { ...usage },
            });
            return (await reload(executionId)).view;
          }
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
            last.status !== "awaiting_approval" &&
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

          const baseMax = node.retry?.maxAttempts ?? 1;
          const max =
            awaitingStep !== undefined
              ? Math.max(baseMax, awaitingStep.attempt + 1)
              : baseMax;
          for (
            let attempt = (last?.attempt ?? 0) + 1;
            attempt <= max;
            attempt++
          ) {
            requireBudget(budget, usage, startedAt, now());
            const started = now();
            const stepKey = effectiveIdempotencyKey(
              executionId,
              node,
              descriptor.idempotency,
            );
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
              // Secret-safe persistence: never store raw secret-bearing values.
              inputContext: redactSecrets(source) as ContextEnvelope,
              outputContexts: [],
              error: null,
              idempotencyKey: stepKey,
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
            const storedResolutions = pendingResolutions.get(executionId);
            const effectiveConfig =
              awaitingStep && storedResolutions
                ? {
                    ...(node.config as Record<string, unknown>),
                    approvalResolutions: storedResolutions,
                  }
                : node.config;
            try {
              const executor = deps.registry.resolve(
                node.toolId,
                node.toolVersion,
              );
              const tool = await waitFor(
                runTool(executor, source, effectiveConfig, {
                  executionId,
                  stepId: step.id,
                  projectId: run.projectId,
                  ownerId: run.ownerId,
                  traceId: run.traceId,
                  signal: callSignal,
                  // Re-checked per step from the server grant: AI output
                  // content can request actions but can never widen this set.
                  permissions,
                  ...(stepKey ? { idempotencyKey: stepKey } : {}),
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
              if (isAwaitingApprovalOutput(tool.outputs)) {
                await deps.store.finishStep({
                  id: step.id,
                  executionId,
                  nodeId,
                  attempt,
                  status: "awaiting_approval",
                  finishedAt: now(),
                  outputContexts: tool.outputs,
                  error: null,
                });
                step.status = "awaiting_approval";
                step.finishedAt = now();
                step.outputContexts = tool.outputs;
                usage.outputBytes += bytes;
                addOutputTokens(usage, tool.outputs);
                await deps.store.suspend({
                  executionId,
                  usage: { ...usage },
                });
                return (await reload(executionId)).view;
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
              addOutputTokens(usage, tool.outputs);
              // Post-step token guard: fail fast before enqueueing more work.
              requireBudget(budget, usage, startedAt, now(), "output");
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
                const preserved =
                  structured.code === "CANCELLED"
                    ? "CANCELLED"
                    : structured.code === "BUDGET_OUTPUT"
                      ? "BUDGET_OUTPUT"
                      : structured.code === "BUDGET_DURATION"
                        ? "BUDGET_DURATION"
                        : structured.code === "BUDGET_STEPS"
                          ? "BUDGET_STEPS"
                          : structured.code === "BUDGET_EXCEEDED"
                            ? "BUDGET_EXCEEDED"
                            : structured.code === "TIMEOUT"
                              ? "TIMEOUT"
                              : "TOOL_FAILED";
                throw new ExecutionEngineError(
                  preserved,
                  preserved === "CANCELLED"
                    ? "Workflow was cancelled"
                    : preserved === "BUDGET_EXCEEDED"
                      ? "Workflow token budget exceeded"
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

    async resolveApproval(executionId, resolution, signal) {
      const item = await reload(executionId);
      if (item.view.execution.status !== "awaiting_approval") {
        throw new ExecutionEngineError(
          "INVALID_STATE",
          "Execution is not awaiting approval",
        );
      }
      const decision = resolution.decision;
      if (decision !== "approved" && decision !== "rejected") {
        throw new ExecutionEngineError(
          "INVALID_INPUT",
          "Approval decision must be approved or rejected",
        );
      }
      const rejectionReason =
        typeof resolution.rejectionReason === "string"
          ? resolution.rejectionReason.trim()
          : "";
      if (decision === "rejected" && rejectionReason.length === 0) {
        throw new ExecutionEngineError(
          "INVALID_INPUT",
          "Rejection reason is required",
        );
      }
      const suspendedSteps = item.view.steps.filter(
        (step) => step.status === "awaiting_approval",
      );
      const pending: Array<{ tool: string; toolCallId?: string }> = [];
      for (const step of suspendedSteps) {
        pending.push(...extractPendingApprovals(step.outputContexts));
      }
      if (pending.length === 0) {
        throw new ExecutionEngineError(
          "INVALID_STATE",
          "No pending approvals for execution",
        );
      }
      const mapped: Record<string, ResolveApprovalInput> = {};
      for (const entry of pending) {
        const value: ResolveApprovalInput =
          decision === "approved"
            ? { decision }
            : { decision, rejectionReason };
        if (entry.toolCallId) mapped[entry.toolCallId] = value;
        mapped[entry.tool] = value;
      }
      pendingResolutions.set(executionId, mapped);
      await deps.store.resume(executionId);
      const activeSignal = signal ?? new AbortController().signal;
      const view = await engine.process(executionId, activeSignal);
      if (view.execution.status !== "awaiting_approval") {
        pendingResolutions.delete(executionId);
      }
      return view;
    },
  };
  return engine;
}

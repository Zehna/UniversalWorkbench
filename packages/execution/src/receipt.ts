import type { WorkflowDefinition } from "@uw/contracts";
import type { ExecutionUsage } from "./budget.js";
import type {
  ExecutionJson,
  ExecutionStepRecord,
  ProvenanceEdgeRecord,
} from "./model.js";

export function createExecutionReceipt(input: {
  executionId: string;
  workflow: WorkflowDefinition;
  workflowVersion: number;
  status: "completed" | "failed" | "cancelled";
  startedAt: Date | null;
  finishedAt: Date;
  usage: ExecutionUsage;
  steps: readonly ExecutionStepRecord[];
  errorCode?: string;
}): ExecutionJson {
  const provenance: ProvenanceEdgeRecord[] = [];
  for (const step of input.steps) {
    for (const output of step.outputContexts) {
      for (const sourceId of output.provenance.sourceContextIds) {
        provenance.push({
          fromContextId: sourceId,
          toContextId: output.id,
          nodeId: step.nodeId,
        });
      }
    }
  }
  const receipt: ExecutionJson = {
    executionId: input.executionId,
    workflowId: input.workflow.id,
    workflowVersion: input.workflowVersion,
    workflowSchemaVersion: input.workflow.schemaVersion,
    status: input.status,
    startedAt: input.startedAt?.toISOString() ?? null,
    finishedAt: input.finishedAt.toISOString(),
    usage: { ...input.usage },
    steps: input.steps.map((step) => ({
      nodeId: step.nodeId,
      toolId: step.toolId,
      toolVersion: step.toolVersion,
      attempt: step.attempt,
      status: step.status,
      startedAt: step.startedAt?.toISOString() ?? null,
      finishedAt: step.finishedAt?.toISOString() ?? null,
      outputContextIds: step.outputContexts.map((output) => output.id),
      errorCode: step.error?.code ?? null,
    })),
    outputContextIds: input.steps.flatMap((step) =>
      step.outputContexts.map((output) => output.id),
    ),
    provenance,
  };
  if (input.errorCode) receipt.errorCode = input.errorCode;
  // Intentionally omit node config, headers, input/output payloads and keys.
  return receipt;
}

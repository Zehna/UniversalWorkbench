import type {
  ContextEnvelope,
  Execution,
  WorkflowDefinitionV1,
} from "@uw/contracts";
import type {
  ExecutionOutputRepository,
  ExecutionStepRecord,
  ExecutionStepRepository,
  ExecutionStepRuntimeLoader,
} from "@uw/execution";
import type { PinnedWorkflowRevisionLoader } from "@uw/workflow";

export interface CreateExecutionRuntimeLoaderOptions {
  workflows: PinnedWorkflowRevisionLoader;
  steps: Pick<ExecutionStepRepository, "listByExecution">;
  outputs: Pick<ExecutionOutputRepository, "listByStep">;
}

function nodeFor(
  definition: WorkflowDefinitionV1,
  nodeId: string,
) {
  const node = definition.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error(`Workflow node ${nodeId} was not found`);
  return node;
}

async function workflowInputs(
  execution: Execution,
  step: ExecutionStepRecord,
  definition: WorkflowDefinitionV1,
  options: CreateExecutionRuntimeLoaderOptions,
): Promise<Record<string, ContextEnvelope>> {
  const allSteps = await options.steps.listByExecution(execution.id);
  const byNode = new Map(allSteps.map((candidate) => [candidate.nodeId, candidate]));
  const inputs: Record<string, ContextEnvelope> = {};

  for (const edge of definition.edges) {
    if (edge.to.nodeId !== step.nodeId) continue;
    if (inputs[edge.to.input]) {
      throw new Error(
        `Workflow input ${step.nodeId}.${edge.to.input} has multiple bindings`,
      );
    }

    const upstream = byNode.get(edge.from.nodeId);
    if (!upstream || upstream.status !== "succeeded") {
      throw new Error(
        `Workflow dependency ${edge.from.nodeId} is not succeeded`,
      );
    }
    const output = (await options.outputs.listByStep(upstream.id)).find(
      (candidate) => candidate.portName === edge.from.output,
    );
    if (!output) {
      throw new Error(
        `Workflow output ${edge.from.nodeId}.${edge.from.output} is missing`,
      );
    }
    inputs[edge.to.input] = structuredClone(output.context);
  }

  return inputs;
}

export function createExecutionRuntimeLoader(
  options: CreateExecutionRuntimeLoaderOptions,
): ExecutionStepRuntimeLoader {
  return {
    async load(execution, step) {
      if (execution.kind === "tool") {
        return {
          config: structuredClone(step.config),
          inputs: {},
        };
      }

      if (!execution.workflowRevisionId) {
        throw new Error("Workflow execution is missing workflowRevisionId");
      }
      const definition = await options.workflows.loadPinnedRevision({
        ownerId: execution.ownerId,
        projectId: execution.projectId,
        workflowRevisionId: execution.workflowRevisionId,
      });
      nodeFor(definition, step.nodeId);

      return {
        config: structuredClone(step.config),
        inputs: await workflowInputs(execution, step, definition, options),
      };
    },
  };
}

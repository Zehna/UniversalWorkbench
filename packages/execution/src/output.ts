import type { ContextEnvelope } from "@uw/contracts";
import type { Clock, IdGenerator } from "@uw/shared";

export interface ExecutionOutputRecord {
  id: string;
  executionId: string;
  stepExecutionId: string;
  portName: string;
  contextId: string;
  artifactId: string | null;
  context: ContextEnvelope;
  createdAt: string;
}

export interface ExecutionOutputRepository {
  appendMany(records: ExecutionOutputRecord[]): Promise<void>;
  listByStep(stepExecutionId: string): Promise<ExecutionOutputRecord[]>;
}

export interface PersistStepOutputsInput {
  outputs: ExecutionOutputRepository;
  contexts: Record<string, ContextEnvelope>;
  executionId: string;
  stepExecutionId: string;
  idGenerator: IdGenerator;
  clock: Clock;
  markSucceeded(): Promise<unknown>;
}

export async function persistStepOutputsBeforeSuccess(
  input: PersistStepOutputsInput,
): Promise<void> {
  const createdAt = input.clock.now().toISOString();
  const records = Object.entries(input.contexts).map(
    ([portName, context]): ExecutionOutputRecord => ({
      id: input.idGenerator.next(),
      executionId: input.executionId,
      stepExecutionId: input.stepExecutionId,
      portName,
      contextId: context.id,
      artifactId:
        context.type === "api-response" &&
        typeof context.payload === "object" &&
        context.payload !== null &&
        !Array.isArray(context.payload) &&
        typeof context.payload.bodyArtifactId === "string"
          ? context.payload.bodyArtifactId
          : null,
      context: structuredClone(context),
      createdAt,
    }),
  );

  if (records.length > 0) {
    await input.outputs.appendMany(records);
  }
  await input.markSucceeded();
}

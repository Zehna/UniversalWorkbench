import type {
  ContextEnvelope,
  NoteDocumentView,
  ToolDefinition,
} from "@uw/contracts";
import { z } from "zod";
import type { ToolRunner } from "../../contract.js";
import { ToolExecutionError } from "../../errors.js";

const NoteWriteConfigSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
  })
  .strict();

export interface NoteDocumentWriter {
  createNote(
    ownerId: string,
    projectId: string,
    input: {
      documentId: string;
      revisionId: string;
      title: string;
      body: string;
    },
    traceId: string,
  ): Promise<NoteDocumentView>;
}

export interface NoteContextIdGenerator {
  next(): string;
}

export interface CreateNoteWriteToolOptions {
  documents: NoteDocumentWriter;
  contextIds: NoteContextIdGenerator;
}

export const NOTE_WRITE_TOOL_DEFINITION: ToolDefinition = {
  id: "builtin.note.write",
  version: "1",
  displayName: "Write Note",
  description: "Create a project note from text or markdown",
  executionMode: "worker",
  accepts: [
    {
      name: "input",
      types: ["text", "markdown"],
      required: true,
    },
  ],
  produces: [{ name: "note", types: ["note-ref"] }],
  configSchema: {
    type: "object",
    required: ["title"],
    additionalProperties: false,
    properties: {
      title: { type: "string" },
    },
  },
  requiredCapabilities: ["project.documents.write"],
  defaults: { timeoutMs: 5_000, maxAttempts: 1 },
};

function validation(message: string): ToolExecutionError {
  return new ToolExecutionError({
    code: "VALIDATION",
    message,
    retrySafe: false,
  });
}

function assertStepUuid(stepExecutionId: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      stepExecutionId,
    )
  ) {
    throw new ToolExecutionError({
      code: "TOOL_BUG",
      message: "Note write step identity is not a UUID",
      retrySafe: false,
    });
  }
}

export function noteIdentityForStep(stepExecutionId: string): {
  documentId: string;
  revisionId: string;
} {
  assertStepUuid(stepExecutionId);
  const first = Number.parseInt(stepExecutionId[0]!, 16);
  const revisionId =
    ((first + 8) % 16).toString(16) + stepExecutionId.slice(1);
  return {
    documentId: stepExecutionId,
    revisionId,
  };
}

function noteRef(
  context: Parameters<ToolRunner["run"]>[0],
  input: ContextEnvelope,
  note: NoteDocumentView,
  id: string,
): ContextEnvelope {
  return {
    id,
    type: "note-ref",
    schemaVersion: 1,
    mimeType: "application/vnd.uw.note-ref+json",
    metadata: {},
    payload: {
      documentId: note.document.id,
      revisionId: note.revision.id,
      title: note.document.title,
    },
    provenance: {
      projectId: context.projectId,
      artifactIds: [...input.provenance.artifactIds],
      executionId: context.executionId,
      stepExecutionId: context.stepExecutionId,
      parentContextIds: [input.id],
    },
    capabilities: [],
  };
}

export function createNoteWriteTool(
  options: CreateNoteWriteToolOptions,
): ToolRunner {
  return {
    async run(context) {
      const parsed = NoteWriteConfigSchema.safeParse(context.config);
      if (!parsed.success) {
        throw validation("Note write configuration is invalid");
      }

      const input = context.inputs.input;
      if (
        !input ||
        (input.type !== "text" && input.type !== "markdown") ||
        typeof input.payload !== "string"
      ) {
        throw validation("Note write requires text or markdown input");
      }

      const identity = noteIdentityForStep(context.stepExecutionId);
      const note = await options.documents.createNote(
        context.ownerId,
        context.projectId,
        {
          ...identity,
          title: parsed.data.title,
          body: input.payload,
        },
        context.traceId,
      );

      const output = noteRef(context, input, note, options.contextIds.next());
      return {
        outputs: { note: output },
        usage: {
          outputBytes: new TextEncoder().encode(JSON.stringify(output.payload))
            .byteLength,
          httpRequests: 0,
        },
      };
    },
  };
}

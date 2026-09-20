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
    input: { title: string; body: string },
    traceId: string,
  ): Promise<NoteDocumentView>;
}

export interface ExistingNoteReader {
  getNote(
    ownerId: string,
    projectId: string,
    documentId: string,
  ): Promise<NoteDocumentView>;
}

export interface NoteWriteSideEffectStore {
  get(stepExecutionId: string): Promise<{ targetId: string } | null>;
  reserve(
    stepExecutionId: string,
  ): Promise<
    | { status: "reserved" }
    | { status: "existing"; targetId: string }
  >;
  complete(stepExecutionId: string, targetId: string): Promise<void>;
}

export interface NoteContextIdGenerator {
  next(): string;
}

export interface CreateNoteWriteToolOptions {
  documents: NoteDocumentWriter;
  sideEffects: NoteWriteSideEffectStore;
  existingNotes?: ExistingNoteReader;
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

async function loadExisting(
  options: CreateNoteWriteToolOptions,
  context: Parameters<ToolRunner["run"]>[0],
  input: ContextEnvelope,
  targetId: string,
): Promise<Awaited<ReturnType<ToolRunner["run"]>>> {
  if (!options.existingNotes) {
    throw new ToolExecutionError({
      code: "TOOL_BUG",
      message: "Note idempotency reader is not configured",
      retrySafe: false,
    });
  }
  const note = await options.existingNotes.getNote(
    context.ownerId,
    context.projectId,
    targetId,
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
}

export function createNoteWriteTool(
  options: CreateNoteWriteToolOptions,
): ToolRunner {
  return {
    async run(context) {
      const parsed = NoteWriteConfigSchema.safeParse(context.config);
      if (!parsed.success) throw validation("Note write configuration is invalid");

      const input = context.inputs.input;
      if (
        !input ||
        (input.type !== "text" && input.type !== "markdown") ||
        typeof input.payload !== "string"
      ) {
        throw validation("Note write requires text or markdown input");
      }

      const existing = await options.sideEffects.get(context.stepExecutionId);
      if (existing) {
        return loadExisting(options, context, input, existing.targetId);
      }

      const reservation = await options.sideEffects.reserve(
        context.stepExecutionId,
      );
      if (reservation.status === "existing") {
        return loadExisting(options, context, input, reservation.targetId);
      }

      const note = await options.documents.createNote(
        context.ownerId,
        context.projectId,
        {
          title: parsed.data.title,
          body: input.payload,
        },
        context.traceId,
      );
      await options.sideEffects.complete(
        context.stepExecutionId,
        note.document.id,
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

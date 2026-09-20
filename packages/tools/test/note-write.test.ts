import { describe, expect, it, vi } from "vitest";
import type { ContextEnvelope, NoteDocumentView } from "@uw/contracts";
import {
  createNoteWriteTool,
  noteIdentityForStep,
} from "../src/builtin/note/write.js";

const base = {
  ownerId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  executionId: "33333333-3333-4333-8333-333333333333",
  stepExecutionId: "44444444-4444-4444-8444-444444444444",
  traceId: "55555555-5555-4555-8555-555555555555",
  signal: new AbortController().signal,
};

const created: NoteDocumentView = {
  document: {
    id: "66666666-6666-4666-8666-666666666666",
    projectId: base.projectId,
    kind: "note",
    title: "Generated",
    currentRevisionId: "77777777-7777-4777-8777-777777777777",
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
  },
  revision: {
    id: "77777777-7777-4777-8777-777777777777",
    documentId: "66666666-6666-4666-8666-666666666666",
    revisionNumber: 1,
    parentRevisionId: null,
    content: { body: "Hello" },
    metadata: {},
    createdAt: "2026-09-20T00:00:00.000Z",
  },
};

function content(type: "text" | "markdown"): ContextEnvelope {
  return {
    id: "88888888-8888-4888-8888-888888888888",
    type,
    schemaVersion: 1,
    mimeType: type === "markdown" ? "text/markdown" : "text/plain",
    metadata: {},
    payload: "Hello",
    provenance: {
      projectId: base.projectId,
      artifactIds: [],
      parentContextIds: [],
    },
    capabilities: [],
  };
}

describe("builtin note.write", () => {
  it.each(["text", "markdown"] as const)(
    "writes %s through the document service",
    async (type) => {
      const createNote = vi.fn().mockResolvedValue(created);
      const tool = createNoteWriteTool({
        documents: { createNote },
        contextIds: {
          next: () => "99999999-9999-4999-8999-999999999999",
        },
      });

      const result = await tool.run({
        ...base,
        config: { title: "Generated" },
        inputs: { input: content(type) },
      });

      expect(createNote).toHaveBeenCalledWith(
        base.ownerId,
        base.projectId,
        {
          ...noteIdentityForStep(base.stepExecutionId),
          title: "Generated",
          body: "Hello",
        },
        base.traceId,
      );
      expect(result.outputs.note?.type).toBe("note-ref");
    },
  );

  it("rejects non-text context without calling the document service", async () => {
    const createNote = vi.fn();
    const tool = createNoteWriteTool({
      documents: { createNote },
      contextIds: {
        next: () => "99999999-9999-4999-8999-999999999999",
      },
    });

    await expect(
      tool.run({
        ...base,
        config: { title: "Generated" },
        inputs: {
          input: {
            ...content("text"),
            type: "json",
            mimeType: "application/json",
            payload: { body: "no" },
          },
        },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    expect(createNote).not.toHaveBeenCalled();
  });

  it("uses the same reserved document identity when the same step is retried", async () => {
    const createNote = vi.fn().mockImplementation(
      async (
        _ownerId: string,
        _projectId: string,
        input: {
          documentId: string;
          revisionId: string;
          title: string;
          body: string;
        },
      ) => ({
        ...created,
        document: {
          ...created.document,
          id: input.documentId,
          currentRevisionId: input.revisionId,
        },
        revision: {
          ...created.revision,
          id: input.revisionId,
          documentId: input.documentId,
        },
      }),
    );
    let contextIndex = 0;
    const contextIds = [
      "99999999-9999-4999-8999-999999999991",
      "99999999-9999-4999-8999-999999999992",
    ];
    const tool = createNoteWriteTool({
      documents: { createNote },
      contextIds: {
        next: () => contextIds[contextIndex++]!,
      },
    });

    const first = await tool.run({
      ...base,
      config: { title: "Generated" },
      inputs: { input: content("text") },
    });
    const replay = await tool.run({
      ...base,
      config: { title: "Generated" },
      inputs: { input: content("text") },
    });

    expect(createNote).toHaveBeenCalledTimes(2);
    const firstInput = createNote.mock.calls[0]?.[2];
    const replayInput = createNote.mock.calls[1]?.[2];
    expect(replayInput).toEqual(firstInput);
    expect(firstInput).toMatchObject({
      documentId: base.stepExecutionId,
      title: "Generated",
      body: "Hello",
    });
    expect(firstInput?.revisionId).not.toBe(firstInput?.documentId);
    expect(first.outputs.note?.payload).toMatchObject({
      documentId: firstInput?.documentId,
      revisionId: firstInput?.revisionId,
    });
    expect(replay.outputs.note?.payload).toMatchObject({
      documentId: firstInput?.documentId,
      revisionId: firstInput?.revisionId,
    });
  });
});

import { describe, expect, it, vi } from "vitest";
import type { ContextEnvelope, NoteDocumentView } from "@uw/contracts";
import { createNoteWriteTool } from "../src/builtin/note/write.js";

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
        sideEffects: {
          async get() {
            return null;
          },
          async reserve() {
            return { status: "reserved" as const };
          },
          async complete() {},
        },
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
        { title: "Generated", body: "Hello" },
        base.traceId,
      );
      expect(result.outputs.note?.type).toBe("note-ref");
    },
  );

  it("rejects non-text context without calling the document service", async () => {
    const createNote = vi.fn();
    const tool = createNoteWriteTool({
      documents: { createNote },
      sideEffects: {
        async get() {
          return null;
        },
        async reserve() {
          return { status: "reserved" as const };
        },
        async complete() {},
      },
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

  it("returns the existing note on retry without creating a duplicate", async () => {
    const createNote = vi.fn().mockResolvedValue(created);
    const tool = createNoteWriteTool({
      documents: { createNote },
      sideEffects: {
        async get(stepExecutionId) {
          return stepExecutionId === base.stepExecutionId
            ? { targetId: created.document.id }
            : null;
        },
        async reserve() {
          throw new Error("reserve should not run");
        },
        async complete() {
          throw new Error("complete should not run");
        },
      },
      existingNotes: {
        async getNote(ownerId, projectId, documentId) {
          expect(ownerId).toBe(base.ownerId);
          expect(projectId).toBe(base.projectId);
          expect(documentId).toBe(created.document.id);
          return created;
        },
      },
      contextIds: {
        next: () => "99999999-9999-4999-8999-999999999999",
      },
    });

    const result = await tool.run({
      ...base,
      config: { title: "Generated" },
      inputs: { input: content("text") },
    });

    expect(createNote).not.toHaveBeenCalled();
    expect(result.outputs.note?.payload).toMatchObject({
      documentId: created.document.id,
    });
  });
});

import { describe, expect, it, vi } from "vitest";
import type { NoteDocumentView } from "@uw/contracts";
import {
  createHttpRequestTool,
  createJsonParseTool,
  createJsonSelectTool,
  createNoteWriteTool,
  createTextTemplateTool,
  type HttpArtifactWriter,
  type JsonArtifactReader,
  type SafeHttpTransportLike,
} from "../src/index.js";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const EXECUTION_ID = "33333333-3333-4333-8333-333333333333";
const ARTIFACT_ID = "44444444-4444-4444-8444-444444444444";
const STEP_HTTP = "55555555-5555-4555-8555-555555555551";
const STEP_PARSE = "55555555-5555-4555-8555-555555555552";
const STEP_SELECT = "55555555-5555-4555-8555-555555555553";
const STEP_TEXT = "55555555-5555-4555-8555-555555555554";
const STEP_NOTE = "55555555-5555-4555-8555-555555555555";

function contextIds() {
  const ids = [
    "66666666-6666-4666-8666-666666666661",
    "66666666-6666-4666-8666-666666666662",
    "66666666-6666-4666-8666-666666666663",
    "66666666-6666-4666-8666-666666666664",
    "66666666-6666-4666-8666-666666666665",
  ];
  let index = 0;
  return {
    next() {
      const id = ids[index++];
      if (!id) throw new Error("Golden context id fixture exhausted");
      return id;
    },
  };
}

function runBase(stepExecutionId: string) {
  return {
    ownerId: OWNER_ID,
    projectId: PROJECT_ID,
    executionId: EXECUTION_ID,
    stepExecutionId,
    traceId: EXECUTION_ID,
    signal: new AbortController().signal,
  };
}

describe("Phase 3 golden built-in tool chain", () => {
  it("runs HTTP -> JSON -> select -> text -> note without weakening safe egress", async () => {
    const body = new TextEncoder().encode(
      JSON.stringify({ title: "Golden", body: "Hello from golden chain" }),
    );
    const transport: SafeHttpTransportLike = {
      request: vi.fn().mockResolvedValue({
        status: 200,
        headers: { "content-type": "application/json" },
        finalUrl: "https://fixture.example/history",
        body,
        requestCount: 1,
      }),
    };

    const artifactBytes = new Map<string, Uint8Array>();
    const artifacts: HttpArtifactWriter & JsonArtifactReader = {
      async create(_ownerId, _projectId, input) {
        artifactBytes.set(ARTIFACT_ID, new Uint8Array(input.bytes));
        return { id: ARTIFACT_ID };
      },
      async getContent(_ownerId, _projectId, artifactId) {
        const bytes = artifactBytes.get(artifactId);
        if (!bytes) throw new Error("Golden response artifact is missing");
        return new Uint8Array(bytes);
      },
    };

    const noteCreate = vi.fn(
      async (
        _ownerId: string,
        projectId: string,
        input: {
          documentId: string;
          revisionId: string;
          title: string;
          body: string;
        },
      ): Promise<NoteDocumentView> => {
        const now = "2026-09-20T00:00:00.000Z";
        return {
          document: {
            id: input.documentId,
            projectId,
            kind: "note",
            title: input.title,
            currentRevisionId: input.revisionId,
            createdAt: now,
            updatedAt: now,
          },
          revision: {
            id: input.revisionId,
            documentId: input.documentId,
            revisionNumber: 1,
            parentRevisionId: null,
            content: { body: input.body },
            metadata: {},
            createdAt: now,
          },
        };
      },
    );

    const ids = contextIds();
    const http = createHttpRequestTool({
      transport,
      artifacts,
      contextIds: ids,
    });
    const parse = createJsonParseTool({ artifacts, contextIds: ids });
    const select = createJsonSelectTool({ contextIds: ids });
    const text = createTextTemplateTool({ contextIds: ids });
    const note = createNoteWriteTool({
      documents: { createNote: noteCreate },
      contextIds: ids,
    });

    const response = await http.run({
      ...runBase(STEP_HTTP),
      config: {
        url: "https://fixture.example/history",
        method: "GET",
      },
      inputs: {},
    });
    expect(transport.request).toHaveBeenCalledOnce();
    expect(response.outputs.response).toMatchObject({
      type: "api-response",
      provenance: { artifactIds: [ARTIFACT_ID] },
      payload: {
        bodyArtifactId: ARTIFACT_ID,
        bodySizeBytes: body.byteLength,
      },
    });

    const parsed = await parse.run({
      ...runBase(STEP_PARSE),
      config: {},
      inputs: { input: response.outputs.response! },
    });
    expect(parsed.outputs.output?.payload).toEqual({
      title: "Golden",
      body: "Hello from golden chain",
    });

    const selected = await select.run({
      ...runBase(STEP_SELECT),
      config: { pointer: "/body" },
      inputs: { input: parsed.outputs.output! },
    });
    expect(selected.outputs.output?.payload).toBe("Hello from golden chain");

    const rendered = await text.run({
      ...runBase(STEP_TEXT),
      config: { template: "{{json:}}" },
      inputs: { json: selected.outputs.output! },
    });
    expect(rendered.outputs.output).toMatchObject({
      type: "text",
      payload: "Hello from golden chain",
    });

    const written = await note.run({
      ...runBase(STEP_NOTE),
      config: { title: "Golden Workflow Output" },
      inputs: { input: rendered.outputs.output! },
    });

    expect(noteCreate).toHaveBeenCalledWith(
      OWNER_ID,
      PROJECT_ID,
      expect.objectContaining({
        documentId: STEP_NOTE,
        title: "Golden Workflow Output",
        body: "Hello from golden chain",
      }),
      EXECUTION_ID,
    );
    expect(written.outputs.note).toMatchObject({
      type: "note-ref",
      provenance: {
        parentContextIds: [rendered.outputs.output!.id],
      },
    });
  });
});

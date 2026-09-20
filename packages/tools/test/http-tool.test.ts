import { describe, expect, it, vi } from "vitest";
import type { ContextEnvelope } from "@uw/contracts";
import {
  HTTP_REQUEST_TOOL_DEFINITION,
  createHttpRequestTool,
  type HttpArtifactWriter,
  type SafeHttpTransportLike,
} from "../src/index.js";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const EXECUTION_ID = "33333333-3333-4333-8333-333333333333";
const STEP_ID = "44444444-4444-4444-8444-444444444444";
const ARTIFACT_ID = "55555555-5555-4555-8555-555555555555";
const CONTEXT_ID = "66666666-6666-4666-8666-666666666666";

function bodyContext(
  type: "text" | "json",
  payload: ContextEnvelope["payload"],
): ContextEnvelope {
  return {
    id: "77777777-7777-4777-8777-777777777777",
    type,
    schemaVersion: 1,
    mimeType: type === "json" ? "application/json" : "text/plain",
    metadata: {},
    payload,
    provenance: {
      projectId: PROJECT_ID,
      artifactIds: [],
      parentContextIds: [],
    },
    capabilities: [],
  };
}

describe("builtin.http.request@1", () => {
  it("declares worker execution with public network and artifact write capabilities", () => {
    expect(HTTP_REQUEST_TOOL_DEFINITION).toMatchObject({
      id: "builtin.http.request",
      version: "1",
      executionMode: "worker",
      requiredCapabilities: ["network.public", "project.artifacts.write"],
    });
  });

  it("stores successful response bytes as an immutable artifact and returns api-response context", async () => {
    const transport: SafeHttpTransportLike = {
      request: vi.fn().mockResolvedValue({
        status: 200,
        headers: { "content-type": "application/json" },
        finalUrl: "https://example.com/data",
        body: new TextEncoder().encode('{"ok":true}'),
      }),
    };
    const artifacts: HttpArtifactWriter = {
      create: vi.fn().mockResolvedValue({ id: ARTIFACT_ID }),
    };
    const tool = createHttpRequestTool({
      transport,
      artifacts,
      contextIds: { next: () => CONTEXT_ID },
    });

    const result = await tool.run({
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      executionId: EXECUTION_ID,
      stepExecutionId: STEP_ID,
      traceId: "trace-http",
      config: {
        url: "https://example.com/data",
        method: "GET",
      },
      inputs: {},
      signal: new AbortController().signal,
    });

    expect(artifacts.create).toHaveBeenCalledWith(
      OWNER_ID,
      PROJECT_ID,
      expect.objectContaining({
        type: "http-response-body",
        mimeType: "application/json",
        bytes: new TextEncoder().encode('{"ok":true}'),
      }),
      "trace-http",
    );
    expect(result.outputs.response).toMatchObject({
      id: CONTEXT_ID,
      type: "api-response",
      mimeType: "application/json",
      payload: {
        status: 200,
        headers: { "content-type": "application/json" },
        url: "https://example.com/data",
        bodyArtifactId: ARTIFACT_ID,
        bodyMimeType: "application/json",
        bodySizeBytes: 11,
      },
      provenance: {
        projectId: PROJECT_ID,
        artifactIds: [ARTIFACT_ID],
        executionId: EXECUTION_ID,
        stepExecutionId: STEP_ID,
        parentContextIds: [],
      },
    });
    expect(result.usage).toEqual({
      outputBytes: 11,
      httpRequests: 1,
    });
  });

  it("serializes a json body input without accepting credential configuration", async () => {
    const transport: SafeHttpTransportLike = {
      request: vi.fn().mockResolvedValue({
        status: 204,
        headers: {},
        finalUrl: "https://example.com/items",
        body: new Uint8Array(),
      }),
    };
    const artifacts: HttpArtifactWriter = {
      create: vi.fn().mockResolvedValue({ id: ARTIFACT_ID }),
    };
    const tool = createHttpRequestTool({
      transport,
      artifacts,
      contextIds: { next: () => CONTEXT_ID },
    });

    await tool.run({
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      executionId: EXECUTION_ID,
      stepExecutionId: STEP_ID,
      traceId: "trace-post",
      config: {
        url: "https://example.com/items",
        method: "POST",
        headers: { "content-type": "application/json" },
      },
      inputs: {
        body: bodyContext("json", { title: "History" }),
      },
      signal: new AbortController().signal,
    });

    expect(transport.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        body: new TextEncoder().encode('{"title":"History"}'),
      }),
    );
  });
});

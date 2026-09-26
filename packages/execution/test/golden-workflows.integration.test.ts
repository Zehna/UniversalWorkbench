import { describe, expect, it, vi } from "vitest";
import {
  createEgressPolicy,
  createHttpTool,
  createJsonExtractTool,
  createLocalResult,
  createMarkdownToTextTool,
  createTextTrimTool,
  type HttpTransport,
} from "@uw/tools";
import { createWorkflowEngine } from "../src/engine.js";
import {
  MemoryStore,
  context,
  inputFor,
  node,
  registryWith,
  tool,
  workflow,
} from "./fixture.js";

// All HTTP responses come from an injected deterministic transport. No test
// sends network traffic or weakens the production HTTP egress policy.
const policy = createEgressPolicy({
  resolver: async () => ["93.184.216.34"],
});
const sourceUrl = "https://public.example.net/data";

describe("Phase 3 golden workflow integration", () => {
  it("runs HTTP -> JSON extract -> Markdown -> text with receipt and provenance", async () => {
    const request = vi.fn<HttpTransport["request"]>(async () => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode('{"message":"**Universal Workbench**"}'),
    }));
    const http = createHttpTool({ policy, transport: { request } });
    const extract = createJsonExtractTool();
    const toMarkdown = tool("fixture.json.to-markdown", {
      accepts: ["json"],
      produces: ["markdown"],
      handler: async (input, _config, run) =>
        createLocalResult(toMarkdown.descriptor, input, run, {
          type: "markdown",
          mimeType: "text/markdown",
          payload: String(input.payload),
        }),
    });
    const toText = createMarkdownToTextTool();
    const registry = registryWith(http, extract, toMarkdown, toText);
    const first = node(1, http.descriptor.id, undefined, {
      config: { method: "GET", url: sourceUrl },
    });
    const second = node(
      2,
      extract.descriptor.id,
      { source: "node_output", nodeId: first.id, outputIndex: 0 },
      { config: { path: "message" } },
    );
    const third = node(3, toMarkdown.descriptor.id, {
      source: "node_output",
      nodeId: second.id,
      outputIndex: 0,
    });
    const fourth = node(4, toText.descriptor.id, {
      source: "node_output",
      nodeId: third.id,
      outputIndex: 0,
    });
    const definition = workflow(
      [fourth, second, first, third],
      [
        { from: first.id, to: second.id },
        { from: second.id, to: third.id },
        { from: third.id, to: fourth.id },
      ],
    );
    const store = new MemoryStore();
    const engine = createWorkflowEngine({ store, registry });
    const created = await engine.enqueue({
      ...inputFor(registry, definition, context("json", {})),
      permissions: new Set(["network"]),
    });
    const result = await engine.process(
      created.id,
      new AbortController().signal,
    );

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[1]).toBe("93.184.216.34");
    expect(result.execution.status).toBe("completed");
    expect(result.steps.map((step) => step.toolId)).toEqual([
      http.descriptor.id,
      extract.descriptor.id,
      toMarkdown.descriptor.id,
      toText.descriptor.id,
    ]);
    expect(result.steps.map((step) => step.outputContexts[0]?.type)).toEqual([
      "api_response",
      "json",
      "markdown",
      "text",
    ]);
    expect(result.steps[3]?.outputContexts[0]?.payload).toBe(
      "Universal Workbench",
    );
    expect(result.provenanceEdges).toHaveLength(4);
    expect(result.provenanceEdges[3]).toMatchObject({
      fromContextId: result.steps[2]?.outputContexts[0]?.id,
      toContextId: result.steps[3]?.outputContexts[0]?.id,
      nodeId: fourth.id,
    });
    expect(result.receipt).toMatchObject({
      status: "completed",
      workflowVersion: 1,
      workflowSchemaVersion: 1,
    });
    expect(result.receipt?.outputContextIds).toContain(
      result.steps[3]?.outputContexts[0]?.id,
    );
    expect(result.receipt?.provenance).toHaveLength(4);
    expect(result.receipt?.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolId: http.descriptor.id,
          toolVersion: "1.0.0",
          status: "completed",
        }),
      ]),
    );
  });

  it("runs JSON -> transform and yields an artifact-eligible, traceable output", async () => {
    // Artifact persistence and owner scoping are exercised separately by
    // apps/server/test/workflow-artifact.integration.test.ts.
    const extract = createJsonExtractTool();
    const asText = tool("fixture.json.to-text", {
      accepts: ["json"],
      produces: ["text"],
      handler: async (input, _config, run) =>
        createLocalResult(asText.descriptor, input, run, {
          type: "text",
          mimeType: "text/plain",
          payload: String(input.payload),
        }),
    });
    const trim = createTextTrimTool();
    const registry = registryWith(extract, asText, trim);
    const first = node(1, extract.descriptor.id, undefined, {
      config: { path: "message" },
    });
    const second = node(2, asText.descriptor.id, {
      source: "node_output",
      nodeId: first.id,
      outputIndex: 0,
    });
    const third = node(3, trim.descriptor.id, {
      source: "node_output",
      nodeId: second.id,
      outputIndex: 0,
    });
    const store = new MemoryStore();
    const engine = createWorkflowEngine({ store, registry });
    const created = await engine.enqueue(
      inputFor(
        registry,
        workflow(
          [third, first, second],
          [
            { from: first.id, to: second.id },
            { from: second.id, to: third.id },
          ],
        ),
        context("json", { message: "  saved output  " }),
      ),
    );
    const result = await engine.process(
      created.id,
      new AbortController().signal,
    );
    const output = result.steps[2]?.outputContexts[0];

    expect(result.execution.status).toBe("completed");
    expect(output?.payload).toBe("saved output");
    expect(output?.type).toBe("text");
    expect(output?.mimeType).toBe("text/plain");
    expect(output?.provenance.executionId).toBe(created.id);
    expect(result.provenanceEdges).toHaveLength(3);
    expect(result.receipt?.outputContextIds).toContain(output?.id);
    expect(result.receipt?.status).toBe("completed");
  });

  it("retries a failing GET and stores a structured terminal error without leaking secrets", async () => {
    const secret = "golden-fixture-private-token";
    const request = vi.fn<HttpTransport["request"]>(async () => {
      throw new Error("upstream unavailable: " + secret);
    });
    const http = createHttpTool({ policy, transport: { request } });
    const registry = registryWith(http);
    const action = node(1, http.descriptor.id, undefined, {
      config: { method: "GET", url: sourceUrl },
      retry: { maxAttempts: 2, backoffMs: 0 },
    });
    const store = new MemoryStore();
    const engine = createWorkflowEngine({ store, registry });
    const created = await engine.enqueue({
      ...inputFor(registry, workflow([action]), context("json", {})),
      permissions: new Set(["network"]),
    });
    const result = await engine.process(
      created.id,
      new AbortController().signal,
    );

    expect(request).toHaveBeenCalledTimes(2);
    expect(result.execution.status).toBe("failed");
    expect(result.execution.error?.code).toBe("TOOL_FAILED");
    expect(result.steps.map((step) => step.attempt)).toEqual([1, 2]);
    expect(result.steps.map((step) => step.error?.code)).toEqual([
      "NETWORK_FAILURE",
      "NETWORK_FAILURE",
    ]);
    expect(result.steps.every((step) => step.outputContexts.length === 0)).toBe(
      true,
    );
    expect(result.receipt).toMatchObject({
      status: "failed",
      errorCode: "TOOL_FAILED",
    });
    expect(JSON.stringify(result.receipt)).not.toContain(secret);
    expect(JSON.stringify(result.steps)).not.toContain(secret);
  });
});

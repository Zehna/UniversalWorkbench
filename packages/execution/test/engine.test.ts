import { describe, expect, it, vi } from "vitest";
import { createLocalResult, createTextTrimTool } from "@uw/tools";
import { createWorkflowEngine } from "../src/engine.js";
import {
  MemoryStore,
  context,
  defaultBudget,
  inputFor,
  node,
  registryWith,
  tool,
  uuid,
  workflow,
} from "./fixture.js";

describe("durable workflow engine", () => {
  it("runs a two-node JSON -> text DAG with typed binding and provenance", async () => {
    const store = new MemoryStore();
    const producer = tool("test.json.to-text", {
      accepts: ["json"],
      produces: ["text"],
      handler: async (input, _config, run) =>
        createLocalResult(producer.descriptor, input, run, {
          type: "text",
          mimeType: "text/plain",
          payload: (input.payload as { name: string }).name,
        }),
    });
    const consumer = createTextTrimTool();
    const registry = registryWith(producer, consumer);
    const first = node(1, producer.descriptor.id);
    const second = node(2, consumer.descriptor.id, {
      source: "node_output",
      nodeId: first.id,
      outputIndex: 0,
    });
    const engine = createWorkflowEngine({ store, registry });
    const root = context("json", { name: "  work  " });
    const created = await engine.enqueue(
      inputFor(
        registry,
        workflow([second, first], [{ from: first.id, to: second.id }]),
        root,
      ),
    );
    expect(created.status).toBe("queued");
    const view = await engine.process(created.id, new AbortController().signal);
    expect(view.execution.status).toBe("completed");
    expect(view.steps.map((step) => step.nodeId)).toEqual([
      first.id,
      second.id,
    ]);
    expect(view.steps[0]?.outputContexts[0]?.payload).toBe("  work  ");
    expect(view.steps[1]?.outputContexts[0]?.payload).toBe("work");
    expect(view.steps[1]?.inputContext.id).toBe(
      view.steps[0]?.outputContexts[0]?.id,
    );
    expect(view.provenanceEdges).toEqual([
      {
        fromContextId: root.id,
        toContextId: view.steps[0]?.outputContexts[0]?.id,
        nodeId: first.id,
      },
      {
        fromContextId: view.steps[0]?.outputContexts[0]?.id,
        toContextId: view.steps[1]?.outputContexts[0]?.id,
        nodeId: second.id,
      },
    ]);
    expect(view.receipt).toMatchObject({
      status: "completed",
      workflowVersion: 1,
      outputContextIds: [
        view.steps[0]?.outputContexts[0]?.id,
        view.steps[1]?.outputContexts[0]?.id,
      ],
    });
  });

  it("never executes additional nodes after the step budget is exhausted", async () => {
    const store = new MemoryStore();
    const produce = tool("test.produce-text", {
      handler: async (input, _config, ctx) =>
        createLocalResult(produce.descriptor, input, ctx, {
          type: "text",
          mimeType: "text/plain",
          payload: " text ",
        }),
    });
    const consume = createTextTrimTool();
    const invoked = vi.spyOn(consume, "run");
    const registry = registryWith(produce, consume);
    const first = node(1, produce.descriptor.id);
    const second = node(2, consume.descriptor.id, {
      source: "node_output",
      nodeId: first.id,
      outputIndex: 0,
    });
    const engine = createWorkflowEngine({ store, registry });
    const created = await engine.enqueue(
      inputFor(
        registry,
        workflow([first, second], [{ from: first.id, to: second.id }]),
        undefined,
        { ...defaultBudget, maxSteps: 1 },
      ),
    );
    const view = await engine.process(created.id, new AbortController().signal);
    expect(view.execution.status).toBe("failed");
    expect(view.execution.error?.code).toBe("BUDGET_STEPS");
    expect(invoked).not.toHaveBeenCalled();
    expect(view.steps).toHaveLength(1);
  });

  it("rejects an oversized tool result without storing the payload", async () => {
    const store = new MemoryStore();
    const huge = tool("test.huge-output", {
      handler: async (input, _config, ctx) =>
        createLocalResult(huge.descriptor, input, ctx, {
          type: "text",
          mimeType: "text/plain",
          payload: "x".repeat(20_000),
        }),
    });
    const registry = registryWith(huge);
    const engine = createWorkflowEngine({ store, registry });
    const created = await engine.enqueue(
      inputFor(registry, workflow([node(1, huge.descriptor.id)]), undefined, {
        ...defaultBudget,
        maxOutputBytes: 512,
      }),
    );
    const result = await engine.process(
      created.id,
      new AbortController().signal,
    );
    expect(result.execution.error?.code).toBe("BUDGET_OUTPUT");
    expect(result.steps[0]?.outputContexts).toEqual([]);
    expect(JSON.stringify(result.receipt)).not.toContain("x".repeat(100));
  });

  it("times out a tool that ignores AbortSignal and finalizes a safe failure", async () => {
    const store = new MemoryStore();
    const stalled = tool("test.stalled", {
      handler: async () => new Promise<never>(() => {}),
    });
    const registry = registryWith(stalled);
    const engine = createWorkflowEngine({ store, registry });
    const created = await engine.enqueue(
      inputFor(
        registry,
        workflow([
          node(1, stalled.descriptor.id, undefined, { timeoutMs: 20 }),
        ]),
      ),
    );
    const result = await engine.process(
      created.id,
      new AbortController().signal,
    );
    expect(result.execution.status).toBe("failed");
    expect(result.execution.error?.code).toBe("TIMEOUT");
    expect(result.steps[0]?.status).toBe("failed");
  });

  it("passes cancellation through to the tool signal and records a final receipt", async () => {
    const store = new MemoryStore();
    const controller = new AbortController();
    const encountered = vi.fn();
    const stalled = tool("test.cancellable", {
      handler: async (_input, _config, ctx) => {
        encountered();
        return new Promise<never>((_resolve, reject) => {
          ctx.signal.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        });
      },
    });
    const registry = registryWith(stalled);
    const engine = createWorkflowEngine({ store, registry });
    const created = await engine.enqueue(
      inputFor(registry, workflow([node(1, stalled.descriptor.id)])),
    );
    const running = engine.process(created.id, controller.signal);
    await vi.waitFor(() => expect(encountered).toHaveBeenCalledTimes(1));
    controller.abort();
    const result = await running;
    expect(result.execution.status).toBe("cancelled");
    expect(result.receipt?.status).toBe("cancelled");
  });

  it("skips already-completed durable steps on reclaimed work", async () => {
    const store = new MemoryStore();
    const run = vi.fn();
    const producer = tool("test.reclaimed", {
      handler: async (input, _cfg, ctx) => {
        run();
        return createLocalResult(producer.descriptor, input, ctx, {
          type: "text",
          mimeType: "text/plain",
          payload: "ok",
        });
      },
    });
    const registry = registryWith(producer);
    const engine = createWorkflowEngine({ store, registry });
    const created = await engine.enqueue(
      inputFor(registry, workflow([node(1, producer.descriptor.id)])),
    );
    const completed = await engine.process(
      created.id,
      new AbortController().signal,
    );
    const reclaimed = await engine.process(
      created.id,
      new AbortController().signal,
    );
    expect(completed.execution.status).toBe("completed");
    expect(reclaimed.execution.status).toBe("completed");
    expect(run).toHaveBeenCalledTimes(1);
    expect(reclaimed.steps).toHaveLength(1);
  });

  it("never retries an uncertain unsafe in-flight attempt after lease reclaim", async () => {
    const store = new MemoryStore();
    const invoke = vi.fn();
    const unsafe = tool("test.unsafe", {
      idempotency: "unsafe",
      handler: async (input, _config, ctx) => {
        invoke();
        return createLocalResult(unsafe.descriptor, input, ctx, {
          type: "text",
          mimeType: "text/plain",
          payload: "would duplicate",
        });
      },
    });
    const registry = registryWith(unsafe);
    const engine = createWorkflowEngine({ store, registry });
    const created = await engine.enqueue(
      inputFor(registry, workflow([node(1, unsafe.descriptor.id)])),
    );
    await store.markRunning(created.id, new Date());
    await store.startStep({
      id: uuid(1000),
      executionId: created.id,
      nodeId: uuid(1),
      toolId: unsafe.descriptor.id,
      toolVersion: "1.0.0",
      attempt: 1,
      status: "running",
      startedAt: new Date(),
      finishedAt: null,
      inputContext: context("json", {}),
      outputContexts: [],
      error: null,
      idempotencyKey: null,
    });
    const result = await engine.process(
      created.id,
      new AbortController().signal,
    );
    expect(result.execution.error?.code).toBe("UNCERTAIN_OUTCOME");
    expect(invoke).not.toHaveBeenCalled();
  });
});

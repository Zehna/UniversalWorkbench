import { describe, expect, it, vi } from "vitest";
import { createLocalResult } from "@uw/tools";
import { createWorkflowEngine } from "../src/engine.js";
import { canRetry, retryClass } from "../src/retry.js";
import {
  MemoryStore,
  context,
  inputFor,
  node,
  registryWith,
  tool,
  uuid,
  workflow,
} from "./fixture.js";

describe("safe, keyed and unsafe retries", () => {
  it("retries a safe tool and succeeds on a later attempt", async () => {
    const store = new MemoryStore();
    let calls = 0;
    const safe = tool("test.safe", {
      handler: async (input, _config, ctx) => {
        calls += 1;
        if (calls === 1)
          throw new Error("transient upstream error with secret");
        return createLocalResult(safe.descriptor, input, ctx, {
          type: "text",
          mimeType: "text/plain",
          payload: "ok",
        });
      },
    });
    const registry = registryWith(safe);
    const engine = createWorkflowEngine({ store, registry });
    const created = await engine.enqueue(
      inputFor(
        registry,
        workflow([
          node(1, safe.descriptor.id, undefined, {
            retry: { maxAttempts: 2, backoffMs: 0 },
          }),
        ]),
      ),
    );
    const result = await engine.process(
      created.id,
      new AbortController().signal,
    );
    expect(result.execution.status).toBe("completed");
    expect(result.steps.map((step) => step.status)).toEqual([
      "failed",
      "completed",
    ]);
    expect(result.steps.map((step) => step.attempt)).toEqual([1, 2]);
    expect(calls).toBe(2);
    expect(JSON.stringify(result.receipt)).not.toContain("with secret");
  });

  it("reuses one workflow-owned key for every retry of a keyed tool", async () => {
    const store = new MemoryStore();
    const seen: Array<string | undefined> = [];
    const keyed = tool("test.keyed", {
      idempotency: "unsafe",
      handler: async (input, _config, ctx) => {
        seen.push(ctx.idempotencyKey);
        if (seen.length === 1) throw new Error("retry once");
        return createLocalResult(keyed.descriptor, input, ctx, {
          type: "text",
          mimeType: "text/plain",
          payload: "done",
        });
      },
    });
    const registry = registryWith(keyed);
    const action = node(1, keyed.descriptor.id, undefined, {
      idempotencyKey: "stable-operation-1",
      retry: { maxAttempts: 2, backoffMs: 0 },
    });
    expect(retryClass(keyed.descriptor, action)).toBe("keyed");
    const engine = createWorkflowEngine({ store, registry });
    const created = await engine.enqueue(
      inputFor(registry, workflow([action])),
    );
    const result = await engine.process(
      created.id,
      new AbortController().signal,
    );
    expect(result.execution.status).toBe("completed");
    expect(seen).toEqual(["stable-operation-1", "stable-operation-1"]);
    expect(result.steps.map((step) => step.idempotencyKey)).toEqual([
      "stable-operation-1",
      "stable-operation-1",
    ]);
    expect(JSON.stringify(result.receipt)).not.toContain("stable-operation-1");
  });

  it("does not retry unsafe operations without a key", async () => {
    const store = new MemoryStore();
    const called = vi.fn();
    const unsafe = tool("test.unsafe.retry", {
      idempotency: "unsafe",
      handler: async () => {
        called();
        throw new Error("unsafe failure");
      },
    });
    const registry = registryWith(unsafe);
    const action = node(1, unsafe.descriptor.id);
    expect(canRetry(unsafe.descriptor, action, 1, "TOOL_FAILED")).toBe(false);
    const engine = createWorkflowEngine({ store, registry });
    const created = await engine.enqueue(
      inputFor(registry, workflow([action])),
    );
    const result = await engine.process(
      created.id,
      new AbortController().signal,
    );
    expect(result.execution.status).toBe("failed");
    expect(result.steps).toHaveLength(1);
    expect(called).toHaveBeenCalledTimes(1);
  });

  it("reclaims a running keyed step by marking its prior attempt interrupted", async () => {
    const store = new MemoryStore();
    const called = vi.fn();
    const keyed = tool("test.resume.keyed", {
      idempotency: "unsafe",
      handler: async (input, _config, ctx) => {
        called();
        return createLocalResult(keyed.descriptor, input, ctx, {
          type: "text",
          mimeType: "text/plain",
          payload: "ok",
        });
      },
    });
    const registry = registryWith(keyed);
    const action = node(1, keyed.descriptor.id, undefined, {
      idempotencyKey: "same-key",
      retry: { maxAttempts: 2, backoffMs: 0 },
    });
    const engine = createWorkflowEngine({ store, registry });
    const created = await engine.enqueue(
      inputFor(registry, workflow([action])),
    );
    await store.markRunning(created.id, new Date());
    await store.startStep({
      id: uuid(1001),
      executionId: created.id,
      nodeId: action.id,
      toolId: action.toolId,
      toolVersion: "1.0.0",
      attempt: 1,
      status: "running",
      startedAt: new Date(),
      finishedAt: null,
      inputContext: context("json", {}),
      outputContexts: [],
      error: null,
      idempotencyKey: "same-key",
    });
    const result = await engine.process(
      created.id,
      new AbortController().signal,
    );
    expect(result.execution.status).toBe("completed");
    expect(result.steps.map((step) => step.status)).toEqual([
      "interrupted",
      "completed",
    ]);
    expect(result.steps.map((step) => step.attempt)).toEqual([1, 2]);
    expect(called).toHaveBeenCalledTimes(1);
  });
});

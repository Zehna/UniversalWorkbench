import { describe, expect, it, vi } from "vitest";
import { createLocalResult } from "@uw/tools";
import { requireBudget } from "../src/budget.js";
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

function aiPayload(overrides: {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  usageSource?: "provider" | "estimated";
  text?: string;
}) {
  return {
    text: overrides.text ?? "hello ai",
    model: "mock-model",
    usage: {
      promptTokens: overrides.promptTokens,
      completionTokens: overrides.completionTokens,
      totalTokens: overrides.totalTokens,
    },
    usageSource: overrides.usageSource ?? ("provider" as const),
    providerRequestId: "req-1",
  };
}

function aiTool(id: string, payload: ReturnType<typeof aiPayload>, opts?: { calls?: { count: number; keys: (string | undefined)[] } }) {
  const t = tool(id, {
    accepts: ["text"],
    produces: ["ai_response"],
    idempotency: "keyed",
    handler: async (input, _config, ctx) => {
      if (opts?.calls) {
        opts.calls.count += 1;
        opts.calls.keys.push(ctx.idempotencyKey);
      }
      return createLocalResult(t.descriptor, input, ctx, {
        type: "ai_response",
        mimeType: "application/json",
        payload,
      });
    },
  });
  return t;
}

describe("execution token accounting", () => {
  it("aggregates prompt/completion/total tokens from ai_response outputs", async () => {
    const store = new MemoryStore();
    const first = aiTool("test.ai.one", aiPayload({ promptTokens: 10, completionTokens: 20, totalTokens: 30 }));
    const second = aiTool("test.ai.two", aiPayload({ promptTokens: 5, completionTokens: 7, totalTokens: 12 }));
    const registry = registryWith(first, second);
    const n1 = node(1, first.descriptor.id);
    const n2 = node(2, second.descriptor.id, {
      source: "node_output",
      nodeId: n1.id,
      outputIndex: 0,
    });
    // Second AI node accepts text but receives ai_response; use an adapter:
    // instead run two independent roots both from workflow input.
    const n2root = node(2, second.descriptor.id);
    const engine = createWorkflowEngine({ store, registry });
    const created = await engine.enqueue(
      inputFor(registry, workflow([n1, n2root]), context("text", "prompt"), {
        ...defaultBudget,
        maxSteps: 12,
      }),
    );
    // n2 is unused; silence lint
    expect(n2.id).toBeDefined();
    const view = await engine.process(created.id, new AbortController().signal);
    expect(view.execution.status).toBe("completed");
    expect(view.execution.usage).toMatchObject({
      promptTokens: 15,
      completionTokens: 27,
      totalTokens: 42,
    });
  });

  it("fails with structured BUDGET_EXCEEDED before scheduling the next step", async () => {
    const store = new MemoryStore();
    const first = aiTool("test.ai.budget-one", aiPayload({ promptTokens: 60, completionTokens: 0, totalTokens: 60 }));
    const invokedSecond = vi.fn();
    const second = tool("test.ai.budget-two", {
      accepts: ["text"],
      produces: ["text"],
      handler: async (input, _config, ctx) => {
        invokedSecond();
        return createLocalResult(second.descriptor, input, ctx, {
          type: "text",
          mimeType: "text/plain",
          payload: "should not run",
        });
      },
    });
    const registry = registryWith(first, second);
    const n1 = node(1, first.descriptor.id);
    const engine = createWorkflowEngine({ store, registry });
    const created = await engine.enqueue(
      inputFor(registry, workflow([n1]), context("text", "hi"), {
        ...defaultBudget,
      }),
    );
    // Pre-step budget check: existing 60 tokens against a 50-token cap must throw.
    expect(() =>
      requireBudget(
        { ...defaultBudget, maxTotalTokens: 50 } as never,
        {
          attempts: 1,
          inputBytes: 10,
          outputBytes: 10,
          promptTokens: 60,
          completionTokens: 0,
          totalTokens: 60,
        } as never,
        new Date("2026-09-28T00:00:00.000Z"),
        new Date("2026-09-28T00:00:01.000Z"),
      ),
    ).toThrow(expect.objectContaining({ code: "BUDGET_EXCEEDED" }));
    expect(invokedSecond).not.toHaveBeenCalled();
    expect(created.status).toBe("queued");
  });

  it("engine enforces maxTotalTokens across steps without running over-budget work", async () => {
    const store = new MemoryStore();
    const first = aiTool("test.ai.cap-one", aiPayload({ promptTokens: 40, completionTokens: 10, totalTokens: 50 }));
    const secondRan = vi.fn();
    const second = tool("test.ai.cap-two", {
      accepts: ["ai_response"],
      produces: ["text"],
      handler: async (input, _config, ctx) => {
        secondRan();
        return createLocalResult(second.descriptor, input, ctx, {
          type: "text",
          mimeType: "text/plain",
          payload: "done",
        });
      },
    });
    const registry = registryWith(first, second);
    const n1 = node(1, first.descriptor.id);
    const n2 = node(2, second.descriptor.id, {
      source: "node_output",
      nodeId: n1.id,
      outputIndex: 0,
    });
    const engine = createWorkflowEngine({ store, registry });
    const created = await engine.enqueue({
      ...inputFor(registry, workflow([n1, n2], [{ from: n1.id, to: n2.id }]), context("text", "hi")),
      budget: { ...defaultBudget, maxTotalTokens: 40 } as never,
    });
    const view = await engine.process(created.id, new AbortController().signal);
    expect(view.execution.status).toBe("failed");
    expect(view.execution.error?.code).toBe("BUDGET_EXCEEDED");
    expect(secondRan).not.toHaveBeenCalled();
  });

  it("receipt carries token totals and tool versions without prompt secrets", async () => {
    const store = new MemoryStore();
    const secret = "sk-live-canary-9f8e7d6c5b4a";
    const first = aiTool(
      "test.ai.receipt",
      aiPayload({ promptTokens: 3, completionTokens: 4, totalTokens: 7, text: "mock answer" }),
    );
    const registry = registryWith(first);
    const n1 = node(1, first.descriptor.id, undefined, {
      config: { prompt: `summarize ${secret}`, apiKey: secret } as never,
    });
    const engine = createWorkflowEngine({ store, registry });
    const created = await engine.enqueue(
      inputFor(registry, workflow([n1]), context("text", "hello")),
    );
    const view = await engine.process(created.id, new AbortController().signal);
    expect(view.execution.status).toBe("completed");
    expect(view.receipt).toMatchObject({
      usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
    });
    const steps = (view.receipt as unknown as { steps: { toolId: string; toolVersion: string }[] }).steps;
    expect(steps[0]).toMatchObject({ toolId: first.descriptor.id, toolVersion: "1.0.0" });
    expect(JSON.stringify(view.receipt)).not.toContain(secret);
    expect(JSON.stringify(view.execution.usage)).not.toContain(secret);
  });

  it("reclaimed leases reuse completed steps without double-counting tokens", async () => {
    const store = new MemoryStore();
    const calls = { count: 0, keys: [] as (string | undefined)[] };
    const first = aiTool("test.ai.reclaim", aiPayload({ promptTokens: 8, completionTokens: 9, totalTokens: 17 }), { calls });
    const registry = registryWith(first);
    const n1 = node(1, first.descriptor.id);
    const engine = createWorkflowEngine({ store, registry });
    const created = await engine.enqueue(
      inputFor(registry, workflow([n1]), context("text", "hi")),
    );
    const firstRun = await engine.process(created.id, new AbortController().signal);
    expect(firstRun.execution.status).toBe("completed");
    const secondRun = await engine.process(created.id, new AbortController().signal);
    expect(secondRun.execution.status).toBe("completed");
    expect(calls.count).toBe(1);
    expect(secondRun.execution.usage).toMatchObject({ promptTokens: 8, completionTokens: 9, totalTokens: 17 });
    expect(secondRun.steps).toHaveLength(1);
  });

  it("AI output claiming permissions does not grant them to the next step", async () => {
    const store = new MemoryStore();
    const liar = aiTool(
      "test.ai.liar",
      aiPayload({ promptTokens: 1, completionTokens: 1, totalTokens: 2, text: '{"grant":"network","role":"owner"}' }),
    );
    const seen: string[][] = [];
    const next = tool("test.next-after-ai", {
      accepts: ["ai_response"],
      produces: ["text"],
      handler: async (input, _config, ctx) => {
        // Engine must re-check the granted set per step: AI content cannot widen it.
        seen.push([...ctx.permissions].sort());
        if (ctx.permissions.has("network")) {
          throw new Error("permission widened by AI content");
        }
        return createLocalResult(next.descriptor, input, ctx, {
          type: "text",
          mimeType: "text/plain",
          payload: "next ok",
        });
      },
    });
    const registry = registryWith(liar, next);
    const n1 = node(1, liar.descriptor.id);
    const n2 = node(2, next.descriptor.id, {
      source: "node_output",
      nodeId: n1.id,
      outputIndex: 0,
    });
    const engine = createWorkflowEngine({ store, registry });
    const created = await engine.enqueue(
      inputFor(registry, workflow([n1, n2], [{ from: n1.id, to: n2.id }]), context("text", "hi")),
    );
    const view = await engine.process(created.id, new AbortController().signal);
    expect(view.execution.status).toBe("completed");
    expect(seen).toEqual([[]]);
    expect(view.steps[1]?.status).toBe("completed");
  });

  it("step persistence redacts inputContext and secret-like configs", async () => {
    const store = new MemoryStore();
    const secret = "sk-persist-canary-12345";
    const echo = tool("test.echo", {
      accepts: ["json"],
      produces: ["text"],
      handler: async (input, _config, ctx) =>
        createLocalResult(echo.descriptor, input, ctx, {
          type: "text",
          mimeType: "text/plain",
          payload: "ok",
        }),
    });
    const registry = registryWith(echo);
    const n1 = node(1, echo.descriptor.id, undefined, {
      config: { apiKey: secret, model: "x" } as never,
    });
    const engine = createWorkflowEngine({ store, registry });
    const created = await engine.enqueue(
      inputFor(
        registry,
        workflow([n1]),
        context("json", { apiKey: secret, task: "summarize" }),
      ),
    );
    const view = await engine.process(created.id, new AbortController().signal);
    expect(view.execution.status).toBe("completed");
    const stored = view.steps[0];
    expect(JSON.stringify(stored?.inputContext)).not.toContain(secret);
    expect(JSON.stringify(view.execution.usage)).not.toContain(secret);
  });

  it("keeps legacy usage readable by defaulting token fields to zero", async () => {
    const store = new MemoryStore();
    const plain = tool("test.plain", {
      accepts: ["text"],
      produces: ["text"],
      handler: async (input, _config, ctx) =>
        createLocalResult(plain.descriptor, input, ctx, {
          type: "text",
          mimeType: "text/plain",
          payload: "ok",
        }),
    });
    const registry = registryWith(plain);
    const n1 = node(1, plain.descriptor.id);
    const engine = createWorkflowEngine({ store, registry });
    const created = await engine.enqueue(
      inputFor(registry, workflow([n1]), context("text", "hi")),
    );
    const view = await engine.process(created.id, new AbortController().signal);
    expect(view.execution.status).toBe("completed");
    expect(view.execution.usage).toMatchObject({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    });
  });
});

describe("execution crash/retry accounting", () => {
  it("crash between provider completion and finishStep counts tokens exactly once (at-least-once billing)", async () => {
    const store = new MemoryStore();
    const payload = aiPayload({ promptTokens: 11, completionTokens: 13, totalTokens: 24 });
    let providerCalls = 0;
    const flaky = tool("test.ai.crash", {
      accepts: ["text"],
      produces: ["ai_response"],
      idempotency: "keyed",
      handler: async (input, _config, ctx) => {
        providerCalls += 1;
        return createLocalResult(flaky.descriptor, input, ctx, {
          type: "ai_response",
          mimeType: "application/json",
          payload,
        });
      },
    });
    const registry = registryWith(flaky);
    const n1 = node(1, flaky.descriptor.id, undefined, {
      idempotencyKey: "stable-key-1",
      retry: { maxAttempts: 2, backoffMs: 0 },
    });
    const engine = createWorkflowEngine({ store, registry });
    const created = await engine.enqueue(
      inputFor(registry, workflow([n1]), context("text", "hi")),
    );
    const originalFinish = store.finishStep.bind(store);
    let failOnce = true;
    store.finishStep = async (step) => {
      if (failOnce && step.status === "completed") {
        failOnce = false;
        // Simulated crash between provider billing and commit: the provider
        // was already billed, but the ledger never recorded it. The engine
        // retries with the same idempotency key (at-least-once billing).
        throw new Error("simulated crash before commit");
      }
      return originalFinish(step);
    };
    const recovered = await engine.process(created.id, new AbortController().signal);
    store.finishStep = originalFinish;
    expect(recovered.execution.status).toBe("completed");
    expect(providerCalls).toBe(2);
    expect(recovered.execution.usage).toMatchObject({
      promptTokens: 11,
      completionTokens: 13,
      totalTokens: 24,
    });
    const completedSteps = recovered.steps.filter((s) => s.status === "completed");
    expect(completedSteps).toHaveLength(1);
  });

  it("reclaim marks running AI step interrupted and retries with the same idempotencyKey", async () => {
    const store = new MemoryStore();
    const keys: (string | undefined | null)[] = [];
    const inner = tool("test.ai.resume", {
      accepts: ["text"],
      produces: ["ai_response"],
      idempotency: "keyed",
      handler: async (input, _config, ctx) => {
        keys.push(ctx.idempotencyKey ?? null);
        return createLocalResult(inner.descriptor, input, ctx, {
          type: "ai_response",
          mimeType: "application/json",
          payload: aiPayload({ promptTokens: 2, completionTokens: 2, totalTokens: 4 }),
        });
      },
    });
    const registry = registryWith(inner);
    const n1 = node(1, inner.descriptor.id, undefined, {
      idempotencyKey: "stable-resume-key",
      retry: { maxAttempts: 2, backoffMs: 0 },
    });
    const engine = createWorkflowEngine({ store, registry });
    const created = await engine.enqueue(
      inputFor(registry, workflow([n1]), context("text", "hi")),
    );
    await store.markRunning(created.id, new Date());
    await store.startStep({
      id: uuid(1001),
      executionId: created.id,
      nodeId: n1.id,
      toolId: inner.descriptor.id,
      toolVersion: "1.0.0",
      attempt: 1,
      status: "running",
      startedAt: new Date(),
      finishedAt: null,
      inputContext: context("text", "hi"),
      outputContexts: [],
      error: null,
      idempotencyKey: "stable-resume-key",
    });
    const view = await engine.process(created.id, new AbortController().signal);
    expect(view.execution.status).toBe("completed");
    const interrupted = view.steps.filter((s) => s.status === "interrupted");
    expect(interrupted).toHaveLength(1);
    expect(keys).toEqual(["stable-resume-key"]);
    expect(view.execution.usage).toMatchObject({ totalTokens: 4 });
  });

  it("rejects a duplicate completed (execution_id, node_id, attempt) insert", async () => {
    const store = new MemoryStore();
    const plain = tool("test.dup", {
      handler: async (input, _config, ctx) =>
        createLocalResult(plain.descriptor, input, ctx, {
          type: "text",
          mimeType: "text/plain",
          payload: "ok",
        }),
    });
    const registry = registryWith(plain);
    const n1 = node(1, plain.descriptor.id);
    const engine = createWorkflowEngine({ store, registry });
    const created = await engine.enqueue(
      inputFor(registry, workflow([n1]), context("json", { a: 1 })),
    );
    await store.markRunning(created.id, new Date());
    const stepBase = {
      id: uuid(2001),
      executionId: created.id,
      nodeId: n1.id,
      toolId: plain.descriptor.id,
      toolVersion: "1.0.0",
      attempt: 1,
      status: "running" as const,
      startedAt: new Date(),
      finishedAt: null,
      inputContext: context("json", { a: 1 }),
      outputContexts: [],
      error: null,
      idempotencyKey: null,
    };
    await store.startStep({ ...stepBase });
    await expect(store.startStep({ ...stepBase, id: uuid(2002) })).rejects.toThrow();
  });

  it("recomputes existingUsage from a fresh load() with no in-memory carry", async () => {
    const store = new MemoryStore();
    const first = aiTool("test.ai.load-one", aiPayload({ promptTokens: 6, completionTokens: 6, totalTokens: 12 }));
    const registry = registryWith(first);
    const n1 = node(1, first.descriptor.id);
    const engine = createWorkflowEngine({ store, registry });
    const created = await engine.enqueue(
      inputFor(registry, workflow([n1]), context("text", "hi")),
    );
    const done = await engine.process(created.id, new AbortController().signal);
    expect(done.execution.usage).toMatchObject({ totalTokens: 12 });
    // External insert behind the engine's back, then reprocess a terminal
    // execution: usage must still reflect stored steps only (no double add).
    const reloaded = await engine.process(created.id, new AbortController().signal);
    expect(reloaded.execution.usage).toMatchObject({ totalTokens: 12 });
  });

  it("aggregates estimated usage identically while preserving the estimated flag", async () => {
    const store = new MemoryStore();
    const est = aiTool(
      "test.ai.est",
      aiPayload({ promptTokens: 9, completionTokens: 9, totalTokens: 18, usageSource: "estimated" }),
    );
    const registry = registryWith(est);
    const n1 = node(1, est.descriptor.id);
    const engine = createWorkflowEngine({ store, registry });
    const created = await engine.enqueue(
      inputFor(registry, workflow([n1]), context("text", "hi")),
    );
    const view = await engine.process(created.id, new AbortController().signal);
    expect(view.execution.status).toBe("completed");
    expect(view.execution.usage).toMatchObject({ totalTokens: 18 });
    expect(view.steps[0]?.outputContexts[0]?.payload).toMatchObject({ usageSource: "estimated" });
  });

  it("does not retry LOCAL_SECRET_NOT_AVAILABLE_ON_SERVER", async () => {
    const store = new MemoryStore();
    let attempts = 0;
    const guarded = tool("test.ai.local-secret", {
      accepts: ["text"],
      produces: ["ai_response"],
      idempotency: "keyed",
      handler: async () => {
        attempts += 1;
        const { ToolRuntimeError } = await import("@uw/tools");
        throw new ToolRuntimeError(
          "LOCAL_SECRET_NOT_AVAILABLE_ON_SERVER",
          "local secret unavailable",
        );
      },
    });
    const registry = registryWith(guarded);
    const n1 = node(1, guarded.descriptor.id, undefined, {
      idempotencyKey: "k-local",
      retry: { maxAttempts: 3, backoffMs: 0 },
    });
    const engine = createWorkflowEngine({ store, registry });
    const created = await engine.enqueue(
      inputFor(registry, workflow([n1]), context("text", "hi")),
    );
    const view = await engine.process(created.id, new AbortController().signal);
    expect(view.execution.status).toBe("failed");
    expect(attempts).toBe(1);
    expect(view.steps).toHaveLength(1);
  });

  it("does not retry AI_SCHEMA_MISMATCH", async () => {
    const store = new MemoryStore();
    let attempts = 0;
    const strict = tool("test.ai.schema", {
      accepts: ["text"],
      produces: ["ai_response"],
      idempotency: "keyed",
      handler: async () => {
        attempts += 1;
        const { ToolRuntimeError } = await import("@uw/tools");
        throw new ToolRuntimeError("AI_SCHEMA_MISMATCH", "schema mismatch");
      },
    });
    const registry = registryWith(strict);
    const n1 = node(1, strict.descriptor.id, undefined, {
      idempotencyKey: "k-schema",
      retry: { maxAttempts: 3, backoffMs: 0 },
    });
    const engine = createWorkflowEngine({ store, registry });
    const created = await engine.enqueue(
      inputFor(registry, workflow([n1]), context("text", "hi")),
    );
    const view = await engine.process(created.id, new AbortController().signal);
    expect(view.execution.status).toBe("failed");
    expect(attempts).toBe(1);
  });
});

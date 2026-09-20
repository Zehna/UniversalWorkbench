import { describe, expect, it, vi } from "vitest";
import type { Clock } from "@uw/shared";
import {
  createExecutionWorker,
  type ExecutionEngine,
  type ExecutionQueue,
  type QueueJob,
} from "../src/index.js";

const NOW = new Date("2026-09-20T00:00:00.000Z");

class FixedClock implements Clock {
  now(): Date {
    return new Date(NOW);
  }
}

function claimedJob(): QueueJob {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    executionId: "22222222-2222-4222-8222-222222222222",
    stepExecutionId: "33333333-3333-4333-8333-333333333333",
    queueType: "step",
    attempt: 0,
    availableAt: NOW.toISOString(),
    leaseOwner: "worker-test",
    leaseExpiresAt: new Date(NOW.getTime() + 30_000).toISOString(),
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}

describe("ExecutionWorker", () => {
  it("runs one claimed job through the engine", async () => {
    const queue = {
      claim: vi.fn(async () => claimedJob()),
      abandon: vi.fn(async () => true),
    } as unknown as ExecutionQueue;
    const engine = {
      runClaimedJob: vi.fn(async () => undefined),
    } as unknown as ExecutionEngine;
    const worker = createExecutionWorker({
      workerId: "worker-test",
      queue,
      engine,
      clock: new FixedClock(),
      leaseMs: 30_000,
      pollIntervalMs: 100,
    });

    expect(await worker.runOnce()).toBe(true);
    expect(engine.runClaimedJob).toHaveBeenCalledTimes(1);
    expect(queue.abandon).not.toHaveBeenCalled();
  });

  it("abandons the lease when the engine crashes unexpectedly", async () => {
    const queue = {
      claim: vi.fn(async () => claimedJob()),
      abandon: vi.fn(async () => true),
    } as unknown as ExecutionQueue;
    const engine = {
      runClaimedJob: vi.fn(async () => {
        throw new Error("unexpected engine crash");
      }),
    } as unknown as ExecutionEngine;
    const worker = createExecutionWorker({
      workerId: "worker-test",
      queue,
      engine,
      clock: new FixedClock(),
      leaseMs: 30_000,
      pollIntervalMs: 100,
    });

    await expect(worker.runOnce()).rejects.toThrow("unexpected engine crash");
    expect(queue.abandon).toHaveBeenCalledWith(
      claimedJob().id,
      "worker-test",
    );
  });

  it("starts and stops an idle polling loop cooperatively", async () => {
    const queue = {
      claim: vi.fn(async () => null),
    } as unknown as ExecutionQueue;
    const engine = {} as ExecutionEngine;
    let releaseDelay: (() => void) | null = null;
    const delay = vi.fn(
      async (_milliseconds: number, signal: AbortSignal) =>
        new Promise<void>((resolve) => {
          releaseDelay = resolve;
          signal.addEventListener("abort", resolve, { once: true });
        }),
    );
    const worker = createExecutionWorker({
      workerId: "worker-test",
      queue,
      engine,
      clock: new FixedClock(),
      leaseMs: 30_000,
      pollIntervalMs: 100,
      delay,
    });

    worker.start();
    await vi.waitFor(() => expect(queue.claim).toHaveBeenCalled());
    await worker.stop();

    expect(worker.isRunning()).toBe(false);
    releaseDelay?.();
  });
});

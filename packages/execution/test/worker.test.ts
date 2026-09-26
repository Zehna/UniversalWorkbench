import { describe, expect, it, vi } from "vitest";
import { createExecutionWorker } from "../src/worker.js";
import type { ExecutionQueue, QueueLease } from "../src/queue.js";

const start = new Date("2026-09-26T12:00:00.000Z");
const lease: QueueLease = {
  executionId: "00000000-0000-4000-8000-000000000001",
  workerId: "worker-1",
  leaseToken: "00000000-0000-4000-8000-000000000002",
  leasedUntil: new Date(start.getTime() + 5000),
  attempt: 1,
};

function mockQueue(initial: QueueLease | null = lease) {
  const queue = {
    enqueue: vi.fn(async () => {}),
    claim: vi.fn(async () => initial),
    ack: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
    renew: vi.fn(async (current: QueueLease) => current),
  } satisfies ExecutionQueue;
  return queue;
}

describe("execution worker lease delegation", () => {
  it("delegates exactly once and ACKs only after the processor resolves", async () => {
    const queue = mockQueue();
    let finish!: () => void;
    const pendingProcessor = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const processor = vi.fn(async () => pendingProcessor);
    const worker = createExecutionWorker({
      queue,
      processor,
      workerId: "worker-1",
      now: () => start,
    });

    const result = worker.runOnce();
    await vi.waitFor(() => expect(processor).toHaveBeenCalledTimes(1));
    expect(queue.ack).not.toHaveBeenCalled();
    expect(queue.release).not.toHaveBeenCalled();
    finish();
    await expect(result).resolves.toBe("processed");
    expect(processor).toHaveBeenCalledWith(
      lease.executionId,
      expect.any(AbortSignal),
    );
    expect(queue.ack).toHaveBeenCalledTimes(1);
    expect(queue.ack).toHaveBeenCalledWith(lease);
    expect(queue.release).not.toHaveBeenCalled();
  });

  it("releases failed processing with a bounded retry delay instead of ACKing", async () => {
    const queue = mockQueue();
    const processor = vi.fn(async () => {
      throw new Error("processor failed");
    });
    const worker = createExecutionWorker({
      queue,
      processor,
      workerId: "worker-1",
      now: () => start,
      retryDelayMs: 7000,
    });
    await expect(worker.runOnce()).rejects.toThrow("processor failed");
    expect(queue.ack).not.toHaveBeenCalled();
    expect(queue.release).toHaveBeenCalledExactlyOnceWith(
      lease,
      new Date(start.getTime() + 7000),
    );
  });

  it("does not release an already processed item when ACK fails", async () => {
    const queue = mockQueue();
    queue.ack.mockRejectedValueOnce(
      new Error("connection dropped after commit"),
    );
    const worker = createExecutionWorker({
      queue,
      workerId: "worker-1",
      processor: async () => {},
      now: () => start,
    });
    await expect(worker.runOnce()).rejects.toThrow("connection dropped");
    expect(queue.release).not.toHaveBeenCalled();
  });

  it("returns idle without touching the processor if the queue is empty", async () => {
    const queue = mockQueue(null);
    const processor = vi.fn(async () => {});
    const worker = createExecutionWorker({
      queue,
      workerId: "worker-1",
      processor,
      now: () => start,
    });
    await expect(worker.runOnce()).resolves.toBe("idle");
    expect(processor).not.toHaveBeenCalled();
    expect(queue.ack).not.toHaveBeenCalled();
  });

  it("respects an aborted signal before claiming more work", async () => {
    const queue = mockQueue();
    const controller = new AbortController();
    controller.abort();
    const worker = createExecutionWorker({
      queue,
      workerId: "worker-1",
      processor: async () => {},
      now: () => start,
    });
    await expect(worker.runOnce(controller.signal)).resolves.toBe("idle");
    expect(queue.claim).not.toHaveBeenCalled();
  });

  it("ends the polling loop when SIGTERM aborts the controller", async () => {
    const controller = new AbortController();
    const queue = mockQueue(null);
    queue.claim.mockImplementation(async () => {
      controller.abort();
      return null;
    });
    const worker = createExecutionWorker({
      queue,
      workerId: "worker-1",
      processor: async () => {},
      now: () => start,
      pollIntervalMs: 20,
    });
    await expect(
      worker.runUntilStopped(controller.signal),
    ).resolves.toBeUndefined();
    expect(queue.claim).toHaveBeenCalledTimes(1);
  });

  it("refuses invalid polling and lease settings", () => {
    expect(() =>
      createExecutionWorker({
        queue: mockQueue(),
        workerId: "worker-1",
        processor: async () => {},
        leaseMs: 0,
      }),
    ).toThrow("Invalid worker");
  });
});

import { setTimeout as sleep } from "node:timers/promises";
import type { ExecutionQueue, QueueLease } from "./queue.js";

export interface ExecutionWorker {
  runOnce(signal?: AbortSignal): Promise<"processed" | "idle">;
  runUntilStopped(signal: AbortSignal): Promise<void>;
}

export interface WorkerOptions {
  queue: ExecutionQueue;
  workerId: string;
  processor: (executionId: string, signal: AbortSignal) => Promise<void>;
  pollIntervalMs?: number;
  leaseMs?: number;
  retryDelayMs?: number;
  now?: () => Date;
  onError?: (error: unknown) => void;
}

export function createExecutionWorker(options: WorkerOptions): ExecutionWorker {
  const pollMs = options.pollIntervalMs ?? 500;
  const leaseMs = options.leaseMs ?? 60_000;
  const retryMs = options.retryDelayMs ?? 30_000;
  const now = options.now ?? (() => new Date());

  if (!options.workerId || options.workerId.length > 128) {
    throw new Error("Worker ID must be nonempty and at most 128 characters");
  }
  if (
    ![pollMs, leaseMs, retryMs].every(Number.isSafeInteger) ||
    pollMs < 10 ||
    pollMs > 60_000 ||
    leaseMs < 1000 ||
    leaseMs > 3_600_000 ||
    retryMs < 0 ||
    retryMs > 3_600_000
  ) {
    throw new Error("Invalid worker polling, lease, or retry interval");
  }

  async function runOnce(
    signal: AbortSignal = new AbortController().signal,
  ): Promise<"processed" | "idle"> {
    if (signal.aborted) return "idle";
    let lease: QueueLease | null = await options.queue.claim(
      options.workerId,
      now(),
      leaseMs,
    );
    if (!lease) return "idle";

    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) controller.abort();

    let renewing: Promise<void> | null = null;
    let renewalError: unknown;
    const timer = setInterval(
      () => {
        if (renewing || controller.signal.aborted) return;
        renewing = options.queue
          .renew(lease!, now(), leaseMs)
          .then((current) => {
            lease = current;
          })
          .catch((error: unknown) => {
            renewalError = error;
            controller.abort();
          })
          .finally(() => {
            renewing = null;
          });
      },
      Math.max(250, Math.floor(leaseMs / 3)),
    );
    timer.unref();
    let finished = false;
    try {
      if (controller.signal.aborted)
        throw new Error("Execution worker is stopping");
      await options.processor(lease.executionId, controller.signal);
      finished = true;
      clearInterval(timer);
      if (renewing) await renewing;
      if (renewalError) throw renewalError;
      // Completion precedes ACK, even if SIGTERM arrives during processing.
      await options.queue.ack(lease);
      return "processed";
    } catch (error) {
      clearInterval(timer);
      if (renewing) await renewing;
      if (renewalError) throw renewalError;
      // A possibly committed ACK must never trigger a duplicate release.
      if (!finished) {
        await options.queue.release(lease, new Date(now().getTime() + retryMs));
      }
      throw error;
    } finally {
      clearInterval(timer);
      signal.removeEventListener("abort", cancel);
    }
  }

  async function runUntilStopped(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const outcome = await runOnce(signal);
        if (outcome === "processed") continue;
      } catch (error) {
        options.onError?.(error);
      }
      if (signal.aborted) break;
      try {
        await sleep(pollMs, undefined, { signal });
      } catch (error) {
        if (!signal.aborted) throw error;
      }
    }
  }

  return { runOnce, runUntilStopped };
}

import type { Clock } from "@uw/shared";
import type { ExecutionEngine } from "./engine.js";
import type { ExecutionQueue } from "./queue.js";

export interface ExecutionWorker {
  start(): void;
  stop(): Promise<void>;
  runOnce(signal?: AbortSignal): Promise<boolean>;
  isRunning(): boolean;
}

interface ExecutionWorkerDependencies {
  workerId: string;
  queue: ExecutionQueue;
  engine: ExecutionEngine;
  clock: Clock;
  leaseMs: number;
  pollIntervalMs: number;
  delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

function defaultDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = globalThis.setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        globalThis.clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export function createExecutionWorker(
  dependencies: ExecutionWorkerDependencies,
): ExecutionWorker {
  const {
    workerId,
    queue,
    engine,
    clock,
    leaseMs,
    pollIntervalMs,
    delay = defaultDelay,
  } = dependencies;

  let controller: AbortController | null = null;
  let loop: Promise<void> | null = null;

  async function runOnce(signal?: AbortSignal): Promise<boolean> {
    const job = await queue.claim(
      workerId,
      clock.now().toISOString(),
      leaseMs,
    );
    if (!job) return false;

    try {
      await engine.runClaimedJob(job, workerId, signal);
      return true;
    } catch (error) {
      await queue.abandon(job.id, workerId);
      throw error;
    }
  }

  async function runLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const didWork = await runOnce(signal);
        if (!didWork && !signal.aborted) {
          await delay(pollIntervalMs, signal);
        }
      } catch {
        if (!signal.aborted) {
          await delay(pollIntervalMs, signal);
        }
      }
    }
  }

  return {
    start() {
      if (loop) return;
      controller = new AbortController();
      loop = runLoop(controller.signal).finally(() => {
        loop = null;
        controller = null;
      });
    },

    async stop() {
      controller?.abort();
      await loop;
    },

    runOnce,

    isRunning() {
      return loop !== null;
    },
  };
}

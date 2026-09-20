import { act, render, screen } from "@testing-library/react";
import type { Execution } from "@uw/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ExecutionSnapshot,
  WorkflowApiClient,
} from "../src/workflows/api";
import { ExecutionTimeline } from "../src/workflows/ExecutionTimeline";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const EXECUTION_ID = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-09-20T00:00:00.000Z";

function execution(status: Execution["status"]): Execution {
  return {
    id: EXECUTION_ID,
    ownerId: "33333333-3333-4333-8333-333333333333",
    projectId: PROJECT_ID,
    kind: "workflow",
    workflowRevisionId: "44444444-4444-4444-8444-444444444444",
    status,
    traceId: "trace",
    idempotencyKey: "idem",
    budget: {
      maxWallClockMs: 60_000,
      maxSteps: 10,
      maxAttemptsPerStep: 3,
      maxTotalAttempts: 20,
      maxOutputBytes: 1_048_576,
      maxHttpRequests: 10,
    },
    queuedAt: NOW,
    ...(status === "succeeded"
      ? { startedAt: NOW, finishedAt: "2026-09-20T00:00:02.000Z" }
      : {}),
  };
}

function snapshot(status: Execution["status"]): ExecutionSnapshot {
  return {
    execution: execution(status),
    steps: [
      {
        id: "55555555-5555-4555-8555-555555555555",
        nodeId: "step-1",
        toolId: "builtin.json.select",
        toolVersion: "1",
        status: status === "succeeded" ? "succeeded" : "running",
        attempt: 1,
        startedAt: NOW,
        finishedAt:
          status === "succeeded" ? "2026-09-20T00:00:01.000Z" : null,
        error: null,
      },
    ],
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ExecutionTimeline", () => {
  it("polls while active and stops after the execution becomes terminal", async () => {
    vi.useFakeTimers();
    const getExecution = vi
      .fn()
      .mockResolvedValueOnce(snapshot("running"))
      .mockResolvedValueOnce(snapshot("succeeded"));

    const api = {
      listTools: vi.fn(),
      compatibleTargets: vi.fn(),
      validateWorkflow: vi.fn(),
      runWorkflow: vi.fn(),
      getExecution,
      getReceipt: vi.fn().mockResolvedValue({ receipts: [], provenance: [] }),
    } satisfies WorkflowApiClient;

    render(
      <ExecutionTimeline
        projectId={PROJECT_ID}
        executionId={EXECUTION_ID}
        api={api}
        pollIntervalMs={1_000}
      />,
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(await screen.findByText(/running/i)).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(await screen.findByText(/succeeded/i)).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(getExecution).toHaveBeenCalledTimes(2);
  });
});

import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Execution } from "@uw/contracts";
import { ExecutionTimeline } from "../src/workflows/ExecutionTimeline";
import type { WorkflowApiClient } from "../src/workflows/types";

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
    traceId: "55555555-5555-4555-8555-555555555555",
    idempotencyKey: "run",
    budget: {
      maxWallClockMs: 60000,
      maxSteps: 50,
      maxAttemptsPerStep: 3,
      maxTotalAttempts: 100,
      maxOutputBytes: 10485760,
      maxHttpRequests: 20,
    },
    queuedAt: NOW,
    ...(status === "succeeded" ? { finishedAt: NOW } : {}),
  };
}

describe("ExecutionTimeline", () => {
  it("polls until terminal and then renders receipt information", async () => {
    const getExecution = vi
      .fn()
      .mockResolvedValueOnce({
        execution: execution("running"),
        steps: [
          {
            id: "66666666-6666-4666-8666-666666666666",
            nodeId: "http",
            toolId: "builtin.http.request",
            toolVersion: "1",
            status: "running",
            attempt: 1,
            startedAt: NOW,
            finishedAt: null,
            error: null,
          },
        ],
      })
      .mockResolvedValue({
        execution: execution("succeeded"),
        steps: [
          {
            id: "66666666-6666-4666-8666-666666666666",
            nodeId: "http",
            toolId: "builtin.http.request",
            toolVersion: "1",
            status: "succeeded",
            attempt: 1,
            startedAt: NOW,
            finishedAt: NOW,
            error: null,
          },
        ],
      });
    const getReceipt = vi.fn().mockResolvedValue({
      receipts: [{ id: "receipt-1" }],
      provenance: [{ id: "edge-1" }],
    });
    const client = {
      listTools: vi.fn(),
      compatibleTargets: vi.fn(),
      validateWorkflow: vi.fn(),
      runWorkflow: vi.fn(),
      getExecution,
      getReceipt,
    } as unknown as WorkflowApiClient;

    render(
      <ExecutionTimeline
        projectId={PROJECT_ID}
        executionId={EXECUTION_ID}
        client={client}
        pollMs={1}
      />,
    );

    expect(await screen.findByText(/execution: succeeded/i)).toBeInTheDocument();
    expect(screen.getByText(/http · succeeded · attempt 1/i)).toBeInTheDocument();
    expect(screen.getByText(/receipts: 1/i)).toBeInTheDocument();
    expect(screen.getByText(/provenance edges: 1/i)).toBeInTheDocument();

    await waitFor(() => expect(getExecution.mock.calls.length).toBeGreaterThan(1));
    expect(getReceipt).toHaveBeenCalledTimes(1);
  });
});

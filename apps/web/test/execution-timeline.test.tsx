import { render, screen, waitFor } from "@testing-library/react";
import type { Execution } from "@uw/contracts";
import { describe, expect, it, vi } from "vitest";
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
    outputs:
      status === "succeeded"
        ? [
            {
              stepExecutionId: "55555555-5555-4555-8555-555555555555",
              portName: "note",
              context: {
                id: "66666666-6666-4666-8666-666666666666",
                type: "note-ref",
                schemaVersion: 1,
                mimeType: "application/vnd.uw.note-ref+json",
                metadata: {},
                payload: {
                  documentId: "77777777-7777-4777-8777-777777777777",
                  revisionId: "88888888-8888-4888-8888-888888888888",
                  title: "Generated Note",
                },
                provenance: {
                  projectId: PROJECT_ID,
                  artifactIds: [],
                  parentContextIds: [],
                },
                capabilities: [],
              },
            },
          ]
        : [],
  };
}

describe("ExecutionTimeline", () => {
  it("polls until terminal, renders receipt data, and then stops polling", async () => {
    const getExecution = vi
      .fn()
      .mockResolvedValueOnce(snapshot("running"))
      .mockResolvedValue(snapshot("succeeded"));
    const getReceipt = vi.fn().mockResolvedValue({
      receipts: [{ id: "receipt-1" }],
      provenance: [{ id: "edge-1" }],
    });

    const api = {
      listTools: vi.fn(),
      compatibleTargets: vi.fn(),
      validateWorkflow: vi.fn(),
      runWorkflow: vi.fn(),
      getExecution,
      getReceipt,
    } satisfies WorkflowApiClient;

    render(
      <ExecutionTimeline
        projectId={PROJECT_ID}
        executionId={EXECUTION_ID}
        api={api}
        pollIntervalMs={1}
      />,
    );

    expect(await screen.findByText(/execution: succeeded/i)).toBeInTheDocument();
    expect(screen.getByText(/step-1 · succeeded · attempt 1/i)).toBeInTheDocument();
    expect(screen.getByText(/receipts: 1/i)).toBeInTheDocument();
    expect(screen.getByText(/provenance edges: 1/i)).toBeInTheDocument();
    expect(
      screen.getByText(/note · note-ref · generated note/i),
    ).toBeInTheDocument();

    await waitFor(() => expect(getExecution).toHaveBeenCalledTimes(2));
    expect(getReceipt).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(getExecution).toHaveBeenCalledTimes(2);
  });
});

import { fireEvent, render, screen } from "@testing-library/react";
import type {
  ToolDefinition,
  WorkflowDocumentView,
} from "@uw/contracts";
import { describe, expect, it, vi } from "vitest";
import type { SyncCoordinator } from "../src/sync/coordinator";
import type { WorkflowApiClient } from "../src/workflows/api";
import { WorkflowEditor } from "../src/workflows/WorkflowEditor";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const WORKFLOW_ID = "22222222-2222-4222-8222-222222222222";
const REVISION_ID = "33333333-3333-4333-8333-333333333333";
const NOW = "2026-09-20T00:00:00.000Z";

const tools: ToolDefinition[] = [
  {
    id: "builtin.json.select",
    version: "1",
    displayName: "JSON Select",
    description: "Select JSON",
    executionMode: "worker",
    accepts: [{ name: "input", types: ["json"], required: true }],
    produces: [{ name: "output", types: ["json"] }],
    configSchema: {},
    requiredCapabilities: [],
    defaults: { timeoutMs: 5_000, maxAttempts: 1 },
  },
  {
    id: "builtin.text.template",
    version: "1",
    displayName: "Text Template",
    description: "Render text",
    executionMode: "worker",
    accepts: [
      {
        name: "input",
        types: ["json", "text", "markdown"],
        required: false,
      },
    ],
    produces: [{ name: "output", types: ["text", "markdown"] }],
    configSchema: {},
    requiredCapabilities: [],
    defaults: { timeoutMs: 5_000, maxAttempts: 1 },
  },
];

function workflowView(): WorkflowDocumentView {
  return {
    document: {
      id: WORKFLOW_ID,
      projectId: PROJECT_ID,
      kind: "workflow",
      title: "Research flow",
      currentRevisionId: REVISION_ID,
      createdAt: NOW,
      updatedAt: NOW,
    },
    revision: {
      id: REVISION_ID,
      documentId: WORKFLOW_ID,
      revisionNumber: 1,
      parentRevisionId: null,
      content: {
        kind: "workflow",
        workflow: {
          schemaVersion: 1,
          name: "Research flow",
          nodes: [
            {
              id: "template",
              tool: { id: "builtin.text.template", version: "1" },
              config: { template: "{{input}}" },
            },
            {
              id: "select",
              tool: { id: "builtin.json.select", version: "1" },
              config: { pointer: "/title" },
            },
          ],
          edges: [],
          outputs: [],
        },
      },
      metadata: {},
      createdAt: NOW,
    },
  };
}

function coordinator(
  state: "ready" | "pending" | "offline" | "conflict" = "ready",
): Pick<
  SyncCoordinator,
  | "createWorkflow"
  | "updateWorkflow"
  | "workflowRunEligibility"
> {
  return {
    createWorkflow: vi.fn(),
    updateWorkflow: vi.fn(),
    workflowRunEligibility: vi.fn().mockResolvedValue(
      state === "ready"
        ? { state: "ready", revisionId: REVISION_ID }
        : { state },
    ),
  };
}

function api(): WorkflowApiClient {
  return {
    listTools: vi.fn().mockResolvedValue(tools),
    compatibleTargets: vi.fn().mockResolvedValue([]),
    validateWorkflow: vi.fn().mockResolvedValue({ valid: true }),
    runWorkflow: vi.fn().mockResolvedValue({
      execution: {
        id: "44444444-4444-4444-8444-444444444444",
        ownerId: "55555555-5555-4555-8555-555555555555",
        projectId: PROJECT_ID,
        kind: "workflow",
        workflowRevisionId: REVISION_ID,
        status: "queued",
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
      },
    }),
    getExecution: vi.fn(),
    getReceipt: vi.fn(),
  };
}

describe("WorkflowEditor", () => {
  it("supports move-up controls without drag-and-drop", async () => {
    render(
      <WorkflowEditor
        projectId={PROJECT_ID}
        initial={workflowView()}
        coordinator={coordinator()}
        api={api()}
        tools={tools}
      />,
    );

    expect((await screen.findAllByTestId("workflow-step"))[0]).toHaveTextContent(
      "Text Template",
    );

    fireEvent.click(
      screen.getByRole("button", { name: /move json select up/i }),
    );

    expect(screen.getAllByTestId("workflow-step")[0]).toHaveTextContent(
      "JSON Select",
    );
  });

  it("disables Run while the workflow has an unsynced local revision", async () => {
    render(
      <WorkflowEditor
        projectId={PROJECT_ID}
        initial={workflowView()}
        coordinator={coordinator("pending")}
        api={api()}
        tools={tools}
      />,
    );

    expect(
      await screen.findByText(/run unavailable until this workflow is synced/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^run$/i })).toBeDisabled();
  });
});

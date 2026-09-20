import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  ToolDefinition,
  WorkflowDocumentView,
} from "@uw/contracts";
import { WorkflowEditor } from "../src/workflows/WorkflowEditor";
import type {
  WorkflowApiClient,
  WorkflowEditorCoordinator,
} from "../src/workflows/types";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const WORKFLOW_ID = "22222222-2222-4222-8222-222222222222";
const REVISION_ID = "33333333-3333-4333-8333-333333333333";
const NOW = "2026-09-20T00:00:00.000Z";

const httpTool: ToolDefinition = {
  id: "builtin.http.request",
  version: "1",
  displayName: "HTTP Request",
  description: "HTTP",
  executionMode: "worker",
  accepts: [{ name: "body", types: ["text", "json"], required: false }],
  produces: [{ name: "response", types: ["api-response"] }],
  configSchema: {},
  requiredCapabilities: ["network.public"],
  defaults: { timeoutMs: 15000, maxAttempts: 3 },
};

const jsonTool: ToolDefinition = {
  id: "builtin.json.parse",
  version: "1",
  displayName: "JSON Parse",
  description: "JSON",
  executionMode: "worker",
  accepts: [{ name: "input", types: ["text", "api-response"], required: true }],
  produces: [{ name: "output", types: ["json"] }],
  configSchema: {},
  requiredCapabilities: [],
  defaults: { timeoutMs: 5000, maxAttempts: 1 },
};

function workflow(): WorkflowDocumentView {
  return {
    document: {
      id: WORKFLOW_ID,
      projectId: PROJECT_ID,
      kind: "workflow",
      title: "Fetch JSON",
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
          name: "Fetch JSON",
          nodes: [
            {
              id: "http",
              tool: { id: httpTool.id, version: httpTool.version },
              config: { url: "https://example.com/data", method: "GET" },
            },
            {
              id: "json",
              tool: { id: jsonTool.id, version: jsonTool.version },
              config: {},
            },
          ],
          edges: [
            {
              from: { nodeId: "http", output: "response" },
              to: { nodeId: "json", input: "input" },
            },
          ],
          outputs: [
            { name: "result", from: { nodeId: "json", output: "output" } },
          ],
        },
      },
      metadata: {},
      createdAt: NOW,
    },
  };
}

function client(): WorkflowApiClient {
  return {
    listTools: vi.fn().mockResolvedValue([httpTool, jsonTool]),
    compatibleTargets: vi.fn().mockResolvedValue([]),
    validateWorkflow: vi.fn(),
    runWorkflow: vi.fn().mockResolvedValue({
      id: "44444444-4444-4444-8444-444444444444",
      ownerId: "55555555-5555-4555-8555-555555555555",
      projectId: PROJECT_ID,
      kind: "workflow",
      workflowRevisionId: REVISION_ID,
      status: "queued",
      traceId: "66666666-6666-4666-8666-666666666666",
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
    }),
    getExecution: vi.fn(),
    getReceipt: vi.fn(),
  };
}

function coordinator(
  eligibility: Awaited<
    ReturnType<WorkflowEditorCoordinator["workflowRunEligibility"]>
  > = { state: "ready", revisionId: REVISION_ID },
): WorkflowEditorCoordinator {
  return {
    createWorkflow: vi.fn(),
    updateWorkflow: vi.fn().mockResolvedValue(workflow()),
    workflowRunEligibility: vi.fn().mockResolvedValue(eligibility),
  };
}

describe("WorkflowEditor", () => {
  it("supports move-up ordering without drag and drop", async () => {
    render(
      <WorkflowEditor
        projectId={PROJECT_ID}
        initial={workflow()}
        coordinator={coordinator()}
        client={client()}
      />,
    );

    expect(await screen.findAllByTestId("workflow-step")).toHaveLength(2);
    fireEvent.click(
      screen.getByRole("button", { name: /move json parse up/i }),
    );

    const steps = screen.getAllByTestId("workflow-step");
    expect(steps[0]).toHaveTextContent("JSON Parse");
    expect(steps[1]).toHaveTextContent("HTTP Request");
  });

  it("disables Run while this workflow has a pending local operation", async () => {
    render(
      <WorkflowEditor
        projectId={PROJECT_ID}
        initial={workflow()}
        coordinator={coordinator({ state: "pending" })}
        client={client()}
      />,
    );

    expect(
      await screen.findByText(/run unavailable until this workflow is synced/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^run$/i })).toBeDisabled();
  });

  it("runs the canonical revision returned by eligibility", async () => {
    const api = client();
    const c = coordinator({
      state: "ready",
      revisionId: "77777777-7777-4777-8777-777777777777",
    });

    render(
      <WorkflowEditor
        projectId={PROJECT_ID}
        initial={workflow()}
        coordinator={c}
        client={api}
      />,
    );

    const run = await screen.findByRole("button", { name: /^run$/i });
    await waitFor(() => expect(run).toBeEnabled());
    fireEvent.click(run);

    await waitFor(() =>
      expect(api.runWorkflow).toHaveBeenCalledWith(
        PROJECT_ID,
        WORKFLOW_ID,
        "77777777-7777-4777-8777-777777777777",
        expect.any(String),
      ),
    );
  });
});

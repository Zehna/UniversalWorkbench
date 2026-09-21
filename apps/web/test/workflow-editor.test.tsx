import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    configSchema: {
      type: "object",
      required: ["pointer"],
      additionalProperties: false,
      properties: { pointer: { type: "string" } },
    },
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
  | "resolveWorkflowConflict"
> {
  return {
    createWorkflow: vi.fn(),
    updateWorkflow: vi.fn(),
    workflowRunEligibility: vi.fn().mockResolvedValue(
      state === "ready"
        ? { state: "ready", revisionId: REVISION_ID }
        : state === "conflict"
          ? {
              state: "conflict",
              operationId: "99999999-9999-4999-8999-999999999999",
            }
          : { state },
    ),
    resolveWorkflowConflict: vi.fn(),
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

  it("uses context compatibility to choose the next step", async () => {
    const client = api();
    vi.mocked(client.compatibleTargets).mockImplementation(async (type) => {
      if (type !== "text" && type !== "markdown") return [];
      return [
        {
          definition: tools[0]!,
          inputPort: tools[0]!.accepts[0]!,
        },
      ];
    });

    render(
      <WorkflowEditor
        projectId={PROJECT_ID}
        initial={workflowView()}
        coordinator={coordinator()}
        api={client}
        tools={tools}
      />,
    );

    await waitFor(() =>
      expect(client.compatibleTargets).toHaveBeenCalledWith("text"),
    );
    await waitFor(() =>
      expect(client.compatibleTargets).toHaveBeenCalledWith("markdown"),
    );

    expect(
      await screen.findByRole("option", { name: "JSON Select" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "Text Template" }),
    ).not.toBeInTheDocument();
  });

  it("binds JSON output to the most specific compatible input port", async () => {
    const gate = coordinator();
    const initial = workflowView();
    initial.revision.content.workflow.nodes = [
      {
        id: "select",
        tool: { id: "builtin.json.select", version: "1" },
        config: { pointer: "/title" },
      },
      {
        id: "template",
        tool: { id: "builtin.text.template", version: "1" },
        config: { template: "{{json:}}" },
      },
    ];
    vi.mocked(gate.updateWorkflow).mockResolvedValue(initial);

    render(
      <WorkflowEditor
        projectId={PROJECT_ID}
        initial={initial}
        coordinator={gate}
        api={api()}
        tools={tools}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /save workflow/i }));

    await waitFor(() => expect(gate.updateWorkflow).toHaveBeenCalled());
    const update = vi.mocked(gate.updateWorkflow).mock.calls[0]?.[1];
    expect(update?.workflow.edges).toContainEqual({
      from: { nodeId: "select", output: "output" },
      to: { nodeId: "template", input: "json" },
    });
  });

  it("does not append a local mutation for an invalid linear workflow", async () => {
    const gate = coordinator();
    const initial = workflowView();
    initial.revision.content.workflow.nodes = [
      {
        id: "select",
        tool: { id: "builtin.json.select", version: "1" },
        config: {},
      },
    ];

    render(
      <WorkflowEditor
        projectId={PROJECT_ID}
        initial={initial}
        coordinator={gate}
        api={api()}
        tools={tools}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /save workflow/i }));

    expect(
      await screen.findByText(/workflow is invalid/i),
    ).toBeInTheDocument();
    expect(gate.updateWorkflow).not.toHaveBeenCalled();
  });

  it("keeps imported branched DAGs read-only instead of linearizing them", async () => {
    const initial = workflowView();
    initial.revision.content.workflow.nodes = [
      {
        id: "root",
        tool: { id: "builtin.text.template", version: "1" },
        config: { template: "root" },
      },
      {
        id: "left",
        tool: { id: "builtin.text.template", version: "1" },
        config: { template: "left" },
      },
      {
        id: "right",
        tool: { id: "builtin.text.template", version: "1" },
        config: { template: "right" },
      },
    ];
    initial.revision.content.workflow.edges = [
      {
        from: { nodeId: "root", output: "output" },
        to: { nodeId: "left", input: "input" },
      },
      {
        from: { nodeId: "root", output: "output" },
        to: { nodeId: "right", input: "input" },
      },
    ];
    initial.revision.content.workflow.outputs = [
      { name: "left", from: { nodeId: "left", output: "output" } },
      { name: "right", from: { nodeId: "right", output: "output" } },
    ];

    render(
      <WorkflowEditor
        projectId={PROJECT_ID}
        initial={initial}
        coordinator={coordinator()}
        api={api()}
        tools={tools}
      />,
    );

    expect(
      screen.getByText(/linear editor cannot modify safely/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save workflow/i })).toBeDisabled();
    expect(screen.getByLabelText("Workflow title")).toBeDisabled();
    expect(screen.getByLabelText("Text Template configuration").closest("textarea"))
      .toBeDisabled();
    expect(screen.getByRole("button", { name: /^run$/i })).toBeEnabled();
  });

  it("disables Run after an unsaved editor change", async () => {
    render(
      <WorkflowEditor
        projectId={PROJECT_ID}
        initial={workflowView()}
        coordinator={coordinator()}
        api={api()}
        tools={tools}
      />,
    );

    const run = await screen.findByRole("button", { name: /^run$/i });
    await waitFor(() => expect(run).toBeEnabled());

    fireEvent.click(
      screen.getByRole("button", { name: /move json select up/i }),
    );

    expect(run).toBeDisabled();
    expect(
      screen.getByText(/run unavailable until this workflow is synced/i),
    ).toBeInTheDocument();
  });

  it("runs the canonical revision returned by eligibility", async () => {
    const client = api();
    const gate = coordinator();
    vi.mocked(gate.workflowRunEligibility).mockResolvedValue({
      state: "ready",
      revisionId: "77777777-7777-4777-8777-777777777777",
    });

    render(
      <WorkflowEditor
        projectId={PROJECT_ID}
        initial={workflowView()}
        coordinator={gate}
        api={client}
        tools={tools}
      />,
    );

    const run = await screen.findByRole("button", { name: /^run$/i });
    await waitFor(() => expect(run).toBeEnabled());
    fireEvent.click(run);

    await waitFor(() =>
      expect(client.runWorkflow).toHaveBeenCalledWith(
        PROJECT_ID,
        WORKFLOW_ID,
        "77777777-7777-4777-8777-777777777777",
        expect.any(String),
      ),
    );
  });

  it("offers explicit workflow conflict resolution", async () => {
    const gate = coordinator("conflict");
    const server = workflowView();
    server.document.title = "Server flow";
    server.revision.content.workflow.name = "Server flow";
    vi.mocked(gate.resolveWorkflowConflict).mockResolvedValue(server);

    render(
      <WorkflowEditor
        projectId={PROJECT_ID}
        initial={workflowView()}
        coordinator={gate}
        api={api()}
        tools={tools}
      />,
    );

    expect(
      await screen.findByText(/workflow sync conflict detected/i),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: /use server version/i }),
    );

    await waitFor(() =>
      expect(gate.resolveWorkflowConflict).toHaveBeenCalledWith(
        "99999999-9999-4999-8999-999999999999",
        "use-server",
      ),
    );
    expect(screen.getByDisplayValue("Server flow")).toBeInTheDocument();
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

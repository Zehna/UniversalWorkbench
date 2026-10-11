import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type {
  ContextEnvelope,
  ToolDescriptor,
  WorkflowDefinition,
} from "@uw/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  api,
  type ExecutionDetails,
  type WorkflowVersion,
} from "../src/api/client";
import { RunWorkflow } from "../src/executions/RunWorkflow";
import { WorkflowEditor } from "../src/workflows/WorkflowEditor";
import { WorkflowList } from "../src/workflows/WorkflowList";

const PROJECT = "22222222-2222-4222-8222-222222222222";
const WORKFLOW = "33333333-3333-4333-8333-333333333333";
const EXECUTION = "44444444-4444-4444-8444-444444444444";
let generated = 0;

function tool(
  id: string,
  name: string,
  accepts: ToolDescriptor["accepts"],
  produces: ToolDescriptor["produces"],
  permissions: string[] = [],
): ToolDescriptor {
  return {
    id,
    name,
    version: "1.0.0",
    description: name,
    accepts,
    produces,
    permissions,
    capabilities: permissions,
    executionMode: "server",
    idempotency: "safe",
    configSchema: { type: "object" },
    requiresApproval: false,
  };
}

const tools: ToolDescriptor[] = [
  tool("builtin.text.trim", "Text Trim", ["text"], ["text"]),
  tool("builtin.text.upper", "Text Upper", ["text"], ["text"]),
  tool(
    "builtin.json.extract",
    "JSON Extract",
    ["json", "api_response"],
    ["json"],
  ),
  tool(
    "builtin.http.request",
    "HTTP Request",
    ["text", "json"],
    ["api_response"],
    ["network"],
  ),
];

const root: ContextEnvelope = {
  id: "11111111-1111-4111-8111-111111111111",
  type: "text",
  schemaVersion: 1,
  mimeType: "text/plain",
  metadata: {},
  payload: "test",
  provenance: { sourceContextIds: [] },
  capabilities: [],
};

function workflow(http = false): WorkflowVersion {
  const id = "55555555-5555-4555-8555-555555555555";
  const definition: WorkflowDefinition = {
    id: WORKFLOW,
    projectId: PROJECT,
    name: "Sample",
    schemaVersion: 1,
    nodes: [
      {
        id,
        toolId: http ? "builtin.http.request" : "builtin.text.trim",
        toolVersion: "1.0.0",
        config: http
          ? { method: "GET", url: "https://fixture.workbench.dev/response" }
          : {},
        input: { source: "workflow_input" },
      },
    ],
    edges: [],
  };
  return {
    id: "66666666-6666-4666-8666-666666666666",
    workflowId: WORKFLOW,
    projectId: PROJECT,
    ownerId: "77777777-7777-4777-8777-777777777777",
    version: 1,
    createdAt: "2026-09-26T00:00:00.000Z",
    definition,
  };
}

function details(
  status: ExecutionDetails["execution"]["status"],
): ExecutionDetails {
  return {
    execution: {
      id: EXECUTION,
      projectId: PROJECT,
      traceId: root.id,
      status,
      error:
        status === "failed"
          ? { code: "TOOL_FAILED", message: "Test failure" }
          : null,
      usage: {},
      startedAt: null,
      finishedAt: null,
    },
    steps: [],
    receipt: null,
  };
}

beforeEach(() => {
  generated = 0;
  vi.stubGlobal("crypto", {
    randomUUID: () =>
      `88888888-8888-4888-8888-${String(++generated).padStart(12, "0")}`,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Phase 3 mobile-first workflow UI", () => {
  it("creates, reorders and removes linear steps without offering incompatible tools", async () => {
    const onSaved = vi.fn();
    const save = vi
      .spyOn(api, "saveWorkflow")
      .mockImplementation(async (_, definition) => ({
        ...workflow(),
        definition,
        version: 1,
      }));
    render(
      <WorkflowEditor
        projectId={PROJECT}
        tools={tools}
        onSaved={onSaved}
        onRun={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Workflow name"), {
      target: { value: "Pipeline" },
    });
    const choice = screen.getByLabelText("Compatible tool");
    fireEvent.change(choice, {
      target: { value: "builtin.text.trim@1.0.0" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add Step" }));
    expect(screen.queryByRole("option", { name: /JSON Extract/i })).toBeNull();
    fireEvent.change(screen.getByLabelText("Compatible tool"), {
      target: { value: "builtin.text.upper@1.0.0" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add Step" }));
    fireEvent.click(screen.getByRole("button", { name: "Move step 2 up" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove step 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Save workflow" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const saved = save.mock.calls[0]?.[1];
    expect(saved?.name).toBe("Pipeline");
    expect(saved?.nodes).toHaveLength(1);
    expect(saved?.nodes[0]?.toolId).toBe("builtin.text.upper");
    expect(saved?.edges).toEqual([]);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("lists saved workflows and opens a linear editor", async () => {
    vi.spyOn(api, "listWorkflows").mockResolvedValue([workflow()]);
    vi.spyOn(api, "listTools").mockResolvedValue({
      tools,
      grantedPermissions: [],
    });
    render(<WorkflowList projectId={PROJECT} />);
    expect(await screen.findByText("Sample")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit Sample" }));
    expect(
      screen.getByRole("heading", { name: "Edit workflow" }),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("Sample")).toBeInTheDocument();
  });

  it("does not enqueue an HTTP workflow without server-granted network permission", () => {
    const enqueue = vi.spyOn(api, "runWorkflow");
    render(
      <RunWorkflow
        projectId={PROJECT}
        workflow={workflow(true)}
        tools={tools}
        grantedPermissions={[]}
        onBack={vi.fn()}
      />,
    );
    expect(screen.getByText(/Missing permission: network/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run workflow" })).toBeDisabled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("enqueues after preflight, refreshes errors, and cancels running executions", async () => {
    const enqueue = vi.spyOn(api, "runWorkflow").mockResolvedValue({
      executionId: EXECUTION,
      traceId: root.id,
      status: "queued",
    });
    const get = vi
      .spyOn(api, "getExecution")
      .mockResolvedValueOnce(details("queued"))
      .mockResolvedValueOnce(details("failed"));
    render(
      <RunWorkflow
        projectId={PROJECT}
        workflow={workflow()}
        tools={tools}
        grantedPermissions={[]}
        onBack={vi.fn()}
      />,
    );
    expect(screen.getByText(/Preflight ready/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Run workflow" }));
    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Status: queued")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    expect(await screen.findByText("Status: failed")).toBeInTheDocument();
    expect(screen.getByText(/Test failure/)).toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("cancels queued executions and saves completed outputs through the API", async () => {
    const enqueue = vi.spyOn(api, "runWorkflow").mockResolvedValue({
      executionId: EXECUTION,
      traceId: root.id,
      status: "queued",
    });
    const get = vi
      .spyOn(api, "getExecution")
      .mockResolvedValueOnce(details("queued"))
      .mockResolvedValueOnce({
        ...details("completed"),
        steps: [
          {
            nodeId: workflow().definition.nodes[0]!.id,
            toolId: "builtin.text.trim",
            toolVersion: "1.0.0",
            attempt: 1,
            status: "completed",
            outputContexts: [root],
            error: null,
          },
        ],
      });
    const cancel = vi
      .spyOn(api, "cancelExecution")
      .mockResolvedValue(details("cancelled"));
    const save = vi.spyOn(api, "saveExecutionOutput").mockResolvedValue({
      id: "99999999-9999-4999-8999-999999999999",
      projectId: PROJECT,
      type: "workflow-output",
      schemaVersion: 1,
      mimeType: "application/json",
      checksumSha256: "f".repeat(64),
      sizeBytes: 6,
      storageKey: "example",
      metadata: {},
      createdAt: "2026-09-26T00:00:00.000Z",
    });
    const ui = render(
      <RunWorkflow
        projectId={PROJECT}
        workflow={workflow()}
        tools={tools}
        grantedPermissions={[]}
        onBack={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Run workflow" }));
    await screen.findByText("Status: queued");
    fireEvent.click(screen.getByRole("button", { name: "Cancel execution" }));
    expect(await screen.findByText("Status: cancelled")).toBeInTheDocument();
    expect(cancel).toHaveBeenCalledTimes(1);
    ui.unmount();

    render(
      <RunWorkflow
        projectId={PROJECT}
        workflow={workflow()}
        tools={tools}
        grantedPermissions={[]}
        onBack={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Run workflow" }));
    await screen.findByText("Status: completed");
    fireEvent.click(
      screen.getByRole("button", { name: "Save output as Artifact" }),
    );
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(PROJECT, EXECUTION, root.id),
    );
    expect(await screen.findByText(/Artifact saved/)).toBeInTheDocument();
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledTimes(2);
  });
});

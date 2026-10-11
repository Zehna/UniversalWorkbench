import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AgentTraceItem } from "@uw/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentTraceViewer } from "../src/executions/AgentTraceViewer";
import { AgentStepEditor } from "../src/workflows/AgentStepEditor";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function nestedTrace(): AgentTraceItem[] {
  return [
    {
      iteration: 1,
      thought: "Supervisor delegating to researcher.",
      toolCall: {
        id: "call_delegate",
        name: "agent.delegate",
        arguments: { subAgentId: "researcher", task: "summarize topic X" },
      },
      observation: {
        toolCallId: "call_delegate",
        output: { summary: "done" },
        durationMs: 42,
        isError: false,
      },
      nestedTrace: {
        subAgentId: "researcher",
        role: "researcher",
        status: "completed",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        trace: [
          {
            iteration: 1,
            thought: "Child thought from researcher.",
            toolCall: {
              id: "child_call_1",
              name: "builtin.http.request",
              arguments: { url: "https://example.org/child" },
            },
            observation: {
              toolCallId: "child_call_1",
              output: { status: 200 },
              durationMs: 20,
              isError: false,
            },
          },
        ],
      },
    },
  ];
}

describe("AgentTraceViewer nested sub-agent timeline", () => {
  it("renders a collapsible sub-agent box with identity, status and usage", () => {
    render(<AgentTraceViewer trace={nestedTrace()} status="completed" />);
    expect(
      screen.getByRole("region", { name: /sub-agent researcher/i }),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/researcher/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/completed/).length).toBeGreaterThan(0);
    expect(screen.getByText(/15 tokens/)).toBeInTheDocument();
  });

  it("toggles expand/collapse of the child timeline", () => {
    render(<AgentTraceViewer trace={nestedTrace()} status="completed" />);
    const toggle = screen.getByRole("button", {
      name: /sub-agent researcher details/i,
    });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    // Child timeline hidden until expanded.
    expect(
      screen.queryByText("Child thought from researcher."),
    ).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByText("Child thought from researcher."),
    ).toBeInTheDocument();
    expect(screen.getByText("builtin.http.request")).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByText("Child thought from researcher."),
    ).not.toBeInTheDocument();
  });
});

describe("AgentTraceViewer sub-agent approval lineage", () => {
  it("displays the sub-agent lineage badge when awaiting approval", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({}) }) as Response),
    );
    const trace: AgentTraceItem[] = [
      {
        iteration: 1,
        thought: "Supervisor waiting on gated tool.",
      },
    ];
    render(
      <AgentTraceViewer
        trace={trace}
        status="awaiting_approval"
        projectId="proj-1"
        executionId="exec-1"
      />,
    );
    // Inject approval_needed via initial pendingApprovals prop path is not
    // available, so re-render through SSE is covered below. Here we assert the
    // static awaiting_approval card exists; lineage badge asserted in SSE test.
    expect(screen.getByText(/awaiting approval/i)).toBeInTheDocument();
  });

  it("shows lineage badge for sub-agent requested approvals via SSE", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({}) }) as Response),
    );
    class MockEventSource {
      static instances: MockEventSource[] = [];
      listeners: Record<string, Array<(e: MessageEvent) => void>> = {};
      onmessage: ((e: MessageEvent) => void) | null = null;
      close = vi.fn();
      constructor(public url: string) {
        MockEventSource.instances.push(this);
      }
      addEventListener(type: string, cb: (e: MessageEvent) => void) {
        this.listeners[type] = [...(this.listeners[type] ?? []), cb];
      }
      removeEventListener() {}
      emit(data: unknown) {
        const event = { data: JSON.stringify(data) } as MessageEvent;
        if (this.onmessage) this.onmessage(event);
        for (const cb of this.listeners["message"] ?? []) cb(event);
      }
    }
    MockEventSource.instances = [];
    vi.stubGlobal("EventSource", MockEventSource);
    render(
      <AgentTraceViewer
        trace={[]}
        status="running"
        projectId="proj-1"
        executionId="exec-1"
      />,
    );
    const source = MockEventSource.instances[0]!;
    source.emit({
      type: "approval_needed",
      pendingApprovals: [
        {
          tool: "builtin.http.request@1.0.0",
          toolCallId: "child_call_9",
          arguments: { url: "https://example.org/risky" },
          subAgentId: "researcher",
          role: "researcher",
        },
      ],
    });
    const badge = await screen.findByTestId("sub-agent-lineage");
    expect(badge).toHaveTextContent(/researcher/);
  });
});

describe("AgentStepEditor sub-agent squad", () => {
  const tools = [
    {
      id: "builtin.text.trim",
      name: "Text Trim",
      version: "1.0.0",
      description: "trim",
      accepts: ["text"] as Array<
        | "text"
        | "markdown"
        | "json"
        | "api_response"
        | "artifact_ref"
        | "ai_response"
        | "agent_response"
      >,
      produces: ["text"] as Array<
        | "text"
        | "markdown"
        | "json"
        | "api_response"
        | "artifact_ref"
        | "ai_response"
        | "agent_response"
      >,
      permissions: [] as string[],
      capabilities: [] as string[],
      executionMode: "server" as const,
      idempotency: "safe" as const,
      configSchema: { type: "object" },
      requiresApproval: false,
    },
  ];

  it("renders squad configuration inputs for each sub-agent", () => {
    const onChange = vi.fn();
    render(
      <AgentStepEditor
        config={{
          subAgents: [
            {
              id: "researcher",
              role: "researcher",
              instructions: "Research the topic.",
              allowedTools: [],
              maxIterations: 5,
            },
          ],
        }}
        updateConfig={onChange}
        availableTools={[...tools]}
      />,
    );
    expect(screen.getByText(/sub-agent squad/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/sub-agent 1 id/i)).toHaveDisplayValue(
      "researcher",
    );
    expect(screen.getByLabelText(/sub-agent 1 role/i)).toHaveDisplayValue(
      "researcher",
    );
    expect(
      screen.getByLabelText(/sub-agent 1 instructions/i),
    ).toHaveDisplayValue("Research the topic.");
    expect(
      screen.getByLabelText(/sub-agent 1 max iterations/i),
    ).toHaveDisplayValue("5");
  });

  it("adds a sub-agent and attaches it to config.subAgents", () => {
    const onChange = vi.fn();
    render(
      <AgentStepEditor
        config={{ subAgents: [] }}
        updateConfig={onChange}
        availableTools={[...tools]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /add sub-agent/i }));
    expect(onChange).toHaveBeenCalled();
    const patch = onChange.mock.calls[0]![0] as {
      subAgents: Array<Record<string, unknown>>;
    };
    expect(Array.isArray(patch.subAgents)).toBe(true);
    expect(patch.subAgents).toHaveLength(1);
  });

  it("edits sub-agent fields and validates required values", () => {
    const onChange = vi.fn();
    render(
      <AgentStepEditor
        config={{
          subAgents: [
            {
              id: "",
              role: "",
              instructions: "",
              allowedTools: [],
              maxIterations: 5,
            },
          ],
        }}
        updateConfig={onChange}
        availableTools={[...tools]}
      />,
    );
    expect(screen.getAllByRole("alert").length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText(/sub-agent 1 id/i), {
      target: { value: "researcher" },
    });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        subAgents: expect.arrayContaining([
          expect.objectContaining({ id: "researcher" }),
        ]),
      }),
    );
    fireEvent.change(screen.getByLabelText(/sub-agent 1 role/i), {
      target: { value: "researcher" },
    });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        subAgents: expect.arrayContaining([
          expect.objectContaining({ role: "researcher" }),
        ]),
      }),
    );
  });

  it("toggles allowedTools for a sub-agent via multi-select", () => {
    const onChange = vi.fn();
    render(
      <AgentStepEditor
        config={{
          subAgents: [
            {
              id: "researcher",
              role: "researcher",
              instructions: "Research.",
              allowedTools: [],
              maxIterations: 5,
            },
          ],
        }}
        updateConfig={onChange}
        availableTools={[...tools]}
      />,
    );
    const checkbox = screen.getByRole("checkbox", {
      name: /sub-agent 1.*text trim/i,
    });
    fireEvent.click(checkbox);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        subAgents: expect.arrayContaining([
          expect.objectContaining({
            allowedTools: ["builtin.text.trim@1.0.0"],
          }),
        ]),
      }),
    );
  });
});

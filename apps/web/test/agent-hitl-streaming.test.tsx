import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalCard } from "../src/executions/ApprovalCard";
import { AgentTraceViewer } from "../src/executions/AgentTraceViewer";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ApprovalCard", () => {
  const pending = [
    {
      tool: "builtin.approval.gated@1.0.0",
      toolCallId: "call_1",
      arguments: { url: "https://example.org/risky", method: "POST" },
      reason: "needs human review",
    },
  ];

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({}) }) as Response),
    );
  });

  it("renders pending tool parameters", () => {
    render(
      <ApprovalCard projectId="proj-1" executionId="exec-1" pendingApprovals={pending} />,
    );
    expect(screen.getByText(/awaiting approval/i)).toBeInTheDocument();
    expect(screen.getByText(/builtin\.approval\.gated/)).toBeInTheDocument();
    expect(screen.getByText(/https:\/\/example\.org\/risky/)).toBeInTheDocument();
  });

  it("triggers approve API call", async () => {
    render(
      <ApprovalCard projectId="proj-1" executionId="exec-1" pendingApprovals={pending} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /approve/i }));
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(1);
    });
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/api/projects/proj-1/executions/exec-1/approve");
    expect(init.method).toBe("POST");
  });

  it("passes rejection reason in reject request body", async () => {
    render(
      <ApprovalCard projectId="proj-1" executionId="exec-1" pendingApprovals={pending} />,
    );
    fireEvent.change(screen.getByLabelText(/rejection reason/i), {
      target: { value: "too risky" },
    });
    fireEvent.click(screen.getByRole("button", { name: /reject/i }));
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(1);
    });
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/api/projects/proj-1/executions/exec-1/reject");
    expect(init.method).toBe("POST");
    expect(init.body).toContain("too risky");
  });
});

describe("AgentTraceViewer streaming", () => {
  class MockEventSource {
    static instances: MockEventSource[] = [];
    url: string;
    listeners: Record<string, Array<(e: MessageEvent) => void>> = {};
    onmessage: ((e: MessageEvent) => void) | null = null;
    close = vi.fn();
    constructor(url: string) {
      this.url = url;
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

  beforeEach(() => {
    MockEventSource.instances = [];
    vi.stubGlobal("EventSource", MockEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({}) }) as Response),
    );
  });

  it("processes mock SSE stream events and updates the timeline dynamically", async () => {
    render(
      <AgentTraceViewer
        trace={[]}
        status="running"
        projectId="proj-1"
        executionId="exec-1"
      />,
    );
    expect(screen.getByText(/no reasoning steps/i)).toBeInTheDocument();
    const source = MockEventSource.instances[0]!;
    expect(source.url).toBe("/api/projects/proj-1/executions/exec-1/events");

    source.emit({
      type: "thought",
      iteration: 1,
      thought: "streamed thought arrives",
    });

    await waitFor(() => {
      expect(screen.getByText("streamed thought arrives")).toBeInTheDocument();
    });

    source.emit({
      type: "tool_call",
      iteration: 1,
      toolCall: {
        id: "call_1",
        name: "builtin.http.request",
        arguments: { url: "https://example.org/streamed" },
      },
    });

    await waitFor(() => {
      expect(screen.getByText("builtin.http.request")).toBeInTheDocument();
    });
  });

  it("embeds ApprovalCard when awaiting_approval event is detected", async () => {
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
          tool: "builtin.approval.gated@1.0.0",
          toolCallId: "call_9",
          arguments: { action: "delete" },
        },
      ],
    });

    await waitFor(() => {
      expect(screen.getByText(/awaiting approval/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/builtin\.approval\.gated/)).toBeInTheDocument();
    expect(screen.getByText(/delete/)).toBeInTheDocument();
  });

  it("closes SSE stream cleanly upon completion", async () => {
    const { unmount } = render(
      <AgentTraceViewer
        trace={[]}
        status="running"
        projectId="proj-1"
        executionId="exec-1"
      />,
    );
    const source = MockEventSource.instances[0]!;
    source.emit({ type: "completed", status: "completed" });
    await waitFor(() => {
      expect(source.close).toHaveBeenCalled();
    });
    unmount();
  });
});

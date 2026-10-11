import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AgentResponsePayload } from "@uw/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentTraceViewer } from "../src/executions/AgentTraceViewer";
import { AgentStepEditor } from "../src/workflows/AgentStepEditor";

function payload(
  overrides: Partial<AgentResponsePayload> = {},
): AgentResponsePayload {
  return {
    text: "Final answer: 42",
    model: "gpt-4o-mini",
    status: "completed",
    iterations: 2,
    trace: [
      {
        iteration: 1,
        thought: "I should fetch the data first.",
        toolCall: {
          id: "call_1",
          name: "builtin.http.request",
          arguments: { url: "https://example.org/api" },
        },
        observation: {
          toolCallId: "call_1",
          output: { status: 200, data: "ok" },
          durationMs: 150,
          isError: false,
        },
      },
      {
        iteration: 2,
        thought: "I now have everything needed.",
      },
    ],
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    usageSource: "provider",
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AgentTraceViewer", () => {
  it("renders trace timeline with thoughts, tool calls, and observations", () => {
    const data = payload();
    render(
      <AgentTraceViewer
        trace={data.trace}
        status={data.status}
        usage={data.usage}
        usageSource={data.usageSource}
        model={data.model}
        iterations={data.iterations}
        text={data.text}
      />,
    );
    expect(
      screen.getByText("I should fetch the data first."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("I now have everything needed."),
    ).toBeInTheDocument();
    expect(screen.getByText("builtin.http.request")).toBeInTheDocument();
    expect(screen.getByText(/https:\/\/example\.org\/api/)).toBeInTheDocument();
    expect(screen.getByText("Duration: 150ms")).toBeInTheDocument();
    expect(screen.getByText(/Final answer: 42/)).toBeInTheDocument();
  });

  it("toggles expandable tool-call and observation details", () => {
    const data = payload();
    render(
      <AgentTraceViewer
        trace={data.trace}
        status={data.status}
        usage={data.usage}
        usageSource={data.usageSource}
      />,
    );
    const toggle = screen.getByRole("button", { name: /iteration 1 details/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    // Arguments remain visible after expanding; toggle collapses again.
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("shows execution status badge for completed and iteration_limit_reached", () => {
    const completed = payload({ status: "completed" });
    const { unmount } = render(
      <AgentTraceViewer trace={completed.trace} status={completed.status} />,
    );
    expect(screen.getByTestId("agent-status")).toHaveTextContent(/completed/i);
    unmount();

    const limited = payload({ status: "iteration_limit_reached" });
    render(<AgentTraceViewer trace={limited.trace} status={limited.status} />);
    expect(screen.getByTestId("agent-status")).toHaveTextContent(
      /iteration_limit_reached/i,
    );
  });

  it("shows token usage summary", () => {
    const data = payload();
    render(
      <AgentTraceViewer
        trace={data.trace}
        status={data.status}
        usage={data.usage}
        usageSource={data.usageSource}
      />,
    );
    expect(screen.getByTestId("agent-usage")).toHaveTextContent(/150 tokens/);
  });
});

describe("AgentStepEditor", () => {
  it("renders provider, model, prompt, secret, iterations and allowedTools fields", () => {
    const onChange = vi.fn();
    render(
      <AgentStepEditor
        config={{}}
        updateConfig={onChange}
        availableTools={[
          {
            id: "builtin.text.trim",
            name: "Text Trim",
            version: "1.0.0",
            description: "trim",
            accepts: ["text"],
            produces: ["text"],
            permissions: [],
            capabilities: [],
            executionMode: "server",
            idempotency: "safe",
            configSchema: { type: "object" },
            requiresApproval: false,
          },
        ]}
      />,
    );
    expect(screen.getByLabelText(/AI provider/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/AI model/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/AI prompt/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Secret reference/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Max iterations/i)).toBeInTheDocument();
    expect(screen.getByText(/Allowed tools/i)).toBeInTheDocument();
  });

  it("emits config patches for form interactions", () => {
    const onChange = vi.fn();
    render(
      <AgentStepEditor
        config={{}}
        updateConfig={onChange}
        availableTools={[]}
      />,
    );
    fireEvent.change(screen.getByLabelText(/AI provider/i), {
      target: { value: "http" },
    });
    expect(onChange).toHaveBeenCalledWith({ providerId: "http" });
    fireEvent.change(screen.getByLabelText(/AI model/i), {
      target: { value: "e2e-model" },
    });
    expect(onChange).toHaveBeenCalledWith({ model: "e2e-model" });
    fireEvent.change(screen.getByLabelText(/Max iterations/i), {
      target: { value: "7" },
    });
    expect(onChange).toHaveBeenCalledWith({ maxIterations: 7 });
  });

  it("clamps maxIterations to 1-15 and defaults to 5", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <AgentStepEditor
        config={{}}
        updateConfig={onChange}
        availableTools={[]}
      />,
    );
    // Default display is 5 when unset.
    expect(screen.getByLabelText(/Max iterations/i)).toHaveDisplayValue("5");
    fireEvent.change(screen.getByLabelText(/Max iterations/i), {
      target: { value: "99" },
    });
    expect(onChange).toHaveBeenCalledWith({ maxIterations: 15 });
    fireEvent.change(screen.getByLabelText(/Max iterations/i), {
      target: { value: "0" },
    });
    expect(onChange).toHaveBeenCalledWith({ maxIterations: 1 });

    rerender(
      <AgentStepEditor
        config={{ maxIterations: 99 }}
        updateConfig={onChange}
        availableTools={[]}
      />,
    );
    expect(screen.getByText(/between 1 and 15/i)).toBeInTheDocument();
  });

  it("toggles allowedTools selection", () => {
    const onChange = vi.fn();
    render(
      <AgentStepEditor
        config={{ allowedTools: [] }}
        updateConfig={onChange}
        availableTools={[
          {
            id: "builtin.text.trim",
            name: "Text Trim",
            version: "1.0.0",
            description: "trim",
            accepts: ["text"],
            produces: ["text"],
            permissions: [],
            capabilities: [],
            executionMode: "server",
            idempotency: "safe",
            configSchema: { type: "object" },
            requiresApproval: false,
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: /Text Trim/i }));
    expect(onChange).toHaveBeenCalledWith({
      allowedTools: ["builtin.text.trim@1.0.0"],
    });
  });
});

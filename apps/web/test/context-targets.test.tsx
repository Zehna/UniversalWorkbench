import { render, screen } from "@testing-library/react";
import type { ToolDefinition } from "@uw/contracts";
import { describe, expect, it, vi } from "vitest";
import type { WorkflowApiClient } from "../src/workflows/api";
import { CompatibleTargets } from "../src/context/CompatibleTargets";

const NOTE_TOOL: ToolDefinition = {
  id: "builtin.note.write",
  version: "1",
  displayName: "Write Note",
  description: "Write note",
  executionMode: "worker",
  accepts: [{ name: "input", types: ["text", "markdown"], required: true }],
  produces: [{ name: "note", types: ["note-ref"] }],
  configSchema: {},
  requiredCapabilities: ["project.documents.write"],
  defaults: { timeoutMs: 5_000, maxAttempts: 1 },
};

describe("CompatibleTargets", () => {
  it("uses the shared compatibility endpoint instead of a screen-specific list", async () => {
    const compatibleTargets = vi.fn().mockResolvedValue([
      {
        definition: NOTE_TOOL,
        inputPort: NOTE_TOOL.accepts[0]!,
      },
    ]);
    const api = {
      listTools: vi.fn(),
      compatibleTargets,
      validateWorkflow: vi.fn(),
      runWorkflow: vi.fn(),
      getExecution: vi.fn(),
      getReceipt: vi.fn(),
    } satisfies WorkflowApiClient;

    render(<CompatibleTargets type="text" api={api} />);

    expect(await screen.findByText("Write Note")).toBeInTheDocument();
    expect(compatibleTargets).toHaveBeenCalledWith("text");
    expect(screen.queryByText("JSON Select")).not.toBeInTheDocument();
  });
});

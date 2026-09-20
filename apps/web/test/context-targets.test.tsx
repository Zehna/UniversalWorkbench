import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@uw/contracts";
import { CompatibleTargets } from "../src/context/CompatibleTargets";
import type { WorkflowApiClient } from "../src/workflows/types";

const noteTool: ToolDefinition = {
  id: "builtin.note.write",
  version: "1",
  displayName: "Write Note",
  description: "Write a note",
  executionMode: "worker",
  accepts: [{ name: "input", types: ["text", "markdown"], required: true }],
  produces: [{ name: "note", types: ["note-ref"] }],
  configSchema: {},
  requiredCapabilities: ["project.documents.write"],
  defaults: { timeoutMs: 5000, maxAttempts: 1 },
};

describe("CompatibleTargets", () => {
  it("shows compatible typed targets and reports selection", async () => {
    const onSelect = vi.fn();
    const client = {
      compatibleTargets: vi.fn().mockResolvedValue([
        {
          definition: noteTool,
          inputPort: noteTool.accepts[0]!,
        },
      ]),
    } as unknown as WorkflowApiClient;

    render(
      <CompatibleTargets
        contextType="text"
        client={client}
        onSelect={onSelect}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: /write note/i }),
    );
    expect(client.compatibleTargets).toHaveBeenCalledWith("text");
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        definition: expect.objectContaining({ id: "builtin.note.write" }),
      }),
    );
  });
});

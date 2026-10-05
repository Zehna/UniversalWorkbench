import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ContextEnvelope, ToolDescriptor } from "@uw/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/client";
import { ExecutionStatus } from "../src/executions/ExecutionStatus";
import { RunWorkflow } from "../src/executions/RunWorkflow";
import type { WorkflowVersion } from "../src/api/client";
import {
  formatTokenUsage,
  sendToCandidates,
} from "../src/send-to/send-to";
import { SendToMenu } from "../src/send-to/SendToMenu";
import { isLocalSecretRef, validateAiToolConfig } from "../src/tools/ai-config";
import { WorkflowStepEditor } from "../src/workflows/WorkflowStepEditor";

const PROJECT = "22222222-2222-4222-8222-222222222222";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function tool(
  id: string,
  accepts: ToolDescriptor["accepts"],
  produces: ToolDescriptor["produces"],
  permissions: string[] = [],
  name = id,
): ToolDescriptor {
  return {
    id,
    name,
    version: "1.0.0",
    description: id,
    accepts,
    produces,
    permissions,
    capabilities: [],
    executionMode: "server",
    idempotency: "safe",
    configSchema: { type: "object" },
  };
}

const AI_TOOL = tool(
  "builtin.ai.complete",
  ["text", "markdown", "json"],
  ["ai_response"],
  ["ai"],
  "AI Complete",
);
const TRIM_TOOL = tool("builtin.text.trim", ["text"], ["text"]);
const CATALOG = [AI_TOOL, TRIM_TOOL];

function aiOutput(usageSource: "provider" | "estimated" = "provider"): ContextEnvelope {
  return {
    id: "66666666-6666-4666-8666-666666666666",
    type: "ai_response",
    schemaVersion: 1,
    mimeType: "application/json",
    metadata: {},
    payload: {
      text: "mock answer",
      model: "mock-model",
      usage: { promptTokens: 4, completionTokens: 5, totalTokens: 9 },
      usageSource,
    },
    provenance: { sourceContextIds: [] },
    capabilities: [],
  };
}

describe("universal send-to candidates", () => {
  it("lists AI, note, and artifact destinations for text with the ai grant", () => {
    const candidates = sendToCandidates("text", CATALOG, ["ai"]);
    const labels = candidates.map((item) => item.label);
    expect(labels).toContain("Send to AI Complete");
    expect(labels).toContain("Save as Note");
    expect(labels).toContain("Save as Artifact");
  });

  it("lists note and artifact for ai_response (no tool accepts it yet)", () => {
    const candidates = sendToCandidates("ai_response", CATALOG, ["ai"]);
    const labels = candidates.map((item) => item.label);
    expect(labels).not.toContain("Send to AI Complete");
    expect(labels).toContain("Save as Note");
    expect(labels).toContain("Save as Artifact");
  });

  it("excludes the AI tool without the ai grant but keeps note and artifact", () => {
    const candidates = sendToCandidates("ai_response", CATALOG, []);
    const labels = candidates.map((item) => item.label);
    expect(labels).not.toContain("Send to AI Complete");
    expect(labels).toContain("Save as Note");
    expect(labels).toContain("Save as Artifact");
  });

  it("formats token totals with an estimated marker", () => {
    expect(
      formatTokenUsage(
        { promptTokens: 4, completionTokens: 5, totalTokens: 9 },
        "provider",
      ),
    ).toBe("9 tokens");
    expect(
      formatTokenUsage(
        { promptTokens: 4, completionTokens: 5, totalTokens: 9 },
        "estimated",
      ),
    ).toBe("~9 tokens (estimated)");
  });
});

describe("send-to menu", () => {
  it("renders candidates and saves a note through the API", async () => {
    const saveNote = vi
      .spyOn(api, "saveNoteFromExecution")
      .mockResolvedValue({ document: { id: "note-1" } } as never);
    render(
      <SendToMenu
        output={aiOutput()}
        projectId={PROJECT}
        executionId="exec-1"
        outputId={aiOutput().id}
        tools={CATALOG}
        grantedPermissions={["ai"]}
      />,
    );
    expect(screen.getByRole("button", { name: /save as note/i })).toBeVisible();
    expect(
      screen.getByRole("button", { name: /save as artifact/i }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /save as note/i }));
    await waitFor(() =>
      expect(saveNote).toHaveBeenCalledWith(PROJECT, "exec-1", aiOutput().id),
    );
    expect(await screen.findByText(/note saved/i)).toBeVisible();
  });
});

describe("AI step configuration", () => {
  it("rejects bad secret refs and invalid JSON schemas", () => {
    expect(
      validateAiToolConfig({
        providerId: "mock",
        model: "m",
        prompt: "p",
        secretRef: "https://evil.example/k",
      }),
    ).not.toHaveLength(0);
    expect(
      validateAiToolConfig({
        providerId: "mock",
        model: "m",
        prompt: "p",
        secretRef: "secret://vault/openai",
        responseFormat: { kind: "json", jsonSchema: "{oops" },
      }),
    ).not.toHaveLength(0);
    expect(
      validateAiToolConfig({
        providerId: "mock",
        model: "m",
        prompt: "p",
        secretRef: "secret://vault/openai",
      }),
    ).toHaveLength(0);
    expect(isLocalSecretRef("secret://local/k")).toBe(true);
    expect(isLocalSecretRef("secret://vault/k")).toBe(false);
  });

  it("warns that local secrets stay on this device", () => {
    const node = {
      id: "n1",
      toolId: "builtin.ai.complete",
      toolVersion: "1.0.0",
      config: {
        providerId: "mock",
        model: "m",
        prompt: "p",
        secretRef: "secret://local/device",
      },
      input: { source: "workflow_input" as const },
    };
    render(
      <WorkflowStepEditor
        node={node}
        descriptor={AI_TOOL}
        index={0}
        sourceLabel="Workflow input"
        canMoveUp={false}
        canMoveDown={false}
        onChange={() => undefined}
        onMoveUp={() => undefined}
        onMoveDown={() => undefined}
        onRemove={() => undefined}
      />,
    );
    expect(screen.getByText(/stays on this device/i)).toBeVisible();
  });
});

describe("AI run preflight and usage display", () => {
  function aiWorkflow(secretRef: string): WorkflowVersion {
    return {
      id: "w1",
      workflowId: "wf1",
      version: 1,
      ownerId: "o1",
      projectId: PROJECT,
      createdAt: new Date().toISOString(),
      definition: {
        id: "wf1",
        projectId: PROJECT,
        name: "AI flow",
        schemaVersion: 1,
        nodes: [
          {
            id: "n1",
            toolId: "builtin.ai.complete",
            toolVersion: "1.0.0",
            config: {
              providerId: "mock",
              model: "mock-model",
              prompt: "Summarize:",
              secretRef,
            },
            input: { source: "workflow_input" },
          },
        ],
        edges: [],
      },
    };
  }

  it("flags server-unresolvable local secrets before enqueue", () => {
    render(
      <RunWorkflow
        projectId={PROJECT}
        workflow={aiWorkflow("secret://local/device")}
        tools={CATALOG}
        grantedPermissions={["ai"]}
        onBack={() => undefined}
      />,
    );
    expect(screen.getByText(/server-unresolvable/i)).toBeVisible();
    expect(
      screen.getByRole("button", { name: /run workflow/i }),
    ).toBeDisabled();
  });

  it("shows the ai permission, model, and token budget", () => {
    render(
      <RunWorkflow
        projectId={PROJECT}
        workflow={aiWorkflow("secret://vault/openai")}
        tools={CATALOG}
        grantedPermissions={["ai"]}
        onBack={() => undefined}
      />,
    );
    expect(screen.getByText("AI: Required")).toBeVisible();
    expect(screen.getByText("AI models: mock-model")).toBeVisible();
    expect(screen.getByText(/token budget/i)).toBeVisible();
  });

  it("shows per-step and total token usage with the estimated marker", async () => {
    const output = aiOutput("estimated");
    vi.spyOn(api, "getExecution").mockResolvedValue({
      execution: {
        id: "exec-1",
        status: "completed",
        projectId: PROJECT,
        traceId: "t",
        error: null,
        usage: { promptTokens: 4, completionTokens: 5, totalTokens: 9 },
        startedAt: null,
        finishedAt: null,
      },
      steps: [
        {
          nodeId: "n1",
          toolId: "builtin.ai.complete",
          toolVersion: "1.0.0",
          attempt: 1,
          status: "completed",
          outputContexts: [output],
          error: null,
        },
      ],
      receipt: null,
    });
    render(
      <ExecutionStatus
        projectId={PROJECT}
        executionId="exec-1"
        onBack={() => undefined}
      />,
    );
    expect(await screen.findByText(/total:/i)).toBeVisible();
    const estimated = await screen.findAllByText(/~9 tokens \(estimated\)/i);
    // Total line plus the per-step line both carry the estimated marker.
    expect(estimated).toHaveLength(2);
    expect(
      await screen.findByRole("button", { name: /save as note/i }),
    ).toBeVisible();
  });
});

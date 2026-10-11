import { useState } from "react";
import type { ToolDescriptor } from "@uw/contracts";
import { isLocalSecretRef, isSecretRef } from "../tools/ai-config";

interface AgentStepEditorProps {
  config: Record<string, unknown>;
  updateConfig(patch: Record<string, unknown>): void;
  availableTools?: ToolDescriptor[];
}

function toAllowedTools(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function toolKey(tool: ToolDescriptor): string {
  return `${tool.id}@${tool.version}`;
}

export function AgentStepEditor({
  config,
  updateConfig,
  availableTools = [],
}: AgentStepEditorProps) {
  const allowedTools = toAllowedTools(config.allowedTools);
  const maxIterationsRaw = config.maxIterations;
  const maxIterations =
    typeof maxIterationsRaw === "number" && Number.isInteger(maxIterationsRaw)
      ? maxIterationsRaw
      : 5;
  const outOfRange =
    typeof maxIterationsRaw === "number" &&
    (!Number.isInteger(maxIterationsRaw) ||
      maxIterationsRaw < 1 ||
      maxIterationsRaw > 15);
  const secretRef =
    typeof config.secretRef === "string" ? config.secretRef : "";
  const [customTool, setCustomTool] = useState("");

  function clampIterations(value: number): number {
    if (!Number.isFinite(value)) return 5;
    return Math.min(15, Math.max(1, Math.trunc(value)));
  }

  function toggleTool(key: string) {
    const next = allowedTools.includes(key)
      ? allowedTools.filter((item) => item !== key)
      : [...allowedTools, key];
    updateConfig({ allowedTools: next });
  }

  function addCustomTool() {
    const trimmed = customTool.trim();
    if (!trimmed || allowedTools.includes(trimmed)) return;
    updateConfig({ allowedTools: [...allowedTools, trimmed] });
    setCustomTool("");
  }

  return (
    <div aria-label="Agent step editor">
      <label>
        AI provider
        <input
          aria-label="AI provider"
          value={String(config.providerId ?? "mock")}
          onChange={(event) => updateConfig({ providerId: event.target.value })}
          placeholder="mock"
          list="agent-provider-options"
        />
        <datalist id="agent-provider-options">
          <option value="mock" />
          <option value="http" />
        </datalist>
      </label>
      <label>
        AI model
        <input
          aria-label="AI model"
          value={String(config.model ?? "")}
          onChange={(event) => updateConfig({ model: event.target.value })}
          placeholder="e2e-model"
        />
      </label>
      <label>
        AI prompt
        <textarea
          aria-label="AI prompt"
          rows={3}
          value={String(config.prompt ?? "")}
          onChange={(event) => updateConfig({ prompt: event.target.value })}
          placeholder="Goal for the ReAct agent:"
        />
      </label>
      <label>
        System prompt (optional)
        <textarea
          aria-label="System prompt"
          rows={2}
          value={String(config.systemPrompt ?? "")}
          onChange={(event) =>
            updateConfig({ systemPrompt: event.target.value || undefined })
          }
        />
      </label>
      <label>
        Secret reference
        <input
          aria-label="Secret reference"
          value={secretRef}
          onChange={(event) => updateConfig({ secretRef: event.target.value })}
          placeholder="secret://vault/openai"
        />
      </label>
      {secretRef && !isSecretRef(secretRef) ? (
        <p role="alert">
          Enter a secret reference like secret://vault/openai or
          secret://local/key.
        </p>
      ) : null}
      {isLocalSecretRef(secretRef) ? (
        <p role="alert">
          secret://local/* stays on this device; server runs will fail. Use a
          vault secret for server execution.
        </p>
      ) : null}
      <label>
        Max iterations
        <input
          aria-label="Max iterations"
          type="number"
          min={1}
          max={15}
          step={1}
          value={maxIterations}
          onChange={(event) =>
            updateConfig({
              maxIterations: clampIterations(Number(event.target.value)),
            })
          }
        />
      </label>
      {outOfRange ? (
        <p role="alert">Max iterations must be between 1 and 15.</p>
      ) : null}
      <fieldset>
        <legend>Allowed tools</legend>
        <p>Only whitelisted tools can be called by the agent loop.</p>
        {availableTools.length === 0 ? (
          <p>No tool catalog available; add tool IDs manually.</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0 }}>
            {availableTools.map((tool) => {
              const key = toolKey(tool);
              return (
                <li key={key}>
                  <label>
                    <input
                      type="checkbox"
                      checked={allowedTools.includes(key)}
                      onChange={() => toggleTool(key)}
                    />
                    {tool.name} ({key})
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <label>
            Add tool ID
            <input
              aria-label="Add tool ID"
              value={customTool}
              onChange={(event) => setCustomTool(event.target.value)}
              placeholder="builtin.text.trim@1.0.0"
            />
          </label>
          <button type="button" onClick={addCustomTool}>
            Add tool
          </button>
        </div>
        {allowedTools.length > 0 ? (
          <ul aria-label="Selected allowed tools">
            {allowedTools.map((toolId) => (
              <li key={toolId}>
                {toolId}{" "}
                <button
                  type="button"
                  aria-label={`Remove ${toolId}`}
                  onClick={() => toggleTool(toolId)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </fieldset>
    </div>
  );
}

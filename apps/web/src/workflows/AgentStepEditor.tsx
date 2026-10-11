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

interface SubAgentDraft {
  id: string;
  role: string;
  instructions: string;
  allowedTools: string[];
  maxIterations: number;
}

function toSubAgents(value: unknown): SubAgentDraft[] {
  if (!Array.isArray(value)) return [];
  const out: SubAgentDraft[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const maxRaw = record.maxIterations;
    out.push({
      id: typeof record.id === "string" ? record.id : "",
      role: typeof record.role === "string" ? record.role : "",
      instructions:
        typeof record.instructions === "string" ? record.instructions : "",
      allowedTools: toAllowedTools(record.allowedTools),
      maxIterations:
        typeof maxRaw === "number" && Number.isInteger(maxRaw) ? maxRaw : 5,
    });
  }
  return out;
}

function subAgentErrors(
  agent: SubAgentDraft,
  index: number,
  all: SubAgentDraft[],
): string[] {
  const errors: string[] = [];
  const id = agent.id.trim();
  if (!id) errors.push(`Sub-agent ${index + 1}: id is required.`);
  else if (id.length > 128)
    errors.push(`Sub-agent ${index + 1}: id must be at most 128 characters.`);
  else if (
    all.some(
      (other, otherIndex) => otherIndex !== index && other.id.trim() === id,
    )
  )
    errors.push(`Sub-agent ${index + 1}: id must be unique.`);
  if (!agent.role.trim())
    errors.push(`Sub-agent ${index + 1}: role is required.`);
  if (!agent.instructions.trim())
    errors.push(`Sub-agent ${index + 1}: instructions are required.`);
  if (
    !Number.isInteger(agent.maxIterations) ||
    agent.maxIterations < 1 ||
    agent.maxIterations > 15
  )
    errors.push(`Sub-agent ${index + 1}: max iterations must be 1-15.`);
  return errors;
}

function isMcpTool(tool: ToolDescriptor): boolean {
  return tool.id.startsWith("mcp.");
}

function renderToolItem(
  tool: ToolDescriptor,
  allowedTools: string[],
  toggleTool: (key: string) => void,
) {
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
  const subAgents = toSubAgents(config.subAgents);

  function updateSubAgent(index: number, patch: Partial<SubAgentDraft>): void {
    const next = subAgents.map((agent, current) =>
      current === index ? { ...agent, ...patch } : agent,
    );
    updateConfig({ subAgents: next });
  }

  function addSubAgent(): void {
    const next: SubAgentDraft[] = [
      ...subAgents,
      {
        id: "",
        role: "",
        instructions: "",
        allowedTools: [],
        maxIterations: 5,
      },
    ];
    updateConfig({ subAgents: next });
  }

  function removeSubAgent(index: number): void {
    const next = subAgents.filter((_, current) => current !== index);
    updateConfig({ subAgents: next });
  }

  function toggleSubAgentTool(index: number, key: string): void {
    const agent = subAgents[index];
    if (!agent) return;
    const current = agent.allowedTools;
    const nextTools = current.includes(key)
      ? current.filter((item) => item !== key)
      : [...current, key];
    updateSubAgent(index, { allowedTools: nextTools });
  }

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
          <>
            <ul style={{ listStyle: "none", padding: 0 }}>
              {availableTools
                .filter((tool) => !isMcpTool(tool))
                .map((tool) => renderToolItem(tool, allowedTools, toggleTool))}
            </ul>
            {availableTools.some((tool) => isMcpTool(tool)) ? (
              <>
                <h4>
                  MCP tools (
                  {availableTools.filter((tool) => isMcpTool(tool)).length}{" "}
                  discovered)
                </h4>
                <p>Discovered MCP tools can be assigned to this ReAct agent.</p>
                <ul
                  aria-label="Discovered MCP tools"
                  style={{ listStyle: "none", padding: 0 }}
                >
                  {availableTools
                    .filter((tool) => isMcpTool(tool))
                    .map((tool) =>
                      renderToolItem(tool, allowedTools, toggleTool),
                    )}
                </ul>
              </>
            ) : null}
          </>
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
      <fieldset aria-label="Sub-Agent Squad">
        <legend>Sub-Agent Squad</legend>
        <p>
          Define specialist sub-agents supervised by this agent. Each sub-agent
          gets its own role, instructions, tools, and iteration budget.
        </p>
        {subAgents.length === 0 ? (
          <p>No sub-agents configured.</p>
        ) : (
          <ol style={{ listStyle: "none", padding: 0 }}>
            {subAgents.map((agent, index) => {
              const errors = subAgentErrors(agent, index, subAgents);
              return (
                <li
                  key={`sub-agent-${index}`}
                  aria-label={`Sub-agent ${index + 1}`}
                >
                  <h4>Sub-agent {index + 1}</h4>
                  <label>
                    Sub-agent {index + 1} id
                    <input
                      aria-label={`Sub-agent ${index + 1} id`}
                      value={agent.id}
                      onChange={(event) =>
                        updateSubAgent(index, { id: event.target.value })
                      }
                      placeholder="researcher"
                    />
                  </label>
                  <label>
                    Sub-agent {index + 1} role
                    <input
                      aria-label={`Sub-agent ${index + 1} role`}
                      value={agent.role}
                      onChange={(event) =>
                        updateSubAgent(index, { role: event.target.value })
                      }
                      placeholder="researcher"
                    />
                  </label>
                  <label>
                    Sub-agent {index + 1} instructions
                    <textarea
                      aria-label={`Sub-agent ${index + 1} instructions`}
                      rows={2}
                      value={agent.instructions}
                      onChange={(event) =>
                        updateSubAgent(index, {
                          instructions: event.target.value,
                        })
                      }
                      placeholder="Specialist instructions:"
                    />
                  </label>
                  <label>
                    Sub-agent {index + 1} max iterations
                    <input
                      aria-label={`Sub-agent ${index + 1} max iterations`}
                      type="number"
                      min={1}
                      max={15}
                      step={1}
                      value={agent.maxIterations}
                      onChange={(event) =>
                        updateSubAgent(index, {
                          maxIterations: clampIterations(
                            Number(event.target.value),
                          ),
                        })
                      }
                    />
                  </label>
                  <fieldset>
                    <legend>Sub-agent {index + 1} allowed tools</legend>
                    {availableTools.length === 0 ? (
                      <p>No tool catalog available.</p>
                    ) : (
                      <ul style={{ listStyle: "none", padding: 0 }}>
                        {availableTools.map((tool) => {
                          const key = toolKey(tool);
                          return (
                            <li key={key}>
                              <label>
                                <input
                                  type="checkbox"
                                  aria-label={`Sub-agent ${index + 1} tool ${tool.name}`}
                                  checked={agent.allowedTools.includes(key)}
                                  onChange={() =>
                                    toggleSubAgentTool(index, key)
                                  }
                                />
                                Sub-agent {index + 1} {tool.name} ({key})
                              </label>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </fieldset>
                  {errors.map((message) => (
                    <p key={message} role="alert">
                      {message}
                    </p>
                  ))}
                  <button
                    type="button"
                    aria-label={`Remove sub-agent ${index + 1}`}
                    onClick={() => removeSubAgent(index)}
                  >
                    Remove sub-agent {index + 1}
                  </button>
                </li>
              );
            })}
          </ol>
        )}
        <button type="button" onClick={addSubAgent}>
          Add sub-agent
        </button>
      </fieldset>
    </div>
  );
}

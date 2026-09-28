import { useState } from "react";
import type { ToolDescriptor, WorkflowNode } from "@uw/contracts";

interface WorkflowStepEditorProps {
  node: WorkflowNode;
  descriptor: ToolDescriptor;
  index: number;
  sourceLabel: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onChange(node: WorkflowNode): void;
  onMoveUp(): void;
  onMoveDown(): void;
  onRemove(): void;
}

export function WorkflowStepEditor({
  node,
  descriptor,
  index,
  sourceLabel,
  canMoveUp,
  canMoveDown,
  onChange,
  onMoveUp,
  onMoveDown,
  onRemove,
}: WorkflowStepEditorProps) {
  const [rawConfig, setRawConfig] = useState(
    JSON.stringify(node.config ?? {}, null, 2),
  );
  const [configError, setConfigError] = useState("");
  const config = node.config as Record<string, unknown>;
  const update = (patch: Partial<WorkflowNode>) =>
    onChange({ ...node, ...patch });
  const updateConfig = (patch: Record<string, unknown>) =>
    update({ config: { ...config, ...patch } });

  return (
    <fieldset
      style={{
        border: "1px solid #555",
        borderRadius: 12,
        padding: 12,
        marginBottom: 12,
      }}
      aria-label={`Step ${index + 1}: ${descriptor.name}`}
    >
      <legend>
        <strong>
          {index + 1}. {descriptor.name}
        </strong>{" "}
        · v{descriptor.version}
      </legend>
      <p>{descriptor.description}</p>
      <p>
        Input: {sourceLabel} · Output: {descriptor.produces.join(", ")}
      </p>
      <p>Required permissions: {descriptor.permissions.join(", ") || "None"}</p>
      {descriptor.permissions.includes("network") ? (
        <p>Network access required. The server must approve this permission.</p>
      ) : null}
      {descriptor.id === "builtin.http.request" ? (
        <>
          <label>
            HTTP method
            <select
              value={String(config.method ?? "GET")}
              onChange={(event) => updateConfig({ method: event.target.value })}
            >
              {["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].map(
                (method) => (
                  <option key={method} value={method}>
                    {method}
                  </option>
                ),
              )}
            </select>
          </label>
          <label>
            Request URL
            <input
              type="url"
              value={String(config.url ?? "")}
              onChange={(event) => updateConfig({ url: event.target.value })}
              placeholder="https://example.org/api"
            />
          </label>
          {config.method !== "GET" && config.method !== "HEAD" ? (
            <label>
              Idempotency key
              <input
                value={node.idempotencyKey ?? ""}
                onChange={(event) => {
                  const updated = { ...node };
                  if (event.target.value) {
                    updated.idempotencyKey = event.target.value;
                  } else {
                    delete updated.idempotencyKey;
                  }
                  onChange(updated);
                }}
              />
            </label>
          ) : null}
        </>
      ) : descriptor.id === "builtin.json.extract" ? (
        <label>
          JSON path
          <input
            value={String(config.path ?? "")}
            onChange={(event) => updateConfig({ path: event.target.value })}
            placeholder="data.value"
          />
        </label>
      ) : descriptor.id === "builtin.text.trim" ||
        descriptor.id === "builtin.markdown.to-text" ? (
        <p>No configuration required.</p>
      ) : (
        <label>
          Tool configuration (JSON)
          <textarea
            rows={4}
            value={rawConfig}
            onChange={(event) => setRawConfig(event.target.value)}
            onBlur={() => {
              try {
                const parsed: unknown = JSON.parse(rawConfig);
                if (
                  typeof parsed !== "object" ||
                  parsed === null ||
                  Array.isArray(parsed)
                )
                  throw new Error("Configuration must be a JSON object");
                update({ config: parsed });
                setConfigError("");
              } catch {
                setConfigError("Enter a valid JSON object.");
              }
            }}
          />
          {configError ? <span role="alert">{configError}</span> : null}
        </label>
      )}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <label>
          Timeout (ms)
          <input
            type="number"
            min={1}
            max={600000}
            value={node.timeoutMs ?? 30000}
            onChange={(event) =>
              update({ timeoutMs: Math.max(1, Number(event.target.value)) })
            }
          />
        </label>
        <label>
          Max attempts
          <input
            type="number"
            min={1}
            max={5}
            value={node.retry?.maxAttempts ?? 1}
            onChange={(event) =>
              update({
                retry: {
                  maxAttempts: Math.max(1, Number(event.target.value)),
                  backoffMs: node.retry?.backoffMs ?? 250,
                },
              })
            }
          />
        </label>
        <label>
          Retry backoff (ms)
          <input
            type="number"
            min={0}
            max={60000}
            value={node.retry?.backoffMs ?? 250}
            onChange={(event) =>
              update({
                retry: {
                  maxAttempts: node.retry?.maxAttempts ?? 1,
                  backoffMs: Math.max(0, Number(event.target.value)),
                },
              })
            }
          />
        </label>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
        <button
          type="button"
          disabled={!canMoveUp}
          onClick={onMoveUp}
          aria-label={`Move step ${index + 1} up`}
        >
          Move Up
        </button>
        <button
          type="button"
          disabled={!canMoveDown}
          onClick={onMoveDown}
          aria-label={`Move step ${index + 1} down`}
        >
          Move Down
        </button>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove step ${index + 1}`}
        >
          Remove
        </button>
      </div>
    </fieldset>
  );
}

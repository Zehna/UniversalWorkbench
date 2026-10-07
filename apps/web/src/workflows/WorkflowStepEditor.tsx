import { useState } from "react";
import type { ToolDescriptor, WorkflowNode } from "@uw/contracts";
import {
  isLocalSecretRef,
  parseJsonSchemaInput,
  validateAiToolConfig,
} from "../tools/ai-config";

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

function AiStepFields({
  config,
  updateConfig,
}: {
  config: Record<string, unknown>;
  updateConfig(patch: Record<string, unknown>): void;
}) {
  const format =
    config.responseFormat !== null && typeof config.responseFormat === "object"
      ? (config.responseFormat as { kind?: unknown; jsonSchema?: unknown })
      : { kind: "text" };
  const kind = format.kind === "json" ? "json" : "text";
  const [rawSchema, setRawSchema] = useState(
    typeof format.jsonSchema === "string"
      ? format.jsonSchema
      : format.jsonSchema !== undefined
        ? JSON.stringify(format.jsonSchema, null, 2)
        : "",
  );
  const [schemaError, setSchemaError] = useState("");
  const secretRef =
    typeof config.secretRef === "string" ? config.secretRef : "";
  const errors = validateAiToolConfig(config);

  return (
    <>
      <label>
        AI provider
        <input
          value={String(config.providerId ?? "mock")}
          onChange={(event) => updateConfig({ providerId: event.target.value })}
          placeholder="mock"
          list="ai-provider-options"
        />
        <datalist id="ai-provider-options">
          <option value="mock" />
          <option value="http" />
        </datalist>
      </label>
      <label>
        AI model
        <input
          value={String(config.model ?? "")}
          onChange={(event) => updateConfig({ model: event.target.value })}
          placeholder="e2e-model"
        />
      </label>
      <label>
        AI prompt
        <textarea
          rows={3}
          value={String(config.prompt ?? "")}
          onChange={(event) => updateConfig({ prompt: event.target.value })}
          placeholder="Summarize the input:"
        />
      </label>
      <label>
        System prompt (optional)
        <textarea
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
          value={secretRef}
          onChange={(event) => updateConfig({ secretRef: event.target.value })}
          placeholder="secret://vault/openai"
        />
      </label>
      <p>Use a vault secret for server runs, such as secret://vault/openai.</p>
      {isLocalSecretRef(secretRef) ? (
        <p role="alert">
          secret://local/* stays on this device; server runs will fail. Use a
          vault secret for server execution.
        </p>
      ) : null}
      <fieldset>
        <legend>Response format</legend>
        <label>
          <input
            type="radio"
            name="ai-response-format"
            checked={kind === "text"}
            onChange={() => updateConfig({ responseFormat: { kind: "text" } })}
          />
          Text
        </label>
        <label>
          <input
            type="radio"
            name="ai-response-format"
            checked={kind === "json"}
            onChange={() =>
              updateConfig({
                responseFormat: { kind: "json", jsonSchema: {} },
              })
            }
          />
          JSON
        </label>
      </fieldset>
      {kind === "json" ? (
        <label>
          JSON schema
          <textarea
            rows={4}
            value={rawSchema}
            onChange={(event) => setRawSchema(event.target.value)}
            onBlur={() => {
              const parsed = parseJsonSchemaInput(rawSchema);
              if (parsed.error) {
                setSchemaError(parsed.error);
              } else {
                setSchemaError("");
                updateConfig({
                  responseFormat: {
                    kind: "json",
                    jsonSchema: parsed.schema ?? {},
                  },
                });
              }
            }}
            placeholder='{"type": "object"}'
          />
          {schemaError ? <span role="alert">{schemaError}</span> : null}
        </label>
      ) : null}
      <label>
        Max output tokens
        <input
          type="number"
          min={1}
          max={128000}
          value={Number(config.maxOutputTokens ?? 1024)}
          onChange={(event) =>
            updateConfig({ maxOutputTokens: Number(event.target.value) })
          }
        />
      </label>
      {errors.length > 0 ? (
        <ul>
          {errors.map((message) => (
            <li key={message} role="alert">
              {message}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
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
      ) : descriptor.id === "builtin.ai.complete" ? (
        <AiStepFields config={config} updateConfig={updateConfig} />
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

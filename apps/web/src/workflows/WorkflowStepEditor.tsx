import { useEffect, useState } from "react";
import type { JsonObject, ToolDefinition, WorkflowNode } from "@uw/contracts";

interface WorkflowStepEditorProps {
  node: WorkflowNode;
  tool: ToolDefinition | undefined;
  index: number;
  total: number;
  onMoveUp(): void;
  onMoveDown(): void;
  onRemove(): void;
  onConfig(config: JsonObject): void;
}

export function WorkflowStepEditor({
  node,
  tool,
  index,
  total,
  onMoveUp,
  onMoveDown,
  onRemove,
  onConfig,
}: WorkflowStepEditorProps) {
  const label = tool?.displayName ?? `${node.tool.id}@${node.tool.version}`;
  const serialized = JSON.stringify(node.config, null, 2);
  const [draft, setDraft] = useState(serialized);
  const [configError, setConfigError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(serialized);
    setConfigError(null);
  }, [serialized]);

  function commitConfig(value: string) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        setConfigError("Configuration must be a JSON object");
        return;
      }
      setConfigError(null);
      onConfig(parsed as JsonObject);
    } catch {
      setConfigError("Configuration must be valid JSON");
    }
  }

  return (
    <li data-testid="workflow-step">
      <strong>{label}</strong>
      <div>
        <button
          type="button"
          aria-label={`Move ${label} up`}
          disabled={index === 0}
          onClick={onMoveUp}
        >
          Move up
        </button>
        <button
          type="button"
          aria-label={`Move ${label} down`}
          disabled={index === total - 1}
          onClick={onMoveDown}
        >
          Move down
        </button>
        <button
          type="button"
          aria-label={`Remove ${label}`}
          onClick={onRemove}
        >
          Remove
        </button>
      </div>
      <label>
        {label} configuration
        <textarea
          value={draft}
          rows={6}
          aria-invalid={configError ? "true" : "false"}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={(event) => commitConfig(event.target.value)}
        />
        {configError ? <span role="alert">{configError}</span> : null}
      </label>
    </li>
  );
}

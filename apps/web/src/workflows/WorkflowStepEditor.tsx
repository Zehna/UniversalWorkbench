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
          value={JSON.stringify(node.config, null, 2)}
          rows={6}
          onChange={(event) => {
            try {
              const parsed = JSON.parse(event.target.value) as unknown;
              if (
                typeof parsed === "object" &&
                parsed !== null &&
                !Array.isArray(parsed)
              ) {
                onConfig(parsed as JsonObject);
              }
            } catch {
              // Keep the last valid config until the textarea becomes valid JSON.
            }
          }}
        />
      </label>
    </li>
  );
}

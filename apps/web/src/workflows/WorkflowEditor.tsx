import { useState, type FormEvent } from "react";
import type {
  ContextType,
  ToolDescriptor,
  WorkflowDefinition,
  WorkflowNode,
} from "@uw/contracts";
import { api, type WorkflowVersion } from "../api/client";
import { validateAiToolConfig } from "../tools/ai-config";
import {
  compatibleTools,
  descriptorFor,
  initialConfig,
  isLinearWorkflow,
  linearDefinition,
  linearTypesCompatible,
} from "../tools/tool-catalog";
import { WorkflowStepEditor } from "./WorkflowStepEditor";

interface WorkflowEditorProps {
  projectId: string;
  tools: ToolDescriptor[];
  initial?: WorkflowVersion;
  onSaved(workflow: WorkflowVersion): void;
  onRun(workflow: WorkflowVersion): void;
  onBack(): void;
}

const inputTypes: ContextType[] = ["text", "json", "markdown"];

export function WorkflowEditor({
  projectId,
  tools,
  initial,
  onSaved,
  onRun,
  onBack,
}: WorkflowEditorProps) {
  const [definition, setDefinition] = useState<WorkflowDefinition>(
    initial?.definition ?? {
      id: crypto.randomUUID(),
      projectId,
      name: "",
      schemaVersion: 1,
      nodes: [],
      edges: [],
    },
  );
  const [version, setVersion] = useState(initial?.version);
  const first = definition.nodes[0];
  const firstDescriptor = first ? descriptorFor(tools, first) : undefined;
  const [rootType, setRootType] = useState<ContextType>(
    firstDescriptor?.accepts.find((item) => inputTypes.includes(item)) ??
      "text",
  );
  const [toolChoice, setToolChoice] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<WorkflowVersion | null>(initial ?? null);

  const previous = definition.nodes.at(-1);
  const previousDescriptor = previous
    ? descriptorFor(tools, previous)
    : undefined;
  const compatible = compatibleTools(tools, rootType, previousDescriptor);
  const unsupported = initial && !isLinearWorkflow(initial.definition);
  const invalid = !linearTypesCompatible(definition.nodes, tools, rootType);

  function changeNodes(nodes: WorkflowNode[]) {
    setDefinition((current) => linearDefinition(current, nodes));
    setSaved(null);
  }

  function addStep() {
    const descriptor =
      compatible.find((item) => item.id + "@" + item.version === toolChoice) ??
      compatible[0];
    if (!descriptor) return;
    changeNodes([
      ...definition.nodes,
      {
        id: crypto.randomUUID(),
        toolId: descriptor.id,
        toolVersion: descriptor.version,
        config: initialConfig(descriptor),
        input: { source: "workflow_input" },
        timeoutMs: 30000,
        retry: { maxAttempts: 1, backoffMs: 250 },
      },
    ]);
    setToolChoice("");
    setError(null);
  }

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= definition.nodes.length) return;
    const next = [...definition.nodes];
    [next[index], next[target]] = [next[target]!, next[index]!];
    if (!linearTypesCompatible(next, tools, rootType)) {
      setError("This move would create an incompatible input/output binding.");
      return;
    }
    changeNodes(next);
    setError(null);
  }

  function remove(index: number) {
    const next = definition.nodes.filter((_, itemIndex) => itemIndex !== index);
    if (!linearTypesCompatible(next, tools, rootType)) {
      setError("Remove or change the dependent step first.");
      return;
    }
    changeNodes(next);
    setError(null);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (unsupported || invalid || definition.nodes.length === 0) {
      setError("Add at least one compatible step before saving.");
      return;
    }
    const incomplete = definition.nodes.find((node) => {
      const config = node.config as Record<string, unknown>;
      return (
        (node.toolId === "builtin.http.request" &&
          (typeof config.url !== "string" ||
            !/^https?:\/\//.test(config.url))) ||
        (node.toolId === "builtin.json.extract" &&
          (typeof config.path !== "string" ||
            config.path.trim().length === 0)) ||
        (node.toolId === "builtin.http.request" &&
          !["GET", "HEAD"].includes(String(config.method)) &&
          !node.idempotencyKey) ||
        (node.toolId === "builtin.ai.complete" &&
          validateAiToolConfig(config).length > 0)
      );
    });
    if (incomplete) {
      setError("Complete the step URL, JSON path, or idempotency key.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const next = await api.saveWorkflow(projectId, definition, version);
      setDefinition(next.definition);
      setVersion(next.version);
      setSaved(next);
      onSaved(next);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not save workflow",
      );
    } finally {
      setSaving(false);
    }
  }

  if (unsupported) {
    return (
      <section>
        <h3>Non-linear workflow</h3>
        <p>
          This workflow has branches. The linear editor will not overwrite its
          graph.
        </p>
        <button type="button" onClick={onBack}>
          Back to Workflows
        </button>
      </section>
    );
  }

  return (
    <section aria-label="Workflow editor" style={{ maxWidth: "100%" }}>
      <button type="button" onClick={onBack}>
        Back to Workflows
      </button>
      <h3>{initial ? "Edit workflow" : "New workflow"}</h3>
      <p>Steps run in order. Workflow editing needs a server connection.</p>
      <form onSubmit={(event) => void save(event)}>
        <label>
          Workflow name
          <input
            required
            maxLength={200}
            value={definition.name}
            onChange={(event) => {
              setDefinition({ ...definition, name: event.target.value });
              setSaved(null);
            }}
          />
        </label>
        <label>
          Workflow input type
          <select
            value={rootType}
            onChange={(event) => {
              setRootType(event.target.value as ContextType);
              setSaved(null);
            }}
          >
            {inputTypes.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
        {definition.nodes.map((node, index) => {
          const descriptor = descriptorFor(tools, node);
          const source =
            index === 0
              ? "Workflow input"
              : (descriptorFor(tools, definition.nodes[index - 1]!)?.name ??
                "Previous step");
          return descriptor ? (
            <WorkflowStepEditor
              key={node.id}
              node={node}
              descriptor={descriptor}
              index={index}
              sourceLabel={source}
              canMoveUp={index > 0}
              canMoveDown={index < definition.nodes.length - 1}
              onChange={(changed) =>
                changeNodes(
                  definition.nodes.map((item) =>
                    item.id === changed.id ? changed : item,
                  ),
                )
              }
              onMoveUp={() => move(index, -1)}
              onMoveDown={() => move(index, 1)}
              onRemove={() => remove(index)}
            />
          ) : (
            <p key={node.id} role="alert">
              Unavailable tool: {node.toolId}@{node.toolVersion}
            </p>
          );
        })}
        <fieldset style={{ borderRadius: 12, padding: 12 }}>
          <legend>Add Step</legend>
          {compatible.length === 0 ? (
            <p>No compatible tools for the current output type.</p>
          ) : (
            <>
              <label>
                Compatible tool
                <select
                  aria-label="Compatible tool"
                  value={
                    compatible.some(
                      (item) => item.id + "@" + item.version === toolChoice,
                    )
                      ? toolChoice
                      : compatible[0]!.id + "@" + compatible[0]!.version
                  }
                  onChange={(event) => setToolChoice(event.target.value)}
                >
                  {compatible.map((tool) => (
                    <option
                      key={tool.id + "@" + tool.version}
                      value={tool.id + "@" + tool.version}
                    >
                      {tool.name} · v{tool.version}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" onClick={addStep}>
                Add Step
              </button>
            </>
          )}
        </fieldset>
        {invalid ? (
          <p role="alert">
            The workflow input or a step output is incompatible.
          </p>
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
        <div
          style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 16 }}
        >
          <button
            type="submit"
            disabled={saving || invalid || definition.nodes.length === 0}
          >
            {saving ? "Saving…" : "Save workflow"}
          </button>
          {saved && (
            <button type="button" onClick={() => onRun(saved)}>
              Run workflow
            </button>
          )}
        </div>
      </form>
    </section>
  );
}

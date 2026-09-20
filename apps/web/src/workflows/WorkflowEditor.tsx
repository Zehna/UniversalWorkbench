import { useEffect, useMemo, useState, type FormEvent } from "react";
import type {
  ToolDefinition,
  WorkflowDefinitionV1,
  WorkflowDocumentView,
  WorkflowEdge,
  WorkflowNode,
} from "@uw/contracts";
import type { SyncCoordinator } from "../sync/coordinator";
import { ExecutionTimeline } from "./ExecutionTimeline";
import { WorkflowStepEditor } from "./WorkflowStepEditor";
import type { WorkflowApiClient } from "./api";

type EditorCoordinator = Pick<
  SyncCoordinator,
  | "createWorkflow"
  | "updateWorkflow"
  | "workflowRunEligibility"
  | "resolveWorkflowConflict"
>;

interface WorkflowEditorProps {
  projectId: string;
  initial?: WorkflowDocumentView | undefined;
  coordinator: EditorCoordinator;
  api: WorkflowApiClient;
  tools?: ToolDefinition[] | undefined;
  syncVersion?: string | undefined;
  onSaved?: ((view: WorkflowDocumentView) => void) | undefined;
}

function toolFor(
  tools: ToolDefinition[],
  node: WorkflowNode,
): ToolDefinition | undefined {
  return tools.find(
    (tool) => tool.id === node.tool.id && tool.version === node.tool.version,
  );
}

function matchingEdge(
  left: ToolDefinition | undefined,
  right: ToolDefinition | undefined,
  leftNodeId: string,
  rightNodeId: string,
): WorkflowEdge | null {
  if (!left || !right) return null;
  for (const output of left.produces) {
    const compatibleInputs = right.accepts
      .filter((input) =>
        output.types.some((type) => input.types.includes(type)),
      )
      .sort(
        (first, second) =>
          first.types.length - second.types.length ||
          first.name.localeCompare(second.name),
      );
    const input = compatibleInputs[0];
    if (input) {
      return {
        from: { nodeId: leftNodeId, output: output.name },
        to: { nodeId: rightNodeId, input: input.name },
      };
    }
  }
  return null;
}

function linearDefinition(
  name: string,
  nodes: WorkflowNode[],
  tools: ToolDefinition[],
): WorkflowDefinitionV1 {
  const edges: WorkflowEdge[] = [];
  for (let index = 0; index < nodes.length - 1; index += 1) {
    const left = nodes[index]!;
    const right = nodes[index + 1]!;
    const edge = matchingEdge(
      toolFor(tools, left),
      toolFor(tools, right),
      left.id,
      right.id,
    );
    if (edge) edges.push(edge);
  }

  const last = nodes.at(-1);
  const lastTool = last ? toolFor(tools, last) : undefined;
  const output = lastTool?.produces[0];

  return {
    schemaVersion: 1,
    name,
    nodes: structuredClone(nodes),
    edges,
    outputs:
      last && output
        ? [{ name: "result", from: { nodeId: last.id, output: output.name } }]
        : [],
  };
}

function initialNodes(initial: WorkflowDocumentView | undefined): WorkflowNode[] {
  return initial
    ? structuredClone(initial.revision.content.workflow.nodes)
    : [];
}

function nextNodeId(tool: ToolDefinition, nodes: WorkflowNode[]): string {
  const base = tool.id.split(".").at(-1) ?? "step";
  let candidate = base;
  let suffix = 2;
  const ids = new Set(nodes.map((node) => node.id));
  while (ids.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

export function WorkflowEditor({
  projectId,
  initial,
  coordinator,
  api,
  tools: suppliedTools,
  syncVersion,
  onSaved,
}: WorkflowEditorProps) {
  const [catalog, setCatalog] = useState<ToolDefinition[]>(suppliedTools ?? []);
  const [title, setTitle] = useState(
    initial?.document.title ?? initial?.revision.content.workflow.name ?? "",
  );
  const [nodes, setNodes] = useState<WorkflowNode[]>(() => initialNodes(initial));
  const [selectedTool, setSelectedTool] = useState("");
  const [addChoices, setAddChoices] = useState<ToolDefinition[]>(
    suppliedTools ?? [],
  );
  const [saved, setSaved] = useState<WorkflowDocumentView | undefined>(initial);
  const [eligibility, setEligibility] = useState<
    Awaited<ReturnType<EditorCoordinator["workflowRunEligibility"]>> | null
  >(null);
  const [executionId, setExecutionId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (suppliedTools) {
      setCatalog(suppliedTools);
      return;
    }
    let active = true;
    void api
      .listTools()
      .then((items) => {
        if (active) setCatalog(items);
      })
      .catch((cause) => {
        if (active) {
          setError(cause instanceof Error ? cause.message : "Unable to load tools");
        }
      });
    return () => {
      active = false;
    };
  }, [api, suppliedTools]);

  useEffect(() => {
    const last = nodes.at(-1);
    if (!last) {
      setAddChoices(catalog);
      return;
    }

    const lastTool = toolFor(catalog, last);
    const outputTypes = lastTool?.produces.flatMap((port) => port.types) ?? [];
    if (outputTypes.length === 0) {
      setAddChoices([]);
      return;
    }

    let active = true;
    void Promise.all(outputTypes.map((type) => api.compatibleTargets(type)))
      .then((groups) => {
        if (!active) return;
        const seen = new Set<string>();
        const compatible = groups
          .flat()
          .map((target) => target.definition)
          .filter((tool) => {
            const key = `${tool.id}@${tool.version}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        setAddChoices(compatible);
      })
      .catch((cause) => {
        if (active) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Unable to load compatible workflow tools",
          );
        }
      });

    return () => {
      active = false;
    };
  }, [api, catalog, nodes]);

  useEffect(() => {
    if (!saved) {
      setEligibility({ state: "missing" });
      return;
    }
    let active = true;
    void coordinator.workflowRunEligibility(saved.document.id).then((state) => {
      if (active) setEligibility(state);
    });
    return () => {
      active = false;
    };
  }, [coordinator, saved, syncVersion]);

  const definition = useMemo(
    () => linearDefinition(title || "Untitled workflow", nodes, catalog),
    [catalog, nodes, title],
  );

  function move(index: number, delta: -1 | 1) {
    const destination = index + delta;
    if (destination < 0 || destination >= nodes.length) return;
    setDirty(true);
    setNodes((current) => {
      const next = [...current];
      const [item] = next.splice(index, 1);
      if (!item) return current;
      next.splice(destination, 0, item);
      return next;
    });
  }

  function addStep() {
    const tool = addChoices.find(
      (candidate) => `${candidate.id}@${candidate.version}` === selectedTool,
    );
    if (!tool) return;
    setDirty(true);
    setNodes((current) => [
      ...current,
      {
        id: nextNodeId(tool, current),
        tool: { id: tool.id, version: tool.version },
        config: {},
      },
    ]);
    setSelectedTool("");
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const view = saved
        ? await coordinator.updateWorkflow(saved, {
            title,
            workflow: definition,
            baseRevisionId: saved.revision.id,
          })
        : await coordinator.createWorkflow(projectId, {
            title,
            workflow: definition,
          });
      setSaved(view);
      setDirty(false);
      setTitle(view.document.title);
      setNodes(structuredClone(view.revision.content.workflow.nodes));
      onSaved?.(view);
      setMessage("Saved locally");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to save workflow",
      );
    } finally {
      setBusy(false);
    }
  }

  async function resolveConflict(strategy: "keep-local" | "use-server") {
    if (!saved || eligibility?.state !== "conflict") return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const resolved = await coordinator.resolveWorkflowConflict(
        eligibility.operationId,
        strategy,
      );
      setSaved(resolved);
      setDirty(false);
      setTitle(resolved.document.title);
      setNodes(structuredClone(resolved.revision.content.workflow.nodes));
      onSaved?.(resolved);
      setMessage(
        strategy === "keep-local"
          ? "Local workflow queued against the server revision"
          : "Using server workflow version",
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to resolve workflow conflict",
      );
    } finally {
      setBusy(false);
    }
  }

  async function validate() {
    if (!saved || eligibility?.state !== "ready") return;
    setBusy(true);
    setError(null);
    try {
      await api.validateWorkflow(
        projectId,
        saved.document.id,
        eligibility.revisionId,
      );
      setMessage("Workflow is valid");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Workflow validation failed",
      );
    } finally {
      setBusy(false);
    }
  }

  async function run() {
    if (!saved || eligibility?.state !== "ready") return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.runWorkflow(
        projectId,
        saved.document.id,
        eligibility.revisionId,
        crypto.randomUUID(),
      );
      setExecutionId(result.execution.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to run workflow");
    } finally {
      setBusy(false);
    }
  }

  const runBlocked = dirty || !saved || eligibility?.state !== "ready";

  return (
    <section aria-label="Workflow editor">
      <h3>{saved ? "Edit Workflow" : "New Workflow"}</h3>
      <form onSubmit={save}>
        <label>
          Workflow title
          <input
            required
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
              setDirty(true);
            }}
          />
        </label>

        <ol>
          {nodes.map((node, index) => (
            <WorkflowStepEditor
              key={node.id}
              node={node}
              tool={toolFor(catalog, node)}
              index={index}
              total={nodes.length}
              onMoveUp={() => move(index, -1)}
              onMoveDown={() => move(index, 1)}
              onRemove={() => {
                setDirty(true);
                setNodes((current) =>
                  current.filter((candidate) => candidate.id !== node.id),
                );
              }}
              onConfig={(config) => {
                setDirty(true);
                setNodes((current) =>
                  current.map((candidate) =>
                    candidate.id === node.id
                      ? { ...candidate, config }
                      : candidate,
                  ),
                );
              }}
            />
          ))}
        </ol>

        <label>
          Add step
          <select
            value={selectedTool}
            onChange={(event) => setSelectedTool(event.target.value)}
          >
            <option value="">Choose a tool</option>
            {addChoices.map((tool) => (
              <option
                key={`${tool.id}@${tool.version}`}
                value={`${tool.id}@${tool.version}`}
              >
                {tool.displayName}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={!selectedTool}
          onClick={addStep}
        >
          Add Step
        </button>

        <button type="submit" disabled={busy || title.trim().length === 0}>
          {busy ? "Saving…" : "Save Workflow"}
        </button>
      </form>

      {runBlocked ? (
        <p>Run unavailable until this workflow is synced</p>
      ) : null}
      {eligibility?.state === "conflict" ? (
        <div role="alert">
          <p>
            Workflow sync conflict detected. Your local workflow has been
            preserved.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void resolveConflict("keep-local")}
          >
            Keep local and retry
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void resolveConflict("use-server")}
          >
            Use server version
          </button>
        </div>
      ) : null}
      <button
        type="button"
        disabled={busy || runBlocked}
        onClick={() => void validate()}
      >
        Validate
      </button>
      <button
        type="button"
        disabled={busy || runBlocked}
        onClick={() => void run()}
      >
        Run
      </button>

      {message ? <p role="status">{message}</p> : null}
      {error ? <p role="alert">{error}</p> : null}

      {executionId ? (
        <ExecutionTimeline
          projectId={projectId}
          executionId={executionId}
          api={api}
        />
      ) : null}
    </section>
  );
}

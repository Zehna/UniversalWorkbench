import { useEffect, useState } from "react";
import type { ToolDescriptor } from "@uw/contracts";
import { api, type WorkflowVersion } from "../api/client";
import { RunWorkflow } from "../executions/RunWorkflow";
import { WorkflowEditor } from "./WorkflowEditor";

interface WorkflowListProps {
  projectId: string;
}

type Mode =
  | { kind: "list" }
  | { kind: "editor"; workflow?: WorkflowVersion }
  | { kind: "run"; workflow: WorkflowVersion };

export function WorkflowList({ projectId }: WorkflowListProps) {
  const [workflows, setWorkflows] = useState<WorkflowVersion[]>([]);
  const [tools, setTools] = useState<ToolDescriptor[]>([]);
  const [grantedPermissions, setGrantedPermissions] = useState<string[]>([]);
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void Promise.all([api.listWorkflows(projectId), api.listTools()])
      .then(([nextWorkflows, catalog]) => {
        if (!active) return;
        setWorkflows(nextWorkflows);
        setTools(catalog.tools);
        setGrantedPermissions(catalog.grantedPermissions);
        setLoading(false);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setLoading(false);
        setError(
          cause instanceof Error
            ? cause.message
            : "Workflow features require a server connection.",
        );
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  function saved(workflow: WorkflowVersion) {
    setWorkflows((current) => [
      ...current.filter((item) => item.workflowId !== workflow.workflowId),
      workflow,
    ]);
  }

  if (mode.kind === "editor") {
    return (
      <WorkflowEditor
        key={mode.workflow?.id ?? "new"}
        projectId={projectId}
        tools={tools}
        {...(mode.workflow ? { initial: mode.workflow } : {})}
        onSaved={saved}
        onRun={(workflow) => setMode({ kind: "run", workflow })}
        onBack={() => setMode({ kind: "list" })}
      />
    );
  }

  if (mode.kind === "run") {
    return (
      <RunWorkflow
        projectId={projectId}
        workflow={mode.workflow}
        tools={tools}
        grantedPermissions={grantedPermissions}
        onBack={() => setMode({ kind: "list" })}
      />
    );
  }

  return (
    <section aria-labelledby="workflows-title">
      <h3 id="workflows-title">Workflows</h3>
      <p>
        Build and run a linear workflow. Saving and running require a
        connection.
      </p>
      {loading ? <p role="status">Loading workflows…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <button
        type="button"
        disabled={loading || !!error}
        onClick={() => setMode({ kind: "editor" })}
      >
        New workflow
      </button>
      {!loading && workflows.length === 0 ? <p>No workflows yet.</p> : null}
      <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
        {workflows.map((workflow) => (
          <article
            key={workflow.workflowId}
            style={{
              border: "1px solid #555",
              borderRadius: 12,
              padding: 12,
            }}
          >
            <h4>{workflow.definition.name}</h4>
            <p>
              Version {workflow.version} · {workflow.definition.nodes.length}{" "}
              steps
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <button
                type="button"
                onClick={() => setMode({ kind: "editor", workflow })}
              >
                Edit {workflow.definition.name}
              </button>
              <button
                type="button"
                onClick={() => setMode({ kind: "run", workflow })}
              >
                Run {workflow.definition.name}
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

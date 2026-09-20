import { useEffect, useMemo, useState } from "react";
import type { WorkflowDocumentView } from "@uw/contracts";
import { useSyncRuntime } from "../sync/runtime";
import { WorkflowEditor } from "./WorkflowEditor";
import { createWorkflowApiClient } from "./api";

export function WorkflowList({ projectId }: { projectId: string }) {
  const { coordinator, status } = useSyncRuntime();
  const api = useMemo(() => createWorkflowApiClient(), []);
  const [workflows, setWorkflows] = useState<WorkflowDocumentView[]>([]);
  const [selected, setSelected] = useState<WorkflowDocumentView | undefined>();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void coordinator
      .listWorkflows(projectId)
      .then((items) => {
        if (!active) return;
        setWorkflows(items);
        if (selected) {
          const refreshed = items.find(
            (item) => item.document.id === selected.document.id,
          );
          if (refreshed) setSelected(refreshed);
        }
      })
      .catch((cause) => {
        if (active) {
          setError(
            cause instanceof Error ? cause.message : "Unable to load workflows",
          );
        }
      });
    return () => {
      active = false;
    };
  }, [coordinator, projectId, selected?.document.id, status]);

  function saved(view: WorkflowDocumentView) {
    setCreating(false);
    setSelected(view);
    setWorkflows((current) => [
      ...current.filter((item) => item.document.id !== view.document.id),
      view,
    ]);
  }

  return (
    <section aria-labelledby="workflows-title">
      <h3 id="workflows-title">Workflows</h3>
      <button
        type="button"
        onClick={() => {
          setCreating(true);
          setSelected(undefined);
        }}
      >
        New Workflow
      </button>
      {error ? <p role="alert">{error}</p> : null}
      {workflows.length === 0 ? <p>No workflows yet.</p> : null}
      {workflows.map((workflow) => (
        <button
          key={workflow.document.id}
          type="button"
          onClick={() => {
            setSelected(workflow);
            setCreating(false);
          }}
        >
          {workflow.document.title}
        </button>
      ))}

      {selected ? (
        <WorkflowEditor
          key={selected.document.id}
          projectId={projectId}
          initial={selected}
          coordinator={coordinator}
          api={api}
          syncVersion={JSON.stringify(status)}
          onSaved={saved}
        />
      ) : creating ? (
        <WorkflowEditor
          key="new-workflow"
          projectId={projectId}
          coordinator={coordinator}
          api={api}
          syncVersion={JSON.stringify(status)}
          onSaved={saved}
        />
      ) : null}
    </section>
  );
}

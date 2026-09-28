import { useEffect, useState } from "react";
import { api, type ExecutionDetails } from "../api/client";

interface ExecutionStatusProps {
  projectId: string;
  executionId: string;
  onBack(): void;
}

const terminal = new Set(["completed", "failed", "cancelled", "interrupted"]);

export function ExecutionStatus({
  projectId,
  executionId,
  onBack,
}: ExecutionStatusProps) {
  const [view, setView] = useState<ExecutionDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  async function refresh() {
    try {
      setView(await api.getExecution(projectId, executionId));
      setError(null);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to load execution",
      );
    }
  }

  useEffect(() => {
    let active = true;
    void api
      .getExecution(projectId, executionId)
      .then((next) => {
        if (active) setView(next);
      })
      .catch((cause: unknown) => {
        if (active)
          setError(
            cause instanceof Error ? cause.message : "Unable to load execution",
          );
      });
    return () => {
      active = false;
    };
  }, [projectId, executionId]);

  useEffect(() => {
    if (view && terminal.has(view.execution.status)) return;
    const timer = window.setInterval(() => {
      void refresh();
    }, 2500);
    return () => window.clearInterval(timer);
  }, [view?.execution.status, projectId, executionId]);

  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      setView(await api.cancelExecution(projectId, executionId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Cancellation failed");
    } finally {
      setBusy(false);
    }
  }

  async function saveOutput(contextId: string) {
    setBusy(true);
    setError(null);
    try {
      const artifact = await api.saveExecutionOutput(
        projectId,
        executionId,
        contextId,
      );
      setSaved(artifact.id);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not save artifact",
      );
    } finally {
      setBusy(false);
    }
  }

  const status = view?.execution.status;
  const outputs =
    view?.steps
      .filter((step) => step.status === "completed")
      .flatMap((step) => step.outputContexts) ?? [];

  return (
    <section aria-label="Execution status">
      <button type="button" onClick={onBack}>
        Back to workflow
      </button>
      <h3>Execution status</h3>
      <p>
        Execution ID: <code>{executionId}</code>
      </p>
      <p role="status">Status: {status ?? "Loading"}</p>
      {view?.execution.error ? (
        <p role="alert">
          {view.execution.error.code}: {view.execution.error.message}
        </p>
      ) : null}
      {view?.steps.map((step) => (
        <article key={step.nodeId + ":" + step.attempt}>
          <strong>
            {step.toolId} · Attempt {step.attempt}: {step.status}
          </strong>
          {step.error ? <p role="alert">{step.error.message}</p> : null}
        </article>
      ))}
      {status === "completed" && outputs.length > 0 ? (
        <section>
          <h4>Workflow outputs</h4>
          {outputs.map((output) => (
            <div key={output.id}>
              <p>{output.type}</p>
              <pre
                style={{
                  overflowX: "auto",
                  whiteSpace: "pre-wrap",
                  overflowWrap: "anywhere",
                }}
              >
                {typeof output.payload === "string"
                  ? output.payload
                  : JSON.stringify(output.payload, null, 2)}
              </pre>
              <button
                type="button"
                disabled={busy}
                onClick={() => void saveOutput(output.id)}
              >
                Save output as Artifact
              </button>
            </div>
          ))}
        </section>
      ) : null}
      {saved ? <p role="status">Artifact saved: {saved}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <button type="button" disabled={busy} onClick={() => void refresh()}>
          Refresh status
        </button>
        {(status === "queued" || status === "running") && (
          <button type="button" disabled={busy} onClick={() => void cancel()}>
            Cancel execution
          </button>
        )}
      </div>
    </section>
  );
}

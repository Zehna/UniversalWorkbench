import { useEffect, useState } from "react";
import type { Execution } from "@uw/contracts";
import type {
  ExecutionReceiptSnapshot,
  ExecutionSnapshot,
  WorkflowApiClient,
} from "./api";

const TERMINAL = new Set<Execution["status"]>([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
]);

interface ExecutionTimelineProps {
  projectId: string;
  executionId: string;
  api: WorkflowApiClient;
  pollIntervalMs?: number;
}

export function ExecutionTimeline({
  projectId,
  executionId,
  api,
  pollIntervalMs = 1_000,
}: ExecutionTimelineProps) {
  const [snapshot, setSnapshot] = useState<ExecutionSnapshot | null>(null);
  const [receipt, setReceipt] = useState<ExecutionReceiptSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function load() {
      try {
        const next = await api.getExecution(projectId, executionId);
        if (cancelled) return;
        setSnapshot(next);

        if (TERMINAL.has(next.execution.status)) {
          const terminalReceipt = await api.getReceipt(projectId, executionId);
          if (!cancelled) setReceipt(terminalReceipt);
          return;
        }

        timer = setTimeout(() => {
          void load();
        }, pollIntervalMs);
      } catch (cause) {
        if (!cancelled) {
          setError(
            cause instanceof Error ? cause.message : "Unable to load execution",
          );
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [api, executionId, pollIntervalMs, projectId]);

  if (error) return <p role="alert">{error}</p>;
  if (!snapshot) return <p role="status">Loading execution…</p>;

  return (
    <section aria-label="Execution timeline">
      <h4>Execution: {snapshot.execution.status}</h4>
      <ol>
        {snapshot.steps.map((step) => (
          <li key={step.id}>
            {step.nodeId} · {step.status} · attempt {step.attempt}
            {step.error ? ` · ${JSON.stringify(step.error)}` : ""}
          </li>
        ))}
      </ol>
      {receipt ? (
        <div>
          <p>Receipts: {receipt.receipts.length}</p>
          <p>Provenance edges: {receipt.provenance.length}</p>
        </div>
      ) : null}
    </section>
  );
}

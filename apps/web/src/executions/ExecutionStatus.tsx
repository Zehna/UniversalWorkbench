import { useEffect, useState } from "react";
import type { AgentTraceItem, ContextEnvelope } from "@uw/contracts";
import { api, type ExecutionDetails } from "../api/client";
import { formatTokenUsage, usageSourceOf } from "../send-to/send-to";
import { AgentTraceViewer } from "./AgentTraceViewer";

const PAYLOAD_PREVIEW_LIMIT = 4000;

interface AgentResponsePayloadView {
  text?: unknown;
  model?: unknown;
  status?: unknown;
  iterations?: unknown;
  trace?: unknown;
  usage?: Record<string, unknown>;
  usageSource?: unknown;
}

function agentPayloadOf(
  output: ContextEnvelope,
): AgentResponsePayloadView | null {
  if (output.type !== "agent_response") return null;
  if (output.payload === null || typeof output.payload !== "object")
    return null;
  return output.payload as AgentResponsePayloadView;
}

function toTraceItems(value: unknown): AgentTraceItem[] {
  return Array.isArray(value) ? (value as AgentTraceItem[]) : [];
}

function renderPayloadText(output: ContextEnvelope): string {
  if (
    (output.type === "ai_response" || output.type === "agent_response") &&
    output.payload !== null &&
    typeof output.payload === "object" &&
    "text" in output.payload &&
    typeof (output.payload as { text: unknown }).text === "string"
  ) {
    return (output.payload as { text: string }).text;
  }
  if (typeof output.payload === "string") return output.payload;
  return JSON.stringify(output.payload, null, 2) ?? "";
}

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
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [online, setOnline] = useState<boolean>(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );

  function tokenNumber(value: unknown): number {
    return typeof value === "number" && Number.isInteger(value) && value >= 0
      ? value
      : 0;
  }

  function stepTokens(outputs: ContextEnvelope[]): {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  } {
    const totals = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    for (const output of outputs) {
      if (output.type !== "ai_response" && output.type !== "agent_response")
        continue;
      const usage =
        output.payload !== null && typeof output.payload === "object"
          ? ((output.payload as { usage?: Record<string, unknown> }).usage ??
            {})
          : {};
      totals.promptTokens += tokenNumber(usage.promptTokens);
      totals.completionTokens += tokenNumber(usage.completionTokens);
      totals.totalTokens += tokenNumber(usage.totalTokens);
    }
    return totals;
  }

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
    function goOnline(): void {
      setOnline(true);
      void refresh();
    }
    function goOffline(): void {
      setOnline(false);
    }
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, [projectId, executionId]);

  useEffect(() => {
    if (view && terminal.has(view.execution.status)) return;
    if (!online) return;
    const timer = window.setInterval(() => {
      if (navigator.onLine) void refresh();
    }, 2500);
    return () => window.clearInterval(timer);
  }, [view?.execution.status, projectId, executionId, online]);

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

  async function saveNote(contextId: string) {
    setBusy(true);
    setError(null);
    try {
      const document = await api.saveNoteFromExecution(
        projectId,
        executionId,
        contextId,
      );
      setSavedNote(document.document.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save note");
    } finally {
      setBusy(false);
    }
  }

  const status = view?.execution.status;
  const outputs =
    view?.steps
      .filter((step) => step.status === "completed")
      .flatMap((step) => step.outputContexts) ?? [];
  const liveAgentOutputs =
    view?.steps
      .flatMap((step) => step.outputContexts)
      .filter(
        (
          output,
        ): output is Extract<ContextEnvelope, { type: "agent_response" }> =>
          output.type === "agent_response",
      ) ?? [];
  const liveTrace = liveAgentOutputs.flatMap((output) => {
    const payload = agentPayloadOf(output);
    return payload ? toTraceItems(payload.trace) : [];
  });
  const liveAgentStatus =
    liveAgentOutputs.length > 0
      ? (() => {
          const last = liveAgentOutputs[liveAgentOutputs.length - 1]!;
          const payload = agentPayloadOf(last);
          return typeof payload?.status === "string"
            ? payload.status
            : undefined;
        })()
      : undefined;

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
      {!online ? (
        <p role="status">
          Connection lost — retrying automatically on reconnect…
        </p>
      ) : null}
      {view?.execution.error ? (
        <p role="alert">
          {view.execution.error.code}: {view.execution.error.message}
        </p>
      ) : null}
      {view ? (
        <p>
          Total:{" "}
          {formatTokenUsage(
            {
              promptTokens: view.execution.usage.promptTokens,
              completionTokens: view.execution.usage.completionTokens,
              totalTokens: view.execution.usage.totalTokens,
            },
            view.steps.some((step) =>
              step.outputContexts.some(
                (output) => usageSourceOf(output) === "estimated",
              ),
            )
              ? "estimated"
              : "provider",
          )}
        </p>
      ) : null}
      {view?.steps.map((step) => (
        <article key={step.nodeId + ":" + step.attempt}>
          <strong>
            {step.toolId} · Attempt {step.attempt}: {step.status}
          </strong>
          {step.outputContexts.some(
            (output) =>
              output.type === "ai_response" || output.type === "agent_response",
          ) ? (
            <p>
              Tokens:{" "}
              {formatTokenUsage(
                stepTokens(step.outputContexts),
                step.outputContexts.some(
                  (output) => usageSourceOf(output) === "estimated",
                )
                  ? "estimated"
                  : "provider",
              )}
            </p>
          ) : null}
          {step.error ? <p role="alert">{step.error.message}</p> : null}
        </article>
      ))}
      {status === "completed" && outputs.length > 0 ? (
        <section>
          <h4>Workflow outputs</h4>
          {outputs.map((output) => {
            const fullText = renderPayloadText(output);
            const isExpanded = expanded.has(output.id);
            const truncated =
              fullText.length > PAYLOAD_PREVIEW_LIMIT && !isExpanded;
            const agentPayload = agentPayloadOf(output);
            return (
              <div key={output.id}>
                <p>{output.type}</p>
                {agentPayload ? (
                  <AgentTraceViewer
                    trace={toTraceItems(agentPayload.trace)}
                    status={
                      typeof agentPayload.status === "string"
                        ? agentPayload.status
                        : "completed"
                    }
                    usage={agentPayload.usage}
                    usageSource={
                      typeof agentPayload.usageSource === "string"
                        ? agentPayload.usageSource
                        : usageSourceOf(output)
                    }
                    model={
                      typeof agentPayload.model === "string"
                        ? agentPayload.model
                        : undefined
                    }
                    iterations={
                      typeof agentPayload.iterations === "number"
                        ? agentPayload.iterations
                        : undefined
                    }
                    text={
                      typeof agentPayload.text === "string"
                        ? agentPayload.text
                        : undefined
                    }
                    projectId={projectId}
                    executionId={executionId}
                  />
                ) : null}
                <pre
                  style={{
                    overflowX: "auto",
                    whiteSpace: "pre-wrap",
                    overflowWrap: "anywhere",
                  }}
                >
                  {truncated
                    ? fullText.slice(0, PAYLOAD_PREVIEW_LIMIT)
                    : fullText}
                </pre>
                {fullText.length > PAYLOAD_PREVIEW_LIMIT ? (
                  <button
                    type="button"
                    aria-expanded={isExpanded}
                    aria-label={
                      isExpanded ? "Show less payload" : "Show full payload"
                    }
                    onClick={() =>
                      setExpanded((current) => {
                        const next = new Set(current);
                        if (next.has(output.id)) next.delete(output.id);
                        else next.add(output.id);
                        return next;
                      })
                    }
                  >
                    {isExpanded ? "Show less" : "Show full payload"}
                  </button>
                ) : null}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void saveOutput(output.id)}
                >
                  Save output as Artifact
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void saveNote(output.id)}
                >
                  Save as Note
                </button>
              </div>
            );
          })}
        </section>
      ) : null}
      {status &&
      (status === "queued" ||
        status === "running" ||
        status === "awaiting_approval") ? (
        <section aria-label="Live execution stream">
          <h4>Live stream</h4>
          <AgentTraceViewer
            trace={liveTrace}
            status={liveAgentStatus ?? status}
            projectId={projectId}
            executionId={executionId}
          />
        </section>
      ) : null}
      {saved ? <p role="status">Artifact saved: {saved}</p> : null}
      {savedNote ? <p role="status">Note saved: {savedNote}</p> : null}
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

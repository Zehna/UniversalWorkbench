import { useEffect, useRef, useState } from "react";
import type { AgentTraceItem } from "@uw/contracts";
import { formatTokenUsage } from "../send-to/send-to";
import { ApprovalCard, type PendingApproval } from "./ApprovalCard";

interface AgentUsage {
  promptTokens?: unknown;
  completionTokens?: unknown;
  totalTokens?: unknown;
}

interface AgentTraceViewerProps {
  trace: AgentTraceItem[];
  status: string;
  usage?: AgentUsage | undefined;
  usageSource?: string | undefined;
  model?: string | undefined;
  iterations?: number | undefined;
  text?: string | undefined;
  projectId?: string | undefined;
  executionId?: string | undefined;
}

const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "iteration_limit_reached",
  "error",
]);

function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

function toPendingApprovals(value: unknown): PendingApproval[] {
  if (!Array.isArray(value)) return [];
  const out: PendingApproval[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const approval: PendingApproval = {};
    if (typeof record.tool === "string") approval.tool = record.tool;
    if (typeof record.name === "string") approval.name = record.name;
    if (typeof record.toolCallId === "string") approval.toolCallId = record.toolCallId;
    if (typeof record.id === "string") approval.id = record.id;
    if (record.arguments !== undefined && typeof record.arguments === "object" && record.arguments !== null)
      approval.arguments = record.arguments as Record<string, unknown>;
    if (record.args !== undefined && typeof record.args === "object" && record.args !== null)
      approval.args = record.args as Record<string, unknown>;
    if (typeof record.toolCall === "object" && record.toolCall !== null) {
      const call = record.toolCall as Record<string, unknown>;
      if (approval.tool === undefined && typeof call.tool === "string")
        approval.tool = call.tool;
      if (approval.name === undefined && typeof call.name === "string")
        approval.name = call.name;
      if (
        approval.toolCallId === undefined &&
        typeof call.id === "string"
      )
        approval.toolCallId = call.id;
      if (
        approval.arguments === undefined &&
        typeof call.arguments === "object" &&
        call.arguments !== null
      )
        approval.arguments = call.arguments as Record<string, unknown>;
    }
    if (typeof record.reason === "string") approval.reason = record.reason;
    out.push(approval);
  }
  return out;
}

function renderValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function argsPreview(args: Record<string, unknown>): string {
  try {
    const flat = JSON.stringify(args);
    return flat ?? "";
  } catch {
    return "";
  }
}

export function AgentTraceViewer({
  trace,
  status,
  usage,
  usageSource,
  model,
  iterations,
  text,
  projectId,
  executionId,
}: AgentTraceViewerProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const [liveItems, setLiveItems] = useState<AgentTraceItem[]>([]);
  const [liveStatus, setLiveStatus] = useState<string | null>(null);
  const [liveText, setLiveText] = useState<string | null>(null);
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([]);
  const nextIteration = useRef(trace.length + 1);

  const resolvedStatus = liveStatus ?? status;
  const combined = [...trace, ...liveItems];
  const resolvedIterations = iterations ?? combined.length;
  const resolvedText = liveText ?? text;

  useEffect(() => {
    nextIteration.current = trace.length + liveItems.length + 1;
  }, [trace.length, liveItems.length]);

  useEffect(() => {
    if (!projectId || !executionId) return;
    if (isTerminalStatus(status)) return;
    const EventSourceImpl =
      typeof globalThis !== "undefined"
        ? (globalThis as unknown as { EventSource?: typeof EventSource }).EventSource
        : undefined;
    if (!EventSourceImpl) return;
    const source = new EventSourceImpl(
      `/api/projects/${projectId}/executions/${executionId}/events`,
    );

    function appendTraceEvent(event: Record<string, unknown>) {
      const hasThought = typeof event.thought === "string";
      const hasToolCall = event.toolCall !== undefined;
      const hasObservation = event.observation !== undefined;
      if (!hasThought && !hasToolCall && !hasObservation) return;
      const iteration =
        typeof event.iteration === "number" && Number.isInteger(event.iteration) && event.iteration > 0
          ? (event.iteration as number)
          : nextIteration.current++;
      const item: AgentTraceItem = { iteration };
      if (hasThought) item.thought = event.thought as string;
      if (hasToolCall) item.toolCall = event.toolCall as AgentTraceItem["toolCall"];
      if (hasObservation)
        item.observation = event.observation as AgentTraceItem["observation"];
      setLiveItems((current) => [...current, item]);
    }

    function handlePayload(payload: unknown) {
      if (payload === null || typeof payload !== "object") return;
      const event = payload as Record<string, unknown>;
      const type = typeof event.type === "string" ? event.type : "";
      if (type === "approval_needed") {
        const pending = toPendingApprovals(event.pendingApprovals);
        if (pending.length > 0) setPendingApprovals(pending);
        setLiveStatus("awaiting_approval");
        return;
      }
      if (type === "agent_response") {
        if (typeof event.status === "string") setLiveStatus(event.status);
        if (typeof event.text === "string") setLiveText(event.text);
        return;
      }
      if (type === "completed") {
        if (typeof event.status === "string") setLiveStatus(event.status);
        else setLiveStatus("completed");
        source.close();
        return;
      }
      if (type === "execution" || type === "step" || type === "status") {
        if (typeof event.status === "string") {
          setLiveStatus(event.status);
          if (isTerminalStatus(event.status)) source.close();
        }
        return;
      }
      if (typeof event.status === "string" && type === "") {
        setLiveStatus(event.status);
        if (isTerminalStatus(event.status)) source.close();
      }
      appendTraceEvent(event);
    }

    function onMessage(message: MessageEvent) {
      try {
        handlePayload(JSON.parse(String(message.data)));
      } catch {
        // Ignore malformed SSE frames.
      }
    }

    if (typeof (source as EventSource).addEventListener === "function") {
      (source as EventSource).addEventListener("message", onMessage as EventListener);
    } else {
      (source as unknown as { onmessage: unknown }).onmessage = onMessage;
    }

    return () => {
      source.close();
    };
  }, [projectId, executionId, status]);

  function toggle(iteration: number) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(iteration)) next.delete(iteration);
      else next.add(iteration);
      return next;
    });
  }

  return (
    <section aria-label="Agent trace">
      <span data-testid="agent-status" role="status">
        {resolvedStatus}
      </span>
      {model ? <p>Model: {model}</p> : null}
      <p>
        Iterations: {resolvedIterations}
        {resolvedStatus === "iteration_limit_reached" ? " (limit reached)" : ""}
      </p>
      {usage ? (
        <p data-testid="agent-usage">
          Token usage: {formatTokenUsage(usage, usageSource)}
        </p>
      ) : null}
      {resolvedText ? <p>Final answer: {resolvedText}</p> : null}
      {resolvedStatus === "awaiting_approval" && projectId && executionId ? (
        <ApprovalCard
          projectId={projectId}
          executionId={executionId}
          pendingApprovals={pendingApprovals}
        />
      ) : null}
      {combined.length === 0 ? (
        <p>No reasoning steps recorded.</p>
      ) : (
        <ol>
          {combined.map((item) => {
            const isOpen = expanded.has(item.iteration);
            const toolName =
              item.toolCall?.tool ?? item.toolCall?.name ?? "";
            const args =
              item.toolCall?.arguments && typeof item.toolCall.arguments === "object"
                ? (item.toolCall.arguments as Record<string, unknown>)
                : {};
            const observation = item.observation;
            return (
              <li key={item.iteration} aria-label={`Iteration ${item.iteration}`}>
                <article>
                  <h5>Iteration {item.iteration}</h5>
                  {item.thought ? (
                    <section aria-label="Thought">
                      <h6>Thought</h6>
                      <p>{item.thought}</p>
                    </section>
                  ) : null}
                  {item.toolCall ? (
                    <section aria-label="Tool call">
                      <h6>Tool Call</h6>
                      <p>{toolName}</p>
                      {Object.keys(args).length > 0 ? (
                        <p aria-label="Tool arguments preview">
                          {argsPreview(args)}
                        </p>
                      ) : null}
                    </section>
                  ) : null}
                  {observation !== undefined ? (
                    <section aria-label="Observation">
                      <h6>Observation</h6>
                      {typeof observation.durationMs === "number" ? (
                        <p>{`Duration: ${observation.durationMs}ms`}</p>
                      ) : null}
                      {observation.isError ? (
                        <p role="alert">Tool error</p>
                      ) : null}
                      <p aria-label="Observation preview">
                        {renderValue(observation.output).slice(0, 500)}
                      </p>
                    </section>
                  ) : null}
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    aria-label={`Iteration ${item.iteration} details`}
                    onClick={() => toggle(item.iteration)}
                  >
                    {isOpen ? "Hide details" : "Show details"}
                  </button>
                  {isOpen ? (
                    <div>
                      {item.toolCall ? (
                        <pre aria-label="Tool arguments">
                          {JSON.stringify(args, null, 2)}
                        </pre>
                      ) : null}
                      {observation !== undefined ? (
                        <pre aria-label="Observation output">
                          {renderValue(observation.output)}
                        </pre>
                      ) : null}
                      {typeof item.durationMs === "number" ? (
                        <p>Step duration: {item.durationMs}ms</p>
                      ) : null}
                    </div>
                  ) : null}
                </article>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

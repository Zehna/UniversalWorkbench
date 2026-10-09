import { useState } from "react";
import type { AgentTraceItem } from "@uw/contracts";
import { formatTokenUsage } from "../send-to/send-to";

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
}: AgentTraceViewerProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const resolvedIterations = iterations ?? trace.length;

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
        {status}
      </span>
      {model ? <p>Model: {model}</p> : null}
      <p>
        Iterations: {resolvedIterations}
        {status === "iteration_limit_reached" ? " (limit reached)" : ""}
      </p>
      {usage ? (
        <p data-testid="agent-usage">
          Token usage: {formatTokenUsage(usage, usageSource)}
        </p>
      ) : null}
      {text ? <p>Final answer: {text}</p> : null}
      {trace.length === 0 ? (
        <p>No reasoning steps recorded.</p>
      ) : (
        <ol>
          {trace.map((item) => {
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

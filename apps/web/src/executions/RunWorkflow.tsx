import { useState, type FormEvent } from "react";
import type {
  ContextEnvelope,
  ContextType,
  ToolDescriptor,
} from "@uw/contracts";
import { api, type WorkflowVersion } from "../api/client";
import { findServerUnresolvableSecretRefs } from "../secrets/local-secrets";
import {
  descriptorFor,
  linearTypesCompatible,
  requiredPermissions,
} from "../tools/tool-catalog";
import { ExecutionStatus } from "./ExecutionStatus";

interface RunWorkflowProps {
  projectId: string;
  workflow: WorkflowVersion;
  tools: ToolDescriptor[];
  grantedPermissions: readonly string[];
  onBack(): void;
}

const userInputTypes: ContextType[] = ["text", "json", "markdown"];

export function RunWorkflow({
  projectId,
  workflow,
  tools,
  grantedPermissions,
  onBack,
}: RunWorkflowProps) {
  const nodes = workflow.definition.nodes;
  const first = nodes[0] ? descriptorFor(tools, nodes[0]) : undefined;
  const availableTypes = userInputTypes.filter((type) =>
    first?.accepts.includes(type),
  );
  const [inputType, setInputType] = useState<ContextType>(
    availableTypes[0] ?? "text",
  );
  const [payload, setPayload] = useState(inputType === "json" ? "{}" : "");
  const [executionId, setExecutionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const permissions = requiredPermissions(nodes, tools);
  const missing = permissions.filter(
    (value) => !grantedPermissions.includes(value),
  );
  const serverUnresolvable = findServerUnresolvableSecretRefs(
    workflow.definition,
  );
  const compatible =
    nodes.length > 0 && linearTypesCompatible(nodes, tools, inputType);
  const blocked =
    missing.length > 0 || !compatible || serverUnresolvable.length > 0;

  async function run(event: FormEvent) {
    event.preventDefault();
    if (blocked) return;
    let parsedPayload: unknown = payload;
    if (inputType === "json") {
      try {
        parsedPayload = JSON.parse(payload);
      } catch {
        setError("Enter valid JSON for the workflow input.");
        return;
      }
    }

    const context: ContextEnvelope = {
      id: crypto.randomUUID(),
      type: inputType,
      schemaVersion: 1,
      mimeType: inputType === "json" ? "application/json" : "text/plain",
      metadata: {},
      payload: parsedPayload,
      provenance: { sourceContextIds: [] },
      capabilities: [],
    };
    setBusy(true);
    setError(null);
    try {
      const started = await api.runWorkflow(
        projectId,
        workflow.workflowId,
        context,
      );
      setExecutionId(started.executionId);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not queue workflow",
      );
    } finally {
      setBusy(false);
    }
  }

  if (executionId) {
    return (
      <ExecutionStatus
        projectId={projectId}
        executionId={executionId}
        onBack={() => setExecutionId(null)}
      />
    );
  }

  return (
    <section aria-label="Run workflow">
      <button type="button" onClick={onBack}>
        Back to Workflows
      </button>
      <h3>Run {workflow.definition.name}</h3>
      <p>Saved workflow version {workflow.version}</p>
      <section
        aria-label="Preflight summary"
        style={{
          border: "1px solid #555",
          padding: 12,
          borderRadius: 12,
          marginBottom: 12,
        }}
      >
        <h4>Preflight summary</h4>
        <p>
          Steps: {nodes.length} · Required permissions:{" "}
          {permissions.join(", ") || "None"}
        </p>
        <p>
          Network:{" "}
          {permissions.includes("network") ? "Required" : "Not required"}
        </p>
        <p>
          Input/output compatibility:{" "}
          {compatible ? "Compatible" : "Incompatible"}
        </p>
        {missing.length > 0 ? (
          <p role="alert">
            Missing permission: {missing.join(", ")}. The server has not granted
            this workflow permission. You cannot run it until the server policy
            allows it.
          </p>
        ) : null}
        {serverUnresolvable.length > 0 ? (
          <p role="alert">
            server-unresolvable: {serverUnresolvable.join(", ")} stays on this
            device; server runs will fail. Use a vault secret for server
            execution.
          </p>
        ) : null}
        {blocked ? (
          <p>Preflight blocked. No execution will be queued.</p>
        ) : (
          <p>Preflight ready. The server will validate again before enqueue.</p>
        )}
      </section>
      <form onSubmit={(event) => void run(event)}>
        <label>
          Input type
          <select
            value={inputType}
            onChange={(event) => {
              const next = event.target.value as ContextType;
              setInputType(next);
              setPayload(next === "json" ? "{}" : "");
            }}
          >
            {availableTypes.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
        <label>
          Workflow input
          <textarea
            rows={5}
            value={payload}
            onChange={(event) => setPayload(event.target.value)}
            placeholder={
              inputType === "json" ? '{"value": 42}' : "Enter workflow input"
            }
          />
        </label>
        {error ? <p role="alert">{error}</p> : null}
        <button type="submit" disabled={blocked || busy}>
          {busy ? "Queuing…" : "Run workflow"}
        </button>
      </form>
    </section>
  );
}

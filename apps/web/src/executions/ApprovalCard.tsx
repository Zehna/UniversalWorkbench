import { useState } from "react";

export interface PendingApproval {
  tool?: string | undefined;
  name?: string | undefined;
  toolCallId?: string | undefined;
  id?: string | undefined;
  arguments?: Record<string, unknown> | undefined;
  args?: Record<string, unknown> | undefined;
  reason?: string | undefined;
}

interface ApprovalCardProps {
  projectId: string;
  executionId: string;
  pendingApprovals: PendingApproval[];
  onResolved?: ((decision: "approved" | "rejected") => void) | undefined;
}

function toolNameOf(entry: PendingApproval): string {
  if (typeof entry.tool === "string" && entry.tool.length > 0) return entry.tool;
  if (typeof entry.name === "string" && entry.name.length > 0) return entry.name;
  if (typeof entry.toolCallId === "string" && entry.toolCallId.length > 0)
    return entry.toolCallId;
  if (typeof entry.id === "string" && entry.id.length > 0) return entry.id;
  return "pending tool call";
}

function argsOf(entry: PendingApproval): Record<string, unknown> {
  if (entry.arguments && typeof entry.arguments === "object") return entry.arguments;
  if (entry.args && typeof entry.args === "object") return entry.args;
  return {};
}

function formatArgs(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args, null, 2) ?? "";
  } catch {
    return "";
  }
}

export function ApprovalCard({
  projectId,
  executionId,
  pendingApprovals,
  onResolved,
}: ApprovalCardProps) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [decision, setDecision] = useState<"approved" | "rejected" | null>(null);

  async function post(path: string, body: unknown): Promise<void> {
    const response = await fetch(`/api/projects/${projectId}/executions/${executionId}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      let message = "Request failed";
      try {
        const data = (await response.json()) as {
          error?: { message?: unknown };
        };
        if (typeof data?.error?.message === "string") message = data.error.message;
      } catch {
        // Keep default message.
      }
      throw new Error(message);
    }
  }

  async function approve() {
    setBusy("approve");
    setError(null);
    try {
      await post("/approve", {});
      setDecision("approved");
      onResolved?.("approved");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Approval failed");
    } finally {
      setBusy(null);
    }
  }

  async function reject() {
    setBusy("reject");
    setError(null);
    try {
      const trimmed = reason.trim();
      await post("/reject", trimmed.length > 0 ? { reason: trimmed } : {});
      setDecision("rejected");
      onResolved?.("rejected");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Rejection failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-label="Approval required">
      <h4>Awaiting approval</h4>
      {pendingApprovals.length === 0 ? (
        <p>No pending tool calls.</p>
      ) : (
        <ul>
          {pendingApprovals.map((entry, index) => {
            const name = toolNameOf(entry);
            const args = argsOf(entry);
            const key =
              entry.toolCallId ?? entry.id ?? `${name}:${index}`;
            return (
              <li key={key}>
                <p>{name}</p>
                {Object.keys(args).length > 0 ? (
                  <pre aria-label="Pending tool arguments">
                    {formatArgs(args)}
                  </pre>
                ) : null}
                {typeof entry.reason === "string" && entry.reason.length > 0 ? (
                  <p>Reason: {entry.reason}</p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {decision ? (
        <p role="status">Decision recorded: {decision}</p>
      ) : (
        <>
          <label>
            Rejection reason
            <input
              type="text"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Optional reason"
            />
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void approve()}
            >
              {busy === "approve" ? "Approving…" : "Approve"}
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void reject()}
            >
              {busy === "reject" ? "Rejecting…" : "Reject"}
            </button>
          </div>
        </>
      )}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}

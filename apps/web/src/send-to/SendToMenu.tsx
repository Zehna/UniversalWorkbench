import { useState } from "react";
import type { ContextEnvelope, ToolDescriptor } from "@uw/contracts";
import { api } from "../api/client";
import { sendToCandidates } from "./send-to";

interface SendToMenuProps {
  output: ContextEnvelope;
  projectId: string;
  /** Present for execution outputs; absent for plain notes. */
  executionId?: string;
  outputId?: string;
  tools: readonly ToolDescriptor[];
  grantedPermissions: readonly string[];
  onSelectTool?(toolId: string, toolVersion: string): void;
}

export function SendToMenu({
  output,
  projectId,
  executionId,
  outputId,
  tools,
  grantedPermissions,
  onSelectTool,
}: SendToMenuProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [savedArtifact, setSavedArtifact] = useState<string | null>(null);

  const candidates = sendToCandidates(
    output.type,
    tools,
    grantedPermissions,
  ).filter((candidate) => {
    // Note/artifact saves need a server-side execution record to read from.
    if (candidate.kind !== "tool" && (!executionId || !outputId)) return false;
    return true;
  });

  if (candidates.length === 0) return null;

  async function saveNote() {
    if (!executionId || !outputId) return;
    setBusy(true);
    setError(null);
    try {
      const document = await api.saveNoteFromExecution(
        projectId,
        executionId,
        outputId,
      );
      setSavedNote(document.document.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save note");
    } finally {
      setBusy(false);
    }
  }

  async function saveArtifact() {
    if (!executionId || !outputId) return;
    setBusy(true);
    setError(null);
    try {
      const artifact = await api.saveExecutionOutput(
        projectId,
        executionId,
        outputId,
      );
      setSavedArtifact(artifact.id);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not save artifact",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Send to">
      <h4>Send to…</h4>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {candidates.map((candidate) =>
          candidate.kind === "note" ? (
            <button
              key="note"
              type="button"
              disabled={busy}
              onClick={() => void saveNote()}
            >
              Save as Note
            </button>
          ) : candidate.kind === "artifact" ? (
            <button
              key="artifact"
              type="button"
              disabled={busy}
              onClick={() => void saveArtifact()}
            >
              Save as Artifact
            </button>
          ) : (
            <button
              key={`${candidate.toolId}@${candidate.toolVersion}`}
              type="button"
              onClick={() =>
                candidate.toolId &&
                onSelectTool?.(candidate.toolId, candidate.toolVersion ?? "")
              }
              title={candidate.detail}
            >
              {candidate.label}
            </button>
          ),
        )}
      </div>
      {savedNote ? <p role="status">Note saved: {savedNote}</p> : null}
      {savedArtifact ? (
        <p role="status">Artifact saved: {savedArtifact}</p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}

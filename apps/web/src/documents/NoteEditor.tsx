import { useEffect, useState, type FormEvent } from "react";
import type { NoteDocumentView } from "@uw/contracts";
import type { LocalConflictRecord } from "../local/store";
import { useSyncRuntime } from "../sync/runtime";

interface NoteEditorProps {
  projectId: string;
  initial?: NoteDocumentView;
  conflict?: LocalConflictRecord | undefined;
  onSaved(view: NoteDocumentView): void;
}

export function NoteEditor({
  projectId,
  initial,
  conflict,
  onSaved,
}: NoteEditorProps) {
  const { coordinator } = useSyncRuntime();
  const [view, setView] = useState(initial);
  const [title, setTitle] = useState(initial?.document.title ?? "");
  const [body, setBody] = useState(initial?.revision.content.body ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const initialDocumentId = initial?.document.id;
  const initialRevisionId = initial?.revision.id;

  useEffect(() => {
    setView(initial);
    setTitle(initial?.document.title ?? "");
    setBody(initial?.revision.content.body ?? "");
  }, [initial, initialDocumentId, initialRevisionId]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const saved = view
        ? await coordinator.updateNote(view, {
            title,
            body,
            baseRevisionId: view.revision.id,
          })
        : await coordinator.createNote(projectId, { title, body });
      setView(saved);
      setTitle(saved.document.title);
      setBody(saved.revision.content.body);
      onSaved(saved);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save note");
    } finally {
      setBusy(false);
    }
  }

  async function resolveConflict(strategy: "keep-local" | "use-server") {
    if (!conflict) return;
    setBusy(true);
    setError(null);
    try {
      const resolved = await coordinator.resolveNoteConflict(
        conflict.operationId,
        strategy,
      );
      setView(resolved);
      setTitle(resolved.document.title);
      setBody(resolved.revision.content.body);
      onSaved(resolved);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to resolve conflict",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save}>
      <label>
        Note title
        <input
          required
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <label>
        Note body
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={12}
        />
      </label>
      {conflict ? (
        <div role="alert">
          <p>
            Sync conflict detected. Your local edit has been preserved on this
            device.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void resolveConflict("keep-local")}
          >
            Keep local and retry
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void resolveConflict("use-server")}
          >
            Use server version
          </button>
        </div>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      <button type="submit" disabled={busy}>
        {busy ? "Saving…" : "Save Note"}
      </button>
    </form>
  );
}

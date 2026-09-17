import { useEffect, useState, type FormEvent } from "react";
import type { NoteDocumentView } from "@uw/contracts";
import { ApiError, api } from "../api/client";

interface NoteEditorProps {
  projectId: string;
  initial?: NoteDocumentView;
  onSaved(view: NoteDocumentView): void;
}

export function NoteEditor({ projectId, initial, onSaved }: NoteEditorProps) {
  const [view, setView] = useState(initial);
  const [title, setTitle] = useState(initial?.document.title ?? "");
  const [body, setBody] = useState(initial?.revision.content.body ?? "");
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setView(initial);
    setTitle(initial?.document.title ?? "");
    setBody(initial?.revision.content.body ?? "");
    setConflict(false);
  }, [initial]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setConflict(false);
    try {
      const saved = view
        ? await api.updateNote(projectId, view.document.id, {
            title,
            body,
            baseRevisionId: view.revision.id,
          })
        : await api.createNote(projectId, { title, body });
      setView(saved);
      setTitle(saved.document.title);
      setBody(saved.revision.content.body);
      onSaved(saved);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        setConflict(true);
      } else {
        setError(cause instanceof ApiError ? cause.message : "Unable to save note");
      }
    } finally {
      setBusy(false);
    }
  }

  async function reloadCurrent() {
    if (!view) return;
    try {
      const current = await api.getDocument(projectId, view.document.id);
      setView(current);
      setTitle(current.document.title);
      setBody(current.revision.content.body);
      setConflict(false);
      onSaved(current);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Unable to reload note");
    }
  }

  return (
    <form onSubmit={save}>
      <label>
        Note title
        <input required value={title} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <label>
        Note body
        <textarea value={body} onChange={(event) => setBody(event.target.value)} rows={12} />
      </label>
      {conflict ? (
        <div role="alert">
          <p>A newer revision exists. Your local edit has been preserved.</p>
          <button type="button" onClick={reloadCurrent}>Reload current</button>
        </div>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      <button type="submit" disabled={busy}>{busy ? "Saving…" : "Save Note"}</button>
    </form>
  );
}

import { useEffect, useState } from "react";
import type { NoteDocument, NoteDocumentView, Project } from "@uw/contracts";
import { api } from "../api/client";
import { NoteEditor } from "../documents/NoteEditor";

interface ProjectWorkspaceProps {
  project: Project;
  onBack(): void;
}

export function ProjectWorkspace({ project, onBack }: ProjectWorkspaceProps) {
  const [documents, setDocuments] = useState<NoteDocument[]>([]);
  const [selected, setSelected] = useState<NoteDocumentView | undefined>();
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let active = true;
    void api.listDocuments(project.id).then((items) => {
      if (active) setDocuments(items);
    });
    return () => {
      active = false;
    };
  }, [project.id]);

  async function selectDocument(document: NoteDocument) {
    const view = await api.getDocument(project.id, document.id);
    setSelected(view);
    setCreating(false);
  }

  function saved(view: NoteDocumentView) {
    setSelected(view);
    setCreating(false);
    setDocuments((current) => {
      const without = current.filter((item) => item.id !== view.document.id);
      return [...without, view.document];
    });
  }

  return (
    <section>
      <button type="button" onClick={onBack}>
        Back to projects
      </button>
      <h2>{project.name}</h2>
      <div>
        <h3>Notes</h3>
        <button
          type="button"
          onClick={() => {
            setCreating(true);
            setSelected(undefined);
          }}
        >
          New Note
        </button>
        {documents.map((document) => (
          <button
            key={document.id}
            type="button"
            onClick={() => void selectDocument(document)}
          >
            {document.title}
          </button>
        ))}
      </div>
      {selected ? (
        <NoteEditor
          key={selected.document.id}
          projectId={project.id}
          initial={selected}
          onSaved={saved}
        />
      ) : creating ? (
        <NoteEditor key="new" projectId={project.id} onSaved={saved} />
      ) : (
        <p>Select a note or create a new one.</p>
      )}
    </section>
  );
}

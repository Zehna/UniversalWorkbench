import { useEffect, useState } from "react";
import type {
  ContextEnvelope,
  NoteDocumentView,
  Project,
  ToolDescriptor,
} from "@uw/contracts";
import type { LocalConflictRecord } from "../local/store";
import { api } from "../api/client";
import { NoteEditor } from "../documents/NoteEditor";
import { SendToMenu } from "../send-to/SendToMenu";
import { WorkflowList } from "../workflows/WorkflowList";
import { useSyncRuntime } from "../sync/runtime";

interface ProjectWorkspaceProps {
  project: Project;
  onBack(): void;
}

export function ProjectWorkspace({ project, onBack }: ProjectWorkspaceProps) {
  const { coordinator, status } = useSyncRuntime();
  const [notes, setNotes] = useState<NoteDocumentView[]>([]);
  const [conflicts, setConflicts] = useState<LocalConflictRecord[]>([]);
  const [selected, setSelected] = useState<NoteDocumentView | undefined>();
  const [creating, setCreating] = useState(false);
  const [tab, setTab] = useState<"notes" | "workflows">("notes");
  const [error, setError] = useState<string | null>(null);
  const [tools, setTools] = useState<ToolDescriptor[]>([]);
  const [grantedPermissions, setGrantedPermissions] = useState<string[]>([]);
  const [sendToFor, setSendToFor] = useState<string | null>(null);
  const [toolHint, setToolHint] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void api
      .listTools()
      .then((catalog) => {
        if (!active) return;
        setTools(catalog.tools);
        setGrantedPermissions(catalog.grantedPermissions);
      })
      .catch(() => {
        if (active) {
          setTools([]);
          setGrantedPermissions([]);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  function noteContext(note: NoteDocumentView): ContextEnvelope {
    return {
      id: note.document.id,
      type: "markdown",
      schemaVersion: 1,
      mimeType: "text/markdown",
      metadata: {},
      payload: note.revision.content.body,
      provenance: { sourceContextIds: [] },
      capabilities: [],
    };
  }

  useEffect(() => {
    let active = true;
    void Promise.all([
      coordinator.listNotes(project.id),
      coordinator.listConflicts(),
    ])
      .then(([nextNotes, nextConflicts]) => {
        if (!active) return;
        setNotes(nextNotes);
        setConflicts(
          nextConflicts.filter(
            (conflict) =>
              conflict.change.entityType === "document" &&
              nextNotes.some(
                (note) => note.document.id === conflict.change.entityId,
              ),
          ),
        );
      })
      .catch((cause) => {
        if (active) {
          setError(
            cause instanceof Error ? cause.message : "Unable to load workspace",
          );
        }
      });

    return () => {
      active = false;
    };
  }, [coordinator, project.id, status]);

  function saved(view: NoteDocumentView) {
    setSelected(view);
    setCreating(false);
    setNotes((current) => {
      const without = current.filter(
        (item) => item.document.id !== view.document.id,
      );
      return [...without, view];
    });
    void coordinator.listConflicts().then(setConflicts);
  }

  const selectedConflict = selected
    ? conflicts.find(
        (conflict) => conflict.change.entityId === selected.document.id,
      )
    : undefined;

  return (
    <section>
      <button type="button" onClick={onBack}>
        Back to projects
      </button>
      <h2>{project.name}</h2>
      {error ? <p role="alert">{error}</p> : null}
      <nav
        aria-label="Project tabs"
        style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === "notes"}
          onClick={() => setTab("notes")}
        >
          Notes
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "workflows"}
          onClick={() => setTab("workflows")}
        >
          Workflows
        </button>
      </nav>
      {tab === "workflows" ? (
        <WorkflowList projectId={project.id} />
      ) : (
        <>
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
            {notes.map((note) => (
              <div key={note.document.id}>
                <button
                  type="button"
                  onClick={() => {
                    setSelected(note);
                    setCreating(false);
                  }}
                >
                  {note.document.title}
                </button>{" "}
                <button
                  type="button"
                  aria-expanded={sendToFor === note.document.id}
                  onClick={() =>
                    setSendToFor((current) =>
                      current === note.document.id ? null : note.document.id,
                    )
                  }
                >
                  Send to…
                </button>
                {sendToFor === note.document.id ? (
                  <SendToMenu
                    output={noteContext(note)}
                    projectId={project.id}
                    tools={tools}
                    grantedPermissions={grantedPermissions}
                    onSelectTool={(toolId) =>
                      setToolHint(
                        `Open Workflows to build a ${toolId} step for this note.`,
                      )
                    }
                  />
                ) : null}
              </div>
            ))}
            {toolHint ? <p role="status">{toolHint}</p> : null}
          </div>
          {selected ? (
            <NoteEditor
              key={selected.document.id}
              projectId={project.id}
              initial={selected}
              conflict={selectedConflict}
              onSaved={saved}
            />
          ) : creating ? (
            <NoteEditor key="new" projectId={project.id} onSaved={saved} />
          ) : (
            <p>Select a note or create a new one.</p>
          )}
        </>
      )}
    </section>
  );
}

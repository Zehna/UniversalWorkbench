import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type {
  NoteDocumentView,
  OwnerPublic,
  Project,
  SyncChange,
} from "@uw/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import type { LocalConflictRecord } from "../src/local/store";
import type { SyncCoordinator } from "../src/sync/coordinator";
import type { SyncCoordinatorFactory } from "../src/sync/runtime";
import type { SyncStatus, SyncStatusListener } from "../src/sync/status";

const OWNER: OwnerPublic = {
  id: "11111111-1111-4111-8111-111111111111",
  username: "owner",
  createdAt: "2026-09-18T00:00:00.000Z",
};

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

function createUiCoordinator(): SyncCoordinator {
  const projects: Project[] = [];
  const notes: NoteDocumentView[] = [];
  const conflicts: LocalConflictRecord[] = [];
  const listeners = new Set<SyncStatusListener>();
  let status: SyncStatus = { state: "local-only" };
  let revision = 0;

  function publish(next: SyncStatus) {
    status = next;
    for (const listener of listeners) listener(next);
  }

  return {
    async start() {
      publish({ state: "offline", pending: 0 });
    },
    async stop() {},
    status() {
      return status;
    },
    async diagnostics() {
      return {
        deviceId: "22222222-2222-4222-8222-222222222222",
        backend: "indexeddb" as const,
        cursor: "0",
        pendingOperations: 0,
        conflicts: 0,
        websocketState: "open" as const,
        lastAckAt: null,
        lastErrorCode: null,
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(status);
      return () => listeners.delete(listener);
    },
    async listProjects() {
      return structuredClone(projects);
    },
    async listNotes(projectId) {
      return structuredClone(
        notes.filter((note) => note.document.projectId === projectId),
      );
    },
    async getNote(documentId) {
      return structuredClone(
        notes.find((note) => note.document.id === documentId) ?? null,
      );
    },
    async listWorkflows() {
      return [];
    },
    async getWorkflow() {
      return null;
    },
    async workflowRunEligibility() {
      return { state: "missing" as const };
    },
    async listConflicts() {
      return structuredClone(conflicts);
    },
    async resolveNoteConflict(operationId, strategy) {
      const index = conflicts.findIndex(
        (conflict) => conflict.operationId === operationId,
      );
      if (index < 0) throw new Error("Conflict not found");
      const conflict = conflicts[index]!;
      const note = notes.find(
        (item) => item.document.id === conflict.change.entityId,
      );
      if (!note) throw new Error("Note not found");

      if (strategy === "use-server") {
        const current = conflict.change.payload.current as {
          title: string;
          body: string;
          currentRevisionId: string;
        };
        note.document.title = current.title;
        note.document.currentRevisionId = current.currentRevisionId;
        note.revision = {
          ...note.revision,
          id: current.currentRevisionId,
          content: { body: current.body },
        };
      }

      conflicts.splice(index, 1);
      publish({ state: "offline", pending: 0 });
      return structuredClone(note);
    },
    async createProject(input) {
      const now = "2026-09-19T00:00:00.000Z";
      const project: Project = {
        id: "22222222-2222-4222-8222-222222222222",
        ownerId: OWNER.id,
        name: input.name,
        description: input.description ?? null,
        schemaVersion: 1,
        createdAt: now,
        updatedAt: now,
      };
      projects.push(project);
      publish({ state: "offline", pending: 1 });
      return structuredClone(project);
    },
    async createNote(projectId, input) {
      const now = "2026-09-19T00:00:00.000Z";
      const id = "55555555-5555-4555-8555-555555555555";
      const revisionId = "33333333-3333-4333-8333-333333333333";
      const note: NoteDocumentView = {
        document: {
          id,
          projectId,
          kind: "note",
          title: input.title,
          currentRevisionId: revisionId,
          createdAt: now,
          updatedAt: now,
        },
        revision: {
          id: revisionId,
          documentId: id,
          revisionNumber: 1,
          parentRevisionId: null,
          content: { body: input.body },
          metadata: {},
          createdAt: now,
        },
      };
      notes.push(note);
      publish({ state: "offline", pending: 2 });
      return structuredClone(note);
    },
    async updateNote(view, input) {
      revision += 1;
      const note = notes.find((item) => item.document.id === view.document.id);
      if (!note) throw new Error("Note not found");
      const revisionId = `77777777-7777-4777-8777-77777777777${revision}`;
      note.document.title = input.title;
      note.document.currentRevisionId = revisionId;
      note.revision = {
        id: revisionId,
        documentId: note.document.id,
        revisionNumber: note.revision.revisionNumber + 1,
        parentRevisionId: view.revision.id,
        content: { body: input.body },
        metadata: {},
        createdAt: "2026-09-19T00:01:00.000Z",
      };

      const change: SyncChange = {
        cursor: "9",
        operationId: "99999999-9999-4999-8999-999999999999",
        entityType: "document",
        entityId: note.document.id,
        kind: "conflict",
        revision: "44444444-4444-4444-8444-444444444444",
        payload: {
          current: {
            title: "Sources",
            body: "Server edit",
            currentRevisionId: "44444444-4444-4444-8444-444444444444",
          },
        },
        createdAt: "2026-09-19T00:02:00.000Z",
      };
      conflicts.push({
        operationId: change.operationId,
        change,
        createdAt: change.createdAt,
      });
      publish({ state: "conflict", pending: 0, conflicts: 1 });
      return structuredClone(note);
    },
    async resolveWorkflowConflict() {
      throw new Error("workflow UI is not part of this test");
    },
    async createWorkflow() {
      throw new Error("workflow UI is not part of this test");
    },
    async updateWorkflow() {
      throw new Error("workflow UI is not part of this test");
    },
    async handleServerMessage() {},
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Phase 2 local-first PWA flow", () => {
  it("shows login and keeps the password transient when login fails", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";

        if (url.endsWith("/setup/status")) {
          return jsonResponse({ initialized: true });
        }
        if (url.endsWith("/auth/session")) {
          return jsonResponse(
            {
              error: {
                code: "UNAUTHORIZED",
                message: "Authentication required",
              },
            },
            401,
          );
        }
        if (url.endsWith("/auth/login") && method === "POST") {
          return jsonResponse(
            {
              error: {
                code: "INVALID_CREDENTIALS",
                message: "Invalid credentials",
              },
            },
            401,
          );
        }

        throw new Error(`Unexpected fetch: ${method} ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: /sign in/i }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/username/i), {
      target: { value: "owner" },
    });
    fireEvent.change(screen.getByLabelText(/^password$/i), {
      target: { value: "wrong-password-value" },
    });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

    expect(await screen.findByText(/invalid credentials/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^password$/i)).toHaveValue("");
  });

  it("writes project and note locally, then preserves the draft on conflict", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";

        if (url.endsWith("/setup/status")) {
          return jsonResponse({ initialized: false });
        }
        if (url.endsWith("/setup/owner") && method === "POST") {
          return jsonResponse({ owner: OWNER }, 201);
        }

        throw new Error(`Unexpected fetch: ${method} ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const coordinator = createUiCoordinator();
    const syncFactory: SyncCoordinatorFactory = async () => coordinator;

    render(<App syncFactory={syncFactory} />);

    expect(
      await screen.findByRole("heading", { name: /create owner/i }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/username/i), {
      target: { value: "owner" },
    });
    fireEvent.change(screen.getByLabelText(/^password$/i), {
      target: { value: "a-very-secure-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create owner/i }));

    expect(
      await screen.findByRole("heading", { name: /projects/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/sync status/i)).toHaveTextContent("Offline");

    fireEvent.change(screen.getByLabelText(/project name/i), {
      target: { value: "Research" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create project/i }));

    expect(
      await screen.findByRole("heading", { name: "Research" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /new note/i }));
    fireEvent.change(screen.getByLabelText(/note title/i), {
      target: { value: "Sources" },
    });
    fireEvent.change(screen.getByLabelText(/note body/i), {
      target: { value: "First note" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save note/i }));

    expect(
      await screen.findByRole("button", { name: "Sources" }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/note body/i), {
      target: { value: "My local edit" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save note/i }));

    expect(
      await screen.findByText(/sync conflict detected/i),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("My local edit")).toBeInTheDocument();
    expect(screen.getByLabelText(/sync status/i)).toHaveTextContent("Conflict");

    fireEvent.click(
      screen.getByRole("button", { name: /use server version/i }),
    );
    await waitFor(() =>
      expect(screen.getByDisplayValue("Server edit")).toBeInTheDocument(),
    );
  });
});

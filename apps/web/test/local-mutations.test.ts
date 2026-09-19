import { describe, expect, it } from "vitest";
import type {
  CreateNoteRequest,
  CreateProjectRequest,
  NoteDocumentView,
  Project,
  UpdateNoteRequest,
  UpdateProjectRequest,
  SyncOperation,
} from "@uw/contracts";
import type {
  LocalDeviceRecord,
  LocalStore,
  LocalTransaction,
} from "../src/local/store";
import {
  createNoteLocally,
  createProjectLocally,
  updateNoteLocally,
  updateProjectLocally,
} from "../src/local/mutations";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-09-18T18:00:00.000Z";

const device = {
  id: "55555555-5555-4555-8555-555555555555",
  ownerId: OWNER_ID,
  label: "test-device",
  createdAt: NOW,
} satisfies LocalDeviceRecord;

class MemoryLocalStore implements LocalStore {
  private projects = new Map<string, Project>();
  private notes = new Map<string, NoteDocumentView>();
  private operations = new Map<string, SyncOperation>();
  readonly failOnAppend: boolean;

  constructor(options: { failOnAppend?: boolean } = {}) {
    this.failOnAppend = options.failOnAppend ?? false;
  }

  async transaction<T>(fn: (tx: LocalTransaction) => Promise<T>): Promise<T> {
    const projects = new Map(this.projects);
    const notes = new Map(this.notes);
    const operations = new Map(this.operations);

    const tx: LocalTransaction = {
      async upsertProject(project) {
        projects.set(project.id, structuredClone(project));
      },
      async upsertNote(note) {
        notes.set(note.document.id, structuredClone(note));
      },
      async putTombstone() {},
      appendOperation: async (operation) => {
        if (this.failOnAppend) throw new Error("append failed");
        operations.set(operation.id, structuredClone(operation));
      },
    };

    const result = await fn(tx);
    this.projects = projects;
    this.notes = notes;
    this.operations = operations;
    return result;
  }

  async getDevice() {
    return device;
  }

  async setDevice() {}

  async getCursor() {
    return "0";
  }

  async setCursor() {}

  async listProjects() {
    return [...this.projects.values()].map((value) => structuredClone(value));
  }

  async listNotes(projectId: string) {
    return [...this.notes.values()]
      .filter((value) => value.document.projectId === projectId)
      .map((value) => structuredClone(value));
  }

  async listPendingOperations(limit: number) {
    return [...this.operations.values()]
      .slice(0, limit)
      .map((value) => structuredClone(value));
  }

  async markOperationAcked() {}

  async applyRemoteChange() {}

  async listConflicts() {
    return [];
  }

  async clearConflict() {}

  async close() {}

  async getNote(documentId: string) {
    return structuredClone(this.notes.get(documentId) ?? null);
  }
}

function existingProject(): Project {
  return {
    id: PROJECT_ID,
    ownerId: OWNER_ID,
    name: "Original",
    description: null,
    schemaVersion: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe("atomic local mutations", () => {
  it("rolls back the local project if appending its operation fails", async () => {
    const store = new MemoryLocalStore({ failOnAppend: true });
    const input: CreateProjectRequest = { name: "Offline" };

    await expect(createProjectLocally(store, device, input)).rejects.toThrow(
      "append failed",
    );

    expect(await store.listProjects()).toEqual([]);
  });

  it("creates stable local project IDs referenced by the pending operation", async () => {
    const store = new MemoryLocalStore();
    const project = await createProjectLocally(store, device, {
      name: "Offline",
    });

    const [operation] = await store.listPendingOperations(10);
    expect(operation).toMatchObject({
      deviceId: device.id,
      projectId: project.id,
      entityType: "project",
      entityId: project.id,
      action: "project.create",
      baseRevision: null,
      payload: { name: "Offline" },
    });
    expect(project.ownerId).toBe(OWNER_ID);
  });

  it("uses the explicit server revision token for local project updates", async () => {
    const store = new MemoryLocalStore();
    const project = existingProject();
    await store.transaction((tx) => tx.upsertProject(project));

    const input: UpdateProjectRequest = { name: "Renamed" };
    const updated = await updateProjectLocally(
      store,
      device,
      project,
      "7",
      input,
    );

    const [operation] = await store.listPendingOperations(10);
    expect(updated.name).toBe("Renamed");
    expect(operation).toMatchObject({
      entityId: PROJECT_ID,
      action: "project.update",
      baseRevision: "7",
      payload: input,
    });
  });

  it("creates and updates notes with immutable local revision lineage", async () => {
    const store = new MemoryLocalStore();
    const createInput: CreateNoteRequest = { title: "Note", body: "first" };
    const created = await createNoteLocally(
      store,
      device,
      PROJECT_ID,
      createInput,
    );

    const updateInput: UpdateNoteRequest = {
      title: "Note",
      body: "second",
      baseRevisionId: created.revision.id,
    };
    const updated = await updateNoteLocally(
      store,
      device,
      created,
      updateInput,
    );

    const operations = await store.listPendingOperations(10);
    expect(operations).toHaveLength(2);
    expect(operations[0]).toMatchObject({
      entityId: created.document.id,
      action: "document.create",
      baseRevision: null,
      payload: createInput,
    });
    expect(operations[1]).toMatchObject({
      entityId: created.document.id,
      action: "document.update",
      baseRevision: created.revision.id,
      payload: {
        title: "Note",
        body: "second",
      },
    });
    expect(updated.revision.parentRevisionId).toBe(created.revision.id);
    expect(updated.revision.revisionNumber).toBe(2);
    expect(
      (await store.getNote(created.document.id))?.revision.content.body,
    ).toBe("second");
  });
});

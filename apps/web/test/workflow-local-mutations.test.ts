import { describe, expect, it } from "vitest";
import type {
  NoteDocumentView,
  Project,
  SyncChange,
  SyncOperation,
  WorkflowDefinitionV1,
  WorkflowDocumentView,
} from "@uw/contracts";
import type {
  LocalDeviceRecord,
  LocalStore,
  LocalTransaction,
} from "../src/local/store";
import {
  createWorkflowLocally,
  updateWorkflowLocally,
} from "../src/local/mutations";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-09-19T15:00:00.000Z";

const device: LocalDeviceRecord = {
  id: "55555555-5555-4555-8555-555555555555",
  ownerId: OWNER_ID,
  label: "test-device",
  createdAt: NOW,
};

const workflow: WorkflowDefinitionV1 = {
  schemaVersion: 1,
  name: "Local workflow",
  nodes: [],
  edges: [],
  outputs: [],
};

class MemoryStore implements LocalStore {
  readonly backend = "indexeddb" as const;
  private projects = new Map<string, Project>();
  private notes = new Map<string, NoteDocumentView>();
  private workflows = new Map<string, WorkflowDocumentView>();
  private operations: SyncOperation[] = [];

  async transaction<T>(fn: (tx: LocalTransaction) => Promise<T>): Promise<T> {
    const projects = new Map(this.projects);
    const notes = new Map(this.notes);
    const workflows = new Map(this.workflows);
    const operations = [...this.operations];

    const tx: LocalTransaction = {
      async upsertProject(project) {
        projects.set(project.id, structuredClone(project));
      },
      async upsertNote(note) {
        notes.set(note.document.id, structuredClone(note));
      },
      async upsertWorkflow(value) {
        workflows.set(value.document.id, structuredClone(value));
      },
      async putTombstone() {},
      async appendOperation(operation) {
        operations.push(structuredClone(operation));
      },
    };

    const result = await fn(tx);
    this.projects = projects;
    this.notes = notes;
    this.workflows = workflows;
    this.operations = operations;
    return result;
  }

  async getDevice() { return device; }
  async setDevice() {}
  async getCursor() { return "0"; }
  async setCursor() {}
  async listProjects() { return [...this.projects.values()]; }
  async listNotes() { return [...this.notes.values()]; }
  async getNote(id: string) { return this.notes.get(id) ?? null; }
  async listWorkflows(projectId: string) {
    return [...this.workflows.values()].filter(
      (value) => value.document.projectId === projectId,
    );
  }
  async getWorkflow(id: string) { return this.workflows.get(id) ?? null; }
  async listPendingOperations(limit: number) {
    return this.operations.slice(0, limit);
  }
  async markOperationAcked() {}
  async applyRemoteChange(_change: SyncChange) {}
  async listConflicts() { return []; }
  async clearConflict() {}
  async close() {}
}

describe("local workflow mutations", () => {
  it("creates workflow revision 1 and journals a discriminated document operation", async () => {
    const store = new MemoryStore();
    const created = await createWorkflowLocally(
      store,
      device,
      PROJECT_ID,
      { title: "Local workflow", workflow },
    );

    const [operation] = await store.listPendingOperations(10);
    expect(created.document.kind).toBe("workflow");
    expect(created.revision.content).toEqual({
      kind: "workflow",
      workflow,
    });
    expect(operation).toMatchObject({
      entityType: "document",
      entityId: created.document.id,
      action: "document.create",
      baseRevision: null,
      payload: {
        kind: "workflow",
        title: "Local workflow",
        workflow,
      },
    });
  });

  it("updates workflow with immutable local revision lineage", async () => {
    const store = new MemoryStore();
    const created = await createWorkflowLocally(
      store,
      device,
      PROJECT_ID,
      { title: "Local workflow", workflow },
    );
    const updated = await updateWorkflowLocally(
      store,
      device,
      created,
      {
        title: "Local workflow v2",
        workflow: { ...workflow, name: "Local workflow v2" },
        baseRevisionId: created.revision.id,
      },
    );

    expect(updated.revision.revisionNumber).toBe(2);
    expect(updated.revision.parentRevisionId).toBe(created.revision.id);
    expect(await store.getWorkflow(created.document.id)).toEqual(updated);

    const operations = await store.listPendingOperations(10);
    expect(operations[1]).toMatchObject({
      action: "document.update",
      baseRevision: created.revision.id,
      payload: {
        kind: "workflow",
        title: "Local workflow v2",
      },
    });
  });
});

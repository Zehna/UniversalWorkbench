import type {
  CreateNoteRequest,
  CreateProjectRequest,
  NoteDocumentView,
  Project,
  SyncOperation,
  UpdateNoteRequest,
  UpdateProjectRequest,
} from "@uw/contracts";
import type { LocalDeviceRecord, LocalStore } from "./store";

function nowIso(): string {
  return new Date().toISOString();
}

function operationId(): string {
  return crypto.randomUUID();
}

function assertProjectOwner(
  device: LocalDeviceRecord,
  project: Project,
): void {
  if (device.ownerId !== project.ownerId) {
    throw new Error("Local device owner does not match project owner");
  }
}

export async function createProjectLocally(
  store: LocalStore,
  device: LocalDeviceRecord,
  input: CreateProjectRequest,
): Promise<Project> {
  const now = nowIso();
  const projectId = crypto.randomUUID();
  const project: Project = {
    id: projectId,
    ownerId: device.ownerId,
    name: input.name,
    description: input.description ?? null,
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
  };
  const operation: SyncOperation = {
    id: operationId(),
    deviceId: device.id,
    projectId,
    entityType: "project",
    entityId: projectId,
    action: "project.create",
    baseRevision: null,
    payload: { ...input },
    createdAt: now,
  };

  await store.transaction(async (tx) => {
    await tx.upsertProject(project);
    await tx.appendOperation(operation);
  });

  return project;
}

export async function updateProjectLocally(
  store: LocalStore,
  device: LocalDeviceRecord,
  project: Project,
  baseRevision: string,
  input: UpdateProjectRequest,
): Promise<Project> {
  assertProjectOwner(device, project);
  const now = nowIso();
  const updated: Project = {
    ...project,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined
      ? { description: input.description }
      : {}),
    updatedAt: now,
  };
  const operation: SyncOperation = {
    id: operationId(),
    deviceId: device.id,
    projectId: project.id,
    entityType: "project",
    entityId: project.id,
    action: "project.update",
    baseRevision,
    payload: { ...input },
    createdAt: now,
  };

  await store.transaction(async (tx) => {
    await tx.upsertProject(updated);
    await tx.appendOperation(operation);
  });

  return updated;
}

export async function createNoteLocally(
  store: LocalStore,
  device: LocalDeviceRecord,
  projectId: string,
  input: CreateNoteRequest,
): Promise<NoteDocumentView> {
  const now = nowIso();
  const documentId = crypto.randomUUID();
  const revisionId = crypto.randomUUID();
  const note: NoteDocumentView = {
    document: {
      id: documentId,
      projectId,
      kind: "note",
      title: input.title,
      currentRevisionId: revisionId,
      createdAt: now,
      updatedAt: now,
    },
    revision: {
      id: revisionId,
      documentId,
      revisionNumber: 1,
      parentRevisionId: null,
      content: { body: input.body },
      metadata: {},
      createdAt: now,
    },
  };
  const operation: SyncOperation = {
    id: operationId(),
    deviceId: device.id,
    projectId,
    entityType: "document",
    entityId: documentId,
    action: "document.create",
    baseRevision: null,
    payload: { ...input },
    createdAt: now,
  };

  await store.transaction(async (tx) => {
    await tx.upsertNote(note);
    await tx.appendOperation(operation);
  });

  return note;
}

export async function updateNoteLocally(
  store: LocalStore,
  device: LocalDeviceRecord,
  current: NoteDocumentView,
  input: UpdateNoteRequest,
): Promise<NoteDocumentView> {
  if (input.baseRevisionId !== current.revision.id) {
    throw new Error("Local note base revision is stale");
  }

  const now = nowIso();
  const revisionId = crypto.randomUUID();
  const updated: NoteDocumentView = {
    document: {
      ...current.document,
      title: input.title,
      currentRevisionId: revisionId,
      updatedAt: now,
    },
    revision: {
      id: revisionId,
      documentId: current.document.id,
      revisionNumber: current.revision.revisionNumber + 1,
      parentRevisionId: current.revision.id,
      content: { body: input.body },
      metadata: structuredClone(current.revision.metadata),
      createdAt: now,
    },
  };
  const operation: SyncOperation = {
    id: operationId(),
    deviceId: device.id,
    projectId: current.document.projectId,
    entityType: "document",
    entityId: current.document.id,
    action: "document.update",
    baseRevision: current.revision.id,
    payload: {
      title: input.title,
      body: input.body,
    },
    createdAt: now,
  };

  await store.transaction(async (tx) => {
    await tx.upsertNote(updated);
    await tx.appendOperation(operation);
  });

  return updated;
}

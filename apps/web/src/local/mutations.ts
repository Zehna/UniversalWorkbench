import type {
  CreateNoteRequest,
  CreateProjectRequest,
  NoteDocumentView,
  Project,
  SyncOperation,
  UpdateNoteRequest,
  UpdateProjectRequest,
  CreateWorkflowRequest,
  UpdateWorkflowRequest,
  WorkflowDocumentView,
} from "@uw/contracts";
import type { LocalDeviceRecord, LocalStore } from "./store";

function nowIso(): string {
  return new Date().toISOString();
}

function operation(
  input: Omit<SyncOperation, "id" | "createdAt">,
): SyncOperation {
  return {
    id: crypto.randomUUID(),
    createdAt: nowIso(),
    ...input,
  };
}

export async function createProjectLocally(
  store: LocalStore,
  device: LocalDeviceRecord,
  input: CreateProjectRequest,
): Promise<Project> {
  const timestamp = nowIso();
  const project: Project = {
    id: crypto.randomUUID(),
    ownerId: device.ownerId,
    name: input.name,
    description: input.description ?? null,
    schemaVersion: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const pending = operation({
    deviceId: device.id,
    projectId: project.id,
    entityType: "project",
    entityId: project.id,
    action: "project.create",
    baseRevision: null,
    payload: structuredClone(input),
  });

  return store.transaction(async (tx) => {
    await tx.upsertProject(project);
    await tx.appendOperation(pending);
    return project;
  });
}

export async function updateProjectLocally(
  store: LocalStore,
  device: LocalDeviceRecord,
  project: Project,
  baseRevision: string,
  input: UpdateProjectRequest,
): Promise<Project> {
  const updated: Project = {
    ...project,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined
      ? { description: input.description }
      : {}),
    updatedAt: nowIso(),
  };
  const pending = operation({
    deviceId: device.id,
    projectId: project.id,
    entityType: "project",
    entityId: project.id,
    action: "project.update",
    baseRevision,
    payload: structuredClone(input),
  });

  return store.transaction(async (tx) => {
    await tx.upsertProject(updated);
    await tx.appendOperation(pending);
    return updated;
  });
}

export async function createNoteLocally(
  store: LocalStore,
  device: LocalDeviceRecord,
  projectId: string,
  input: CreateNoteRequest,
): Promise<NoteDocumentView> {
  const timestamp = nowIso();
  const documentId = crypto.randomUUID();
  const revisionId = crypto.randomUUID();
  const view: NoteDocumentView = {
    document: {
      id: documentId,
      projectId,
      kind: "note",
      title: input.title,
      currentRevisionId: revisionId,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    revision: {
      id: revisionId,
      documentId,
      revisionNumber: 1,
      parentRevisionId: null,
      content: { body: input.body },
      metadata: {},
      createdAt: timestamp,
    },
  };
  const pending = operation({
    deviceId: device.id,
    projectId,
    entityType: "document",
    entityId: documentId,
    action: "document.create",
    baseRevision: null,
    payload: structuredClone(input),
  });

  return store.transaction(async (tx) => {
    await tx.upsertNote(view);
    await tx.appendOperation(pending);
    return view;
  });
}

export async function updateNoteLocally(
  store: LocalStore,
  device: LocalDeviceRecord,
  view: NoteDocumentView,
  input: UpdateNoteRequest,
): Promise<NoteDocumentView> {
  const timestamp = nowIso();
  const revisionId = crypto.randomUUID();
  const updated: NoteDocumentView = {
    document: {
      ...view.document,
      title: input.title,
      currentRevisionId: revisionId,
      updatedAt: timestamp,
    },
    revision: {
      id: revisionId,
      documentId: view.document.id,
      revisionNumber: view.revision.revisionNumber + 1,
      parentRevisionId: view.revision.id,
      content: { body: input.body },
      metadata: {},
      createdAt: timestamp,
    },
  };
  const pending = operation({
    deviceId: device.id,
    projectId: view.document.projectId,
    entityType: "document",
    entityId: view.document.id,
    action: "document.update",
    baseRevision: input.baseRevisionId,
    payload: { title: input.title, body: input.body },
  });

  return store.transaction(async (tx) => {
    await tx.upsertNote(updated);
    await tx.appendOperation(pending);
    return updated;
  });
}

export async function createWorkflowLocally(
  store: LocalStore,
  device: LocalDeviceRecord,
  projectId: string,
  input: CreateWorkflowRequest,
): Promise<WorkflowDocumentView> {
  const timestamp = nowIso();
  const documentId = crypto.randomUUID();
  const revisionId = crypto.randomUUID();
  const view: WorkflowDocumentView = {
    document: {
      id: documentId,
      projectId,
      kind: "workflow",
      title: input.title,
      currentRevisionId: revisionId,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    revision: {
      id: revisionId,
      documentId,
      revisionNumber: 1,
      parentRevisionId: null,
      content: {
        kind: "workflow",
        workflow: structuredClone(input.workflow),
      },
      metadata: {},
      createdAt: timestamp,
    },
  };
  const pending = operation({
    deviceId: device.id,
    projectId,
    entityType: "document",
    entityId: documentId,
    action: "document.create",
    baseRevision: null,
    payload: {
      kind: "workflow",
      title: input.title,
      workflow: structuredClone(input.workflow),
    },
  });

  return store.transaction(async (tx) => {
    await tx.upsertWorkflow(view);
    await tx.appendOperation(pending);
    return view;
  });
}

export async function updateWorkflowLocally(
  store: LocalStore,
  device: LocalDeviceRecord,
  view: WorkflowDocumentView,
  input: UpdateWorkflowRequest,
): Promise<WorkflowDocumentView> {
  const timestamp = nowIso();
  const revisionId = crypto.randomUUID();
  const updated: WorkflowDocumentView = {
    document: {
      ...view.document,
      title: input.title,
      currentRevisionId: revisionId,
      updatedAt: timestamp,
    },
    revision: {
      id: revisionId,
      documentId: view.document.id,
      revisionNumber: view.revision.revisionNumber + 1,
      parentRevisionId: view.revision.id,
      content: {
        kind: "workflow",
        workflow: structuredClone(input.workflow),
      },
      metadata: {},
      createdAt: timestamp,
    },
  };
  const pending = operation({
    deviceId: device.id,
    projectId: view.document.projectId,
    entityType: "document",
    entityId: view.document.id,
    action: "document.update",
    baseRevision: input.baseRevisionId,
    payload: {
      kind: "workflow",
      title: input.title,
      workflow: structuredClone(input.workflow),
    },
  });

  return store.transaction(async (tx) => {
    await tx.upsertWorkflow(updated);
    await tx.appendOperation(pending);
    return updated;
  });
}

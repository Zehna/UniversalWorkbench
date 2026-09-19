import { describe, expect, it } from "vitest";
import type { WorkflowDefinitionV1 } from "@uw/contracts";
import {
  createDocumentService,
  RevisionConflictError,
  type DocumentRepository,
} from "../src/index.js";
import type { AuditRepository } from "@uw/core";
import type { Clock, IdGenerator } from "@uw/shared";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const DOCUMENT_ID = "33333333-3333-4333-8333-333333333333";
const REVISION_ID = "44444444-4444-4444-8444-444444444444";
const NEXT_REVISION_ID = "55555555-5555-4555-8555-555555555555";
const NOW = new Date("2026-09-19T15:00:00.000Z");

const workflow: WorkflowDefinitionV1 = {
  schemaVersion: 1,
  name: "Research pipeline",
  nodes: [],
  edges: [],
  outputs: [],
};

function repository(): DocumentRepository {
  let currentRevisionId = REVISION_ID;
  let revisionNumber = 1;
  let currentWorkflow = structuredClone(workflow);

  return {
    async projectExists() {
      return true;
    },
    async createNote() {
      throw new Error("not used");
    },
    async listNotes() {
      return [];
    },
    async getNote() {
      return null;
    },
    async listRevisions() {
      return [];
    },
    async updateNote() {
      return { status: "not_found" };
    },
    async createWorkflow(input) {
      currentRevisionId = input.revisionId;
      currentWorkflow = structuredClone(input.workflow);
      return {
        document: {
          id: input.documentId,
          projectId: input.projectId,
          kind: "workflow",
          title: input.title,
          currentRevisionId: input.revisionId,
          createdAt: input.createdAt.toISOString(),
          updatedAt: input.createdAt.toISOString(),
        },
        revision: {
          id: input.revisionId,
          documentId: input.documentId,
          revisionNumber: 1,
          parentRevisionId: null,
          content: {
            kind: "workflow",
            workflow: structuredClone(input.workflow),
          },
          metadata: {},
          createdAt: input.createdAt.toISOString(),
        },
      };
    },
    async listWorkflows() {
      return [];
    },
    async getWorkflow() {
      return {
        document: {
          id: DOCUMENT_ID,
          projectId: PROJECT_ID,
          kind: "workflow",
          title: "Research pipeline",
          currentRevisionId,
          createdAt: NOW.toISOString(),
          updatedAt: NOW.toISOString(),
        },
        revision: {
          id: currentRevisionId,
          documentId: DOCUMENT_ID,
          revisionNumber,
          parentRevisionId: revisionNumber === 1 ? null : REVISION_ID,
          content: {
            kind: "workflow",
            workflow: structuredClone(currentWorkflow),
          },
          metadata: {},
          createdAt: NOW.toISOString(),
        },
      };
    },
    async updateWorkflow(input) {
      if (input.baseRevisionId !== currentRevisionId) {
        return { status: "conflict", currentRevisionId };
      }
      revisionNumber += 1;
      currentRevisionId = input.revisionId;
      currentWorkflow = structuredClone(input.workflow);
      return {
        status: "updated",
        value: await this.getWorkflow(
          input.ownerId,
          input.projectId,
          input.documentId,
        ),
      };
    },
  };
}

function service() {
  let next = 0;
  const ids = [DOCUMENT_ID, REVISION_ID, NEXT_REVISION_ID];
  const idGenerator: IdGenerator = {
    next() {
      return ids[next++] ?? "66666666-6666-4666-8666-666666666666";
    },
  };
  const clock: Clock = { now: () => new Date(NOW) };
  const audit: AuditRepository = { async record() {} };

  return createDocumentService({
    documents: repository(),
    audit,
    clock,
    idGenerator,
    validateWorkflow(definition) {
      if (definition.schemaVersion !== 1) throw new Error("invalid workflow");
    },
  });
}

describe("workflow document service", () => {
  it("creates and reads a revisioned workflow document", async () => {
    const documents = service();
    const created = await documents.createWorkflow(
      OWNER_ID,
      PROJECT_ID,
      { title: "Research pipeline", workflow },
      "77777777-7777-4777-8777-777777777777",
    );

    expect(created.document.kind).toBe("workflow");
    expect(created.revision.content).toEqual({
      kind: "workflow",
      workflow,
    });
  });

  it("rejects a stale workflow base revision", async () => {
    const documents = service();
    const created = await documents.createWorkflow(
      OWNER_ID,
      PROJECT_ID,
      { title: "Research pipeline", workflow },
      "77777777-7777-4777-8777-777777777777",
    );

    const updated = await documents.updateWorkflow(
      OWNER_ID,
      PROJECT_ID,
      created.document.id,
      {
        title: "Research pipeline v2",
        workflow: { ...workflow, name: "Research pipeline v2" },
        baseRevisionId: created.revision.id,
      },
      "88888888-8888-4888-8888-888888888888",
    );

    await expect(
      documents.updateWorkflow(
        OWNER_ID,
        PROJECT_ID,
        created.document.id,
        {
          title: "Stale",
          workflow,
          baseRevisionId: created.revision.id,
        },
        "99999999-9999-4999-8999-999999999999",
      ),
    ).rejects.toMatchObject({
      name: RevisionConflictError.name,
      currentRevisionId: updated.revision.id,
    });
  });

  it("requires the exact canonical workflow revision before execution", async () => {
    const documents = service();
    const created = await documents.createWorkflow(
      OWNER_ID,
      PROJECT_ID,
      { title: "Research pipeline", workflow },
      "77777777-7777-4777-8777-777777777777",
    );

    await expect(
      documents.assertCanonicalWorkflowRevision(
        OWNER_ID,
        PROJECT_ID,
        created.document.id,
        created.revision.id,
      ),
    ).resolves.toEqual(created);

    await expect(
      documents.assertCanonicalWorkflowRevision(
        OWNER_ID,
        PROJECT_ID,
        created.document.id,
        NEXT_REVISION_ID,
      ),
    ).rejects.toBeInstanceOf(RevisionConflictError);
  });
});

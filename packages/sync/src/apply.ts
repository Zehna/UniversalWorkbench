import type { SyncOperation } from "@uw/contracts";
import {
  executeAction,
  type ActionContext,
  type AuditRecordInput,
  type AuditRepository,
} from "@uw/core";
import type { Clock, IdGenerator } from "@uw/shared";
import {
  createConflictPayload,
  createTombstoneConflictPayload,
} from "./conflict.js";
import type { SyncRepository } from "./repository.js";
import type { SyncOperationApplier } from "./service.js";

export type SyncEntityApplyResult =
  | {
      status: "applied";
      kind: "upsert" | "tombstone";
      revision: string | null;
      payload: Record<string, unknown>;
    }
  | {
      status: "conflict";
      currentRevision: string | null;
      current: Record<string, unknown>;
    };

export interface SyncProjectStore {
  apply(
    ownerId: string,
    operation: SyncOperation,
  ): Promise<SyncEntityApplyResult>;
}

export interface SyncDocumentStore {
  apply(
    ownerId: string,
    operation: SyncOperation,
  ): Promise<SyncEntityApplyResult>;
}

export interface CreateSyncOperationApplierOptions {
  repository: SyncRepository;
  projects: SyncProjectStore;
  documents: SyncDocumentStore;
  audit: AuditRepository;
  clock: Clock;
  idGenerator: IdGenerator;
}

function projectIdForOperation(operation: SyncOperation): string | undefined {
  if (operation.projectId) return operation.projectId;
  return operation.entityType === "project" ? operation.entityId : undefined;
}

export function createSyncOperationApplier(
  options: CreateSyncOperationApplierOptions,
): SyncOperationApplier {
  const { repository, projects, documents, audit, clock, idGenerator } =
    options;

  return {
    async apply(ownerId, operation) {
      const replay = await repository.findChange(ownerId, operation.id);
      if (replay) return replay;

      const tombstone = await repository.findTombstone(
        ownerId,
        operation.entityType,
        operation.entityId,
      );
      if (tombstone) {
        return repository.persistConflict({
          ownerId,
          operation,
          currentRevision: null,
          change: {
            kind: "conflict",
            revision: null,
            payload: createTombstoneConflictPayload(
              operation.payload,
              tombstone.cursor,
            ),
          },
          now: clock.now(),
        });
      }

      const store =
        operation.entityType === "project"
          ? projects
          : operation.entityType === "document"
            ? documents
            : null;

      if (!store) {
        throw new Error(
          `Client sync mutation is not supported for ${operation.entityType}`,
        );
      }

      const projectId = projectIdForOperation(operation);
      const context: ActionContext =
        projectId === undefined
          ? { actorId: ownerId, traceId: operation.id }
          : { actorId: ownerId, traceId: operation.id, projectId };

      const result = await executeAction({
        name: `sync.${operation.action}`,
        input: operation,
        context,
        authorize: async () => undefined,
        run: () => store.apply(ownerId, operation),
        audit: async (applied) => {
          if (applied.status !== "applied") return;
          const auditInput: AuditRecordInput =
            projectId === undefined
              ? {
                  id: idGenerator.next(),
                  actorId: ownerId,
                  action: `sync.${operation.action}`,
                  targetType: operation.entityType,
                  targetId: operation.entityId,
                  traceId: operation.id,
                  metadata: {
                    deviceId: operation.deviceId,
                    operationId: operation.id,
                  },
                  createdAt: clock.now(),
                }
              : {
                  id: idGenerator.next(),
                  actorId: ownerId,
                  projectId,
                  action: `sync.${operation.action}`,
                  targetType: operation.entityType,
                  targetId: operation.entityId,
                  traceId: operation.id,
                  metadata: {
                    deviceId: operation.deviceId,
                    operationId: operation.id,
                  },
                  createdAt: clock.now(),
                };
          await audit.record(auditInput);
        },
      });

      if (result.status === "conflict") {
        return repository.persistConflict({
          ownerId,
          operation,
          currentRevision: result.currentRevision,
          change: {
            kind: "conflict",
            revision: result.currentRevision,
            payload: createConflictPayload(operation.payload, result.current),
          },
          now: clock.now(),
        });
      }

      return repository.persistAppliedOperation({
        ownerId,
        operation,
        resultRevision: result.revision,
        change: {
          kind: result.kind,
          revision: result.revision,
          payload: structuredClone(result.payload),
        },
        now: clock.now(),
      });
    },
  };
}

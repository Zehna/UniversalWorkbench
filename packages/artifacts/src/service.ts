import { createHash } from "node:crypto";
import type { Artifact } from "@uw/contracts";
import {
  executeAction,
  ProjectNotFoundError,
  type AuditRepository,
} from "@uw/core";
import type { Clock, IdGenerator } from "@uw/shared";
import type { StorageBackend } from "@uw/storage";
import { ArtifactNotFoundError } from "./model.js";
import type { ArtifactRepository } from "./repository.js";

export interface CreateArtifactInput {
  type: string;
  mimeType: string;
  bytes: Uint8Array;
  metadata: Record<string, unknown>;
}

export interface ArtifactService {
  create(
    ownerId: string,
    projectId: string,
    input: CreateArtifactInput,
    traceId: string,
  ): Promise<Artifact>;
  list(ownerId: string, projectId: string): Promise<Artifact[]>;
  get(
    ownerId: string,
    projectId: string,
    artifactId: string,
  ): Promise<Artifact>;
  getContent(
    ownerId: string,
    projectId: string,
    artifactId: string,
  ): Promise<Uint8Array>;
}

export interface CreateArtifactServiceOptions {
  artifacts: ArtifactRepository;
  storage: StorageBackend;
  audit: AuditRepository;
  clock: Clock;
  idGenerator: IdGenerator;
}

async function cleanupStorage(
  storage: StorageBackend,
  key: string,
): Promise<void> {
  try {
    await storage.remove(key);
  } catch {
    // Preserve the repository error that caused cleanup.
  }
}

export function createArtifactService(
  options: CreateArtifactServiceOptions,
): ArtifactService {
  const { artifacts, storage, audit, clock, idGenerator } = options;

  return {
    async create(ownerId, projectId, input, traceId) {
      return executeAction({
        name: "artifact.create",
        input,
        context: { actorId: ownerId, projectId, traceId },
        authorize: async () => {
          if (!(await artifacts.projectExists(ownerId, projectId))) {
            throw new ProjectNotFoundError(projectId);
          }
        },
        run: async () => {
          const artifactId = idGenerator.next();
          const bytes = new Uint8Array(input.bytes);
          const checksumSha256 = createHash("sha256")
            .update(bytes)
            .digest("hex");
          const storageKey = `${projectId}/${artifactId}/${checksumSha256}`;
          const createdAt = clock.now();
          const metadata = structuredClone(input.metadata);

          await storage.put({ key: storageKey, bytes });

          try {
            const created = await artifacts.create({
              id: artifactId,
              ownerId,
              projectId,
              type: input.type,
              schemaVersion: 1,
              mimeType: input.mimeType,
              checksumSha256,
              sizeBytes: bytes.byteLength,
              storageKey,
              metadata,
              createdAt,
            });

            if (!created) throw new ProjectNotFoundError(projectId);
            return created;
          } catch (error) {
            await cleanupStorage(storage, storageKey);
            throw error;
          }
        },
        audit: async (artifact) => {
          await audit.record({
            id: idGenerator.next(),
            actorId: ownerId,
            projectId,
            action: "artifact.create",
            targetType: "artifact",
            targetId: artifact.id,
            traceId,
            metadata: {
              fields: ["metadata", "mimeType", "type"],
              sizeBytes: artifact.sizeBytes,
            },
            createdAt: clock.now(),
          });
        },
      });
    },

    async list(ownerId, projectId) {
      return artifacts.list(ownerId, projectId);
    },

    async get(ownerId, projectId, artifactId) {
      const artifact = await artifacts.get(ownerId, projectId, artifactId);
      if (!artifact) throw new ArtifactNotFoundError(artifactId);
      return artifact;
    },

    async getContent(ownerId, projectId, artifactId) {
      const artifact = await artifacts.get(ownerId, projectId, artifactId);
      if (!artifact) throw new ArtifactNotFoundError(artifactId);
      return storage.get(artifact.storageKey);
    },
  };
}

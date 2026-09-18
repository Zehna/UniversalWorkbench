import type { Artifact } from "@uw/contracts";

export interface CreateArtifactRecordInput {
  id: string;
  ownerId: string;
  projectId: string;
  type: string;
  schemaVersion: number;
  mimeType: string;
  checksumSha256: string;
  sizeBytes: number;
  storageKey: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface ArtifactRepository {
  projectExists(ownerId: string, projectId: string): Promise<boolean>;
  create(input: CreateArtifactRecordInput): Promise<Artifact | null>;
  list(ownerId: string, projectId: string): Promise<Artifact[]>;
  get(
    ownerId: string,
    projectId: string,
    artifactId: string,
  ): Promise<Artifact | null>;
}

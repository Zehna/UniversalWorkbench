export type ProvenanceObjectKind = "context" | "artifact";

export interface ProvenanceEdge {
  id: string;
  projectId: string;
  executionId: string;
  stepExecutionId: string | null;
  sourceKind: ProvenanceObjectKind;
  sourceId: string;
  targetKind: ProvenanceObjectKind;
  targetId: string;
  relation: string;
  createdAt: string;
}

export interface ProvenanceRepository {
  append(edge: ProvenanceEdge): Promise<void>;
  listByExecution(executionId: string): Promise<ProvenanceEdge[]>;
}

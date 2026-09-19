import type { WorkflowDefinitionV1 } from "@uw/contracts";
import type { WorkflowValidationError } from "./errors.js";

export interface WorkflowPlan {
  order: string[];
  roots: string[];
  terminals: string[];
  dependencies: Record<string, string[]>;
  dependents: Record<string, string[]>;
}

export type WorkflowValidationResult =
  { ok: true; errors: [] } | { ok: false; errors: WorkflowValidationError[] };

export type WorkflowDefinition = WorkflowDefinitionV1;

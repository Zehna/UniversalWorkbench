import { ToolDescriptorSchema, WorkflowDefinitionSchema } from "@uw/contracts";
import type {
  ContextType,
  ToolDescriptor,
  WorkflowDefinition,
} from "@uw/contracts";
import type { ToolRegistry } from "@uw/tools";
import { validateBindings } from "./bindings.js";
import { WorkflowValidationError } from "./errors.js";
import { topologicalOrder } from "./graph.js";

export interface ValidatedWorkflow {
  readonly definition: WorkflowDefinition;
  readonly orderedNodeIds: readonly string[];
  readonly descriptors: ReadonlyMap<string, ToolDescriptor>;
  readonly inputTypes: ReadonlyMap<string, ContextType | null>;
}

export interface PreflightPlan {
  orderedNodeIds: string[];
  requiredPermissions: string[];
  requiresNetwork: boolean;
  warnings: string[];
}

function lexical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function httpMethod(config: unknown): string | undefined {
  if (typeof config !== "object" || config === null || !("method" in config)) {
    return undefined;
  }
  const method = config.method;
  return typeof method === "string" ? method : undefined;
}

function isSafeInvocation(
  node: WorkflowDefinition["nodes"][number],
  descriptor: ToolDescriptor,
): boolean {
  if (descriptor.id === "builtin.http.request") {
    const method = httpMethod(node.config);
    return method === "GET" || method === "HEAD";
  }
  return descriptor.idempotency === "safe";
}

/** Validate the complete, version-pinned DAG without starting any tools. */
export function validateWorkflow(
  workflow: WorkflowDefinition,
  registry: ToolRegistry,
): ValidatedWorkflow {
  const parsed = WorkflowDefinitionSchema.safeParse(workflow);
  if (!parsed.success) {
    const duplicate = parsed.error.issues.some(
      (issue) => issue.message === "Workflow node IDs must be unique",
    );
    throw new WorkflowValidationError(
      duplicate ? "DUPLICATE_NODE" : "INVALID_WORKFLOW",
      duplicate
        ? "Workflow node IDs must be unique"
        : "Workflow definition is invalid",
    );
  }

  const definition = parsed.data;
  const orderedNodeIds = topologicalOrder(definition);
  const descriptors = new Map<string, ToolDescriptor>();

  for (const node of definition.nodes) {
    let descriptor: ToolDescriptor;
    try {
      // Registry lookup is exact: no semver ranges or fallback to latest.
      descriptor = ToolDescriptorSchema.parse(
        registry.resolve(node.toolId, node.toolVersion).descriptor,
      );
    } catch {
      throw new WorkflowValidationError(
        "TOOL_NOT_FOUND",
        "Workflow references an unavailable or invalid pinned tool version",
      );
    }
    if (
      descriptor.id !== node.toolId ||
      descriptor.version !== node.toolVersion
    ) {
      throw new WorkflowValidationError(
        "TOOL_NOT_FOUND",
        "Resolved tool does not match the workflow's pinned ID and version",
      );
    }

    const method =
      descriptor.id === "builtin.http.request"
        ? httpMethod(node.config)
        : undefined;
    if (
      descriptor.id === "builtin.http.request" &&
      method !== "GET" &&
      method !== "HEAD" &&
      !node.idempotencyKey
    ) {
      throw new WorkflowValidationError(
        "MISSING_IDEMPOTENCY_KEY",
        "Mutating HTTP nodes require a workflow idempotency key",
      );
    }
    if (
      (node.retry?.maxAttempts ?? 1) > 1 &&
      !isSafeInvocation(node, descriptor) &&
      !node.idempotencyKey
    ) {
      throw new WorkflowValidationError(
        "UNSAFE_RETRY",
        "Retrying a non-idempotent tool requires a workflow idempotency key",
      );
    }
    descriptors.set(node.id, descriptor);
  }

  const inputTypes = validateBindings(definition, descriptors);
  return { definition, orderedNodeIds, descriptors, inputTypes };
}

/** Permission failures abort preflight before any node can run. */
export function buildPreflightPlan(
  workflow: ValidatedWorkflow,
  grantedPermissions: ReadonlySet<string>,
): PreflightPlan {
  const permissions = new Set<string>();
  let requiresNetwork = false;
  for (const nodeId of workflow.orderedNodeIds) {
    const descriptor = workflow.descriptors.get(nodeId);
    if (!descriptor) {
      throw new WorkflowValidationError(
        "INVALID_WORKFLOW",
        "Validated workflow is missing a tool descriptor",
      );
    }
    descriptor.permissions.forEach((permission) => permissions.add(permission));
    if (
      descriptor.permissions.includes("network") ||
      descriptor.capabilities.includes("network")
    ) {
      requiresNetwork = true;
    }
  }

  const requiredPermissions = [...permissions].sort(lexical);
  const missing = requiredPermissions.filter(
    (permission) => !grantedPermissions.has(permission),
  );
  if (missing.length > 0) {
    throw new WorkflowValidationError(
      "MISSING_PERMISSION",
      "Workflow requires permissions that were not granted: " +
        missing.join(", "),
    );
  }

  const unknownInputs = workflow.orderedNodeIds.filter(
    (id) => workflow.inputTypes.get(id) === null,
  );
  const warnings =
    unknownInputs.length > 0
      ? [
          "Workflow input context types must be checked at execution for nodes: " +
            unknownInputs.join(", "),
        ]
      : [];

  return {
    orderedNodeIds: [...workflow.orderedNodeIds],
    requiredPermissions,
    requiresNetwork,
    warnings,
  };
}

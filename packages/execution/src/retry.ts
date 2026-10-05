import type { ToolDescriptor, WorkflowNode } from "@uw/contracts";

export function retryClass(
  descriptor: ToolDescriptor,
  node: WorkflowNode,
): "safe" | "keyed" | "unsafe" {
  if (descriptor.id === "builtin.http.request") {
    const config = node.config;
    const method =
      config !== null && typeof config === "object" && "method" in config
        ? config.method
        : undefined;
    if (method === "GET" || method === "HEAD") return "safe";
  } else if (descriptor.idempotency === "safe") {
    return "safe";
  } else if (descriptor.idempotency === "keyed") {
    return "keyed";
  }
  return node.idempotencyKey ? "keyed" : "unsafe";
}

export function canRetry(
  descriptor: ToolDescriptor,
  node: WorkflowNode,
  completedAttempts: number,
  errorCode: string,
): boolean {
  const max = node.retry?.maxAttempts ?? 1;
  if (completedAttempts >= max || retryClass(descriptor, node) === "unsafe")
    return false;
  if (
    [
      "ABORTED",
      "CANCELLED",
      "INVALID_INPUT",
      "INVALID_CONFIG",
      "INVALID_OUTPUT",
      "PERMISSION_DENIED",
      "BUDGET_STEPS",
      "BUDGET_DURATION",
      "BUDGET_OUTPUT",
      "BUDGET_EXCEEDED",
      "AI_SCHEMA_MISMATCH",
      "AI_PROVIDER_NOT_CONFIGURED",
      "LOCAL_SECRET_NOT_AVAILABLE_ON_SERVER",
    ].includes(errorCode)
  ) {
    return false;
  }
  return true;
}

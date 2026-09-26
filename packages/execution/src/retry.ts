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
      "PERMISSION_DENIED",
      "BUDGET_STEPS",
      "BUDGET_DURATION",
      "BUDGET_OUTPUT",
    ].includes(errorCode)
  ) {
    return false;
  }
  return true;
}

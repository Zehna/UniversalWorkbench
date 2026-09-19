import type { ToolCapability } from "@uw/contracts";

export function missingCapabilities(
  required: readonly ToolCapability[],
  granted: Iterable<ToolCapability>,
): ToolCapability[] {
  const grantedSet = new Set<ToolCapability>(granted);
  return required.filter((capability) => !grantedSet.has(capability));
}

export function hasRequiredCapabilities(
  required: readonly ToolCapability[],
  granted: Iterable<ToolCapability>,
): boolean {
  return missingCapabilities(required, granted).length === 0;
}

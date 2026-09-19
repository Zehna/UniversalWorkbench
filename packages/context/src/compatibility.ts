import type { ContextType, ToolInputPort } from "@uw/contracts";

export type ContextPort = ToolInputPort;

export function acceptsContext(
  port: Pick<ContextPort, "types">,
  type: ContextType,
): boolean {
  return port.types.includes(type);
}

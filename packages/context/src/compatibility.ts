import { ContextTypeSchema } from "@uw/contracts";
import type { ContextEnvelope, ToolDescriptor } from "@uw/contracts";

export function isToolCompatible(
  context: ContextEnvelope,
  tool: ToolDescriptor,
  grantedPermissions: ReadonlySet<string>,
): boolean {
  if (!ContextTypeSchema.safeParse(context.type).success) return false;

  return (
    tool.accepts.includes(context.type) &&
    tool.permissions.every((permission) => grantedPermissions.has(permission))
  );
}

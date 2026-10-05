import { parseSecretRef, redactSecrets } from "@uw/shared";
import type { VaultStore } from "@uw/database";
import { ToolRuntimeError } from "@uw/tools";

/**
 * Resolve a `secret://` reference to plaintext at the server execution
 * boundary. `secret://vault/<name>` reads owner-scoped via the VaultStore
 * (which owns decrypt); `secret://local/<name>` always throws
 * `LOCAL_SECRET_NOT_AVAILABLE_ON_SERVER` — local keys never leave the
 * device, so server workflows must use `secret://vault/*`.
 *
 * Every failure carries a fixed message: refs, names, values, and upstream
 * detail never enter the error. Upstream failures pass through
 * `redactSecrets` before being replaced by the concealment error.
 */
export async function resolveSecretResource(
  ref: string,
  ownerId: string,
  vaultStore: VaultStore,
): Promise<string> {
  let scope: string;
  let name: string;
  try {
    const parsed = parseSecretRef(ref);
    scope = parsed.scope;
    name = parsed.name;
  } catch (error) {
    redactSecrets(error);
    throw new ToolRuntimeError(
      "INVALID_CONFIG",
      "AI secret could not be resolved",
    );
  }
  if (!ownerId) {
    throw new ToolRuntimeError(
      "INVALID_CONFIG",
      "AI secret could not be resolved",
    );
  }
  if (scope === "local") {
    throw new ToolRuntimeError(
      "LOCAL_SECRET_NOT_AVAILABLE_ON_SERVER",
      "AI secret could not be resolved",
    );
  }
  try {
    const value = await vaultStore.get(ownerId, name);
    if (typeof value !== "string" || value.length === 0) {
      throw new ToolRuntimeError(
        "INVALID_CONFIG",
        "AI secret could not be resolved",
      );
    }
    return value;
  } catch (error) {
    if (error instanceof ToolRuntimeError) throw error;
    redactSecrets(error);
    throw new ToolRuntimeError(
      "INVALID_CONFIG",
      "AI secret could not be resolved",
    );
  }
}

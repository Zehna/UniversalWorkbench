import { ToolDescriptorSchema } from "@uw/contracts";
import type { ToolDescriptor } from "@uw/contracts";
import { ToolRegistryError } from "./errors.js";
import type { ToolExecutor } from "./runtime.js";

export interface ToolRegistry {
  register(tool: ToolExecutor): void;
  resolve(id: string, version: string): ToolExecutor;
  list(): ToolDescriptor[];
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function createToolRegistry(): ToolRegistry {
  const versions = new Map<string, Map<string, ToolExecutor>>();

  return {
    register(tool) {
      const parsed = ToolDescriptorSchema.safeParse(tool.descriptor);
      if (!parsed.success) {
        throw new ToolRegistryError(
          "INVALID_DESCRIPTOR",
          "Tool descriptor failed validation",
        );
      }

      const descriptor = parsed.data;
      const byVersion =
        versions.get(descriptor.id) ?? new Map<string, ToolExecutor>();
      if (byVersion.has(descriptor.version)) {
        throw new ToolRegistryError(
          "DUPLICATE_TOOL",
          `Tool already registered: ${descriptor.id}@${descriptor.version}`,
        );
      }

      byVersion.set(descriptor.version, {
        descriptor,
        run: (input, config, context) => tool.run(input, config, context),
      });
      versions.set(descriptor.id, byVersion);
    },
    resolve(id, version) {
      const selected = versions.get(id)?.get(version);
      if (!selected) {
        throw new ToolRegistryError(
          "TOOL_NOT_FOUND",
          `Unknown tool: ${id}@${version}`,
        );
      }
      return selected;
    },
    list() {
      return Array.from(versions.values())
        .flatMap((byVersion) => Array.from(byVersion.values()))
        .map((tool) => ToolDescriptorSchema.parse(tool.descriptor))
        .sort(
          (left, right) =>
            compare(left.id, right.id) || compare(left.version, right.version),
        );
    },
  };
}

import { describe, expect, it } from "vitest";
import {
  createToolRegistry,
  ToolRegistryError,
  createTextTrimTool,
} from "../src/index.js";

describe("Tool Registry", () => {
  it("resolves only exact pinned versions", () => {
    const registry = createToolRegistry();
    const v1 = createTextTrimTool();
    const v2 = {
      ...createTextTrimTool(),
      descriptor: { ...v1.descriptor, version: "2.0.0" },
    };
    registry.register(v1);
    registry.register(v2);

    expect(registry.resolve(v1.descriptor.id, "1.0.0").descriptor.version).toBe(
      "1.0.0",
    );
    expect(registry.resolve(v1.descriptor.id, "2.0.0").descriptor.version).toBe(
      "2.0.0",
    );
    expect(() => registry.resolve(v1.descriptor.id, "3.0.0")).toThrow(
      ToolRegistryError,
    );
    expect(() => registry.resolve(v1.descriptor.id, "^1.0.0")).toThrow(
      ToolRegistryError,
    );
  });

  it("rejects duplicate ID plus version", () => {
    const registry = createToolRegistry();
    registry.register(createTextTrimTool());
    expect(() => registry.register(createTextTrimTool())).toThrow(
      expect.objectContaining({ code: "DUPLICATE_TOOL" }),
    );
  });

  it("reports a typed missing-tool error", () => {
    expect(() => createToolRegistry().resolve("missing.tool", "1.0.0")).toThrow(
      expect.objectContaining({ code: "TOOL_NOT_FOUND" }),
    );
  });

  it("rejects an invalid descriptor rather than registering it", () => {
    const registry = createToolRegistry();
    const invalid = createTextTrimTool();
    invalid.descriptor.version = "latest";
    expect(() => registry.register(invalid)).toThrow(
      expect.objectContaining({ code: "INVALID_DESCRIPTOR" }),
    );
    expect(registry.list()).toEqual([]);
  });

  it("lists by tool ID and version and returns detached descriptors", () => {
    const registry = createToolRegistry();
    const z = createTextTrimTool();
    z.descriptor.id = "builtin.zeta";
    const a2 = createTextTrimTool();
    a2.descriptor.id = "builtin.alpha";
    a2.descriptor.version = "2.0.0";
    const a1 = createTextTrimTool();
    a1.descriptor.id = "builtin.alpha";

    registry.register(z);
    registry.register(a2);
    registry.register(a1);
    const listed = registry.list();
    expect(listed.map((tool) => `${tool.id}@${tool.version}`)).toEqual([
      "builtin.alpha@1.0.0",
      "builtin.alpha@2.0.0",
      "builtin.zeta@1.0.0",
    ]);
    listed[0]!.name = "changed";
    expect(registry.list()[0]?.name).toBe("Text Trim");
  });
});

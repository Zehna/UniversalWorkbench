import { describe, expect, it } from "vitest";
import type { ToolInputPort } from "@uw/contracts";
import { ContextCompatibilityRegistry, acceptsContext } from "../src/index.js";

function port(types: ToolInputPort["types"]): ToolInputPort {
  return {
    name: "input",
    types,
    required: true,
  };
}

describe("Context compatibility", () => {
  it("accepts an exact context type", () => {
    expect(acceptsContext(port(["json"]), "json")).toBe(true);
    expect(acceptsContext(port(["json"]), "text")).toBe(false);
  });

  it("accepts only explicitly registered adapters", () => {
    const registry = new ContextCompatibilityRegistry();

    expect(registry.accepts(port(["json"]), "api-response")).toBe(false);

    registry.registerAdapter("api-response", "json");

    expect(registry.accepts(port(["json"]), "api-response")).toBe(true);
  });

  it("does not invent transitive or fuzzy conversions", () => {
    const registry = new ContextCompatibilityRegistry();
    registry.registerAdapter("api-response", "json");
    registry.registerAdapter("json", "text");

    expect(registry.accepts(port(["text"]), "api-response")).toBe(false);
    expect(registry.accepts(port(["note-ref"]), "json")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "@uw/contracts";
import { ContextCompatibilityRegistry } from "@uw/context";
import {
  DuplicateToolRegistrationError,
  ToolRegistry,
  type ToolRunner,
} from "../src/index.js";

function definition(
  id: string,
  version: string,
  inputTypes: ToolDefinition["accepts"][number]["types"] = ["json"],
): ToolDefinition {
  return {
    id,
    version,
    displayName: id,
    description: `${id}@${version}`,
    executionMode: "worker",
    accepts: [
      {
        name: "input",
        types: inputTypes,
        required: true,
      },
    ],
    produces: [
      {
        name: "output",
        types: ["text"],
      },
    ],
    configSchema: {},
    requiredCapabilities: [],
    defaults: {
      timeoutMs: 5_000,
      maxAttempts: 1,
    },
  };
}

function runner(label: string): ToolRunner {
  return {
    async run() {
      return {
        outputs: {},
        usage: {
          outputBytes: label.length,
          httpRequests: 0,
        },
      };
    },
  };
}

describe("ToolRegistry", () => {
  it("resolves the exact pinned version after a newer version is registered", () => {
    const registry = new ToolRegistry();
    const runnerV1 = runner("v1");
    const runnerV2 = runner("v2");

    registry.register(
      definition("builtin.text.template", "1"),
      runnerV1,
    );
    registry.register(
      definition("builtin.text.template", "2"),
      runnerV2,
    );

    expect(registry.resolve("builtin.text.template", "1").runner).toBe(
      runnerV1,
    );
    expect(registry.resolve("builtin.text.template", "2").runner).toBe(
      runnerV2,
    );
  });

  it("rejects duplicate id and version registrations", () => {
    const registry = new ToolRegistry();
    registry.register(definition("builtin.json.select", "1"), runner("one"));

    expect(() =>
      registry.register(
        definition("builtin.json.select", "1"),
        runner("duplicate"),
      ),
    ).toThrow(DuplicateToolRegistrationError);
  });

  it("returns compatible targets using exact type compatibility", () => {
    const registry = new ToolRegistry();
    registry.register(
      definition("builtin.json.select", "1", ["json"]),
      runner("json"),
    );
    registry.register(
      definition("builtin.note.write", "1", ["text", "markdown"]),
      runner("note"),
    );

    expect(
      registry.compatibleTargets("json").map((target) => target.definition.id),
    ).toEqual(["builtin.json.select"]);
  });

  it("uses only explicitly registered adapters for compatible targets", () => {
    const compatibility = new ContextCompatibilityRegistry();
    compatibility.registerAdapter("api-response", "json");
    const registry = new ToolRegistry(compatibility);
    registry.register(
      definition("builtin.json.parse", "1", ["json"]),
      runner("json"),
    );
    registry.register(
      definition("builtin.note.write", "1", ["text", "markdown"]),
      runner("note"),
    );

    expect(
      registry
        .compatibleTargets("api-response")
        .map((target) => target.definition.id),
    ).toEqual(["builtin.json.parse"]);

    expect(
      registry.compatibleTargets("json").map((target) => target.definition.id),
    ).not.toContain("builtin.note.write");
  });

  it("returns required capabilities for the exact registered version", () => {
    const registry = new ToolRegistry();
    const v1 = definition("builtin.http.request", "1", ["text"]);
    v1.requiredCapabilities = ["network.public"];
    const v2 = definition("builtin.http.request", "2", ["text"]);
    v2.requiredCapabilities = [
      "network.public",
      "project.artifacts.write",
    ];

    registry.register(v1, runner("v1"));
    registry.register(v2, runner("v2"));

    expect(registry.requiredCapabilities("builtin.http.request", "1")).toEqual([
      "network.public",
    ]);
    expect(registry.requiredCapabilities("builtin.http.request", "2")).toEqual([
      "network.public",
      "project.artifacts.write",
    ]);
  });
});

import type {
  ContextEnvelope,
  ContextType,
  ToolDescriptor,
} from "@uw/contracts";
import { describe, expect, it } from "vitest";
import { createContextBus } from "../src/index.js";

const CONTEXT: ContextEnvelope = {
  id: "11111111-1111-4111-8111-111111111111",
  type: "json",
  schemaVersion: 1,
  mimeType: "application/json",
  metadata: {},
  payload: { answer: 42 },
  provenance: { sourceContextIds: [] },
  capabilities: [],
};

function tool(
  id: string,
  options: {
    version?: string;
    accepts?: ContextType[];
    permissions?: string[];
  } = {},
): ToolDescriptor {
  return {
    id,
    version: options.version ?? "1.0.0",
    name: id,
    description: "A deterministic test tool",
    accepts: options.accepts ?? ["json"],
    produces: ["text"],
    permissions: options.permissions ?? [],
    capabilities: [],
    executionMode: "local",
    idempotency: "safe",
    configSchema: {},
  };
}

describe("Context Bus", () => {
  const bus = createContextBus();

  it("matches only the exact context type", () => {
    const candidates = bus.compatibleTools(
      CONTEXT,
      [
        tool("builtin.text", { accepts: ["text"] }),
        tool("builtin.json", { accepts: ["json"] }),
        tool("builtin.markdown", { accepts: ["markdown"] }),
      ],
      new Set(),
    );

    expect(candidates).toEqual([
      {
        toolId: "builtin.json",
        toolVersion: "1.0.0",
        acceptedType: "json",
      },
    ]);
  });

  it("returns one candidate for a tool accepting multiple types", () => {
    const candidates = bus.compatibleTools(
      CONTEXT,
      [tool("builtin.multi", { accepts: ["text", "json", "markdown", "json"] })],
      new Set(),
    );

    expect(candidates).toEqual([
      {
        toolId: "builtin.multi",
        toolVersion: "1.0.0",
        acceptedType: "json",
      },
    ]);
  });

  it("requires every declared permission, not just one", () => {
    const tools = [
      tool("builtin.local"),
      tool("builtin.network", { permissions: ["network"] }),
      tool("builtin.private", { permissions: ["network", "read:private"] }),
    ];

    expect(
      bus.compatibleTools(CONTEXT, tools, new Set(["network"])).map(
        (candidate) => candidate.toolId,
      ),
    ).toEqual(["builtin.local", "builtin.network"]);

    expect(
      bus.compatibleTools(
        CONTEXT,
        tools,
        new Set(["network", "read:private"]),
      ).map((candidate) => candidate.toolId),
    ).toEqual(["builtin.local", "builtin.network", "builtin.private"]);
  });

  it("sorts by tool ID and version without mutating its input", () => {
    const tools = Object.freeze([
      tool("builtin.zeta", { version: "2.0.0" }),
      tool("builtin.alpha", { version: "2.0.0" }),
      tool("builtin.alpha", { version: "1.0.0" }),
    ]);

    expect(
      bus.compatibleTools(CONTEXT, tools, new Set()).map(
        (candidate) => `${candidate.toolId}@${candidate.toolVersion}`,
      ),
    ).toEqual([
      "builtin.alpha@1.0.0",
      "builtin.alpha@2.0.0",
      "builtin.zeta@2.0.0",
    ]);
    expect(tools[0]?.id).toBe("builtin.zeta");
  });

  it("returns no candidates for incompatible or unknown context types", () => {
    expect(
      bus.compatibleTools(
        CONTEXT,
        [tool("builtin.text", { accepts: ["text"] })],
        new Set(),
      ),
    ).toEqual([]);
    expect(bus.compatibleTools(CONTEXT, [], new Set())).toEqual([]);

    const unknown = {
      ...CONTEXT,
      type: "unknown_context",
    } as unknown as ContextEnvelope;
    expect(
      bus.compatibleTools(unknown, [tool("builtin.json")], new Set()),
    ).toEqual([]);
  });

  it("never treats data capabilities as granted permissions", () => {
    const context: ContextEnvelope = {
      ...CONTEXT,
      capabilities: ["network"],
    };

    expect(
      bus.compatibleTools(
        context,
        [tool("builtin.fetch", { permissions: ["network"] })],
        new Set(),
      ),
    ).toEqual([]);
  });
});

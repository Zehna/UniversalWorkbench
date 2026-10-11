import { describe, expect, it } from "vitest";
import {
  AiAgentConfigSchema,
  AiSubAgentSpecSchema,
  AgentDelegationInputSchema,
  AgentNestedTraceItemSchema,
  AgentTraceItemSchema,
} from "../src/index.js";

describe("phase 9 multi-agent contracts", () => {
  describe("AiSubAgentSpecSchema", () => {
    it("parses valid spec and applies defaults", () => {
      const parsed = AiSubAgentSpecSchema.parse({
        id: "researcher",
        role: "researcher",
        instructions: "Search and summarize",
      });
      expect(parsed.id).toBe("researcher");
      expect(parsed.role).toBe("researcher");
      expect(parsed.allowedTools).toEqual([]);
      expect(parsed.maxIterations).toBe(5);
      expect(parsed.maxOutputTokens).toBeUndefined();
    });

    it("parses full spec with explicit tools and limits", () => {
      const parsed = AiSubAgentSpecSchema.parse({
        id: "coder",
        role: "coder",
        instructions: "Write code",
        allowedTools: ["builtin.http.request@1.0.0"],
        maxIterations: 10,
        maxOutputTokens: 4096,
      });
      expect(parsed.allowedTools).toEqual(["builtin.http.request@1.0.0"]);
      expect(parsed.maxIterations).toBe(10);
      expect(parsed.maxOutputTokens).toBe(4096);
    });

    it("rejects missing required fields", () => {
      expect(
        AiSubAgentSpecSchema.safeParse({
          id: "x",
          role: "r",
        }).success,
      ).toBe(false);
      expect(
        AiSubAgentSpecSchema.safeParse({
          id: "",
          role: "r",
          instructions: "do",
        }).success,
      ).toBe(false);
    });

    it("rejects maxIterations out of range", () => {
      expect(
        AiSubAgentSpecSchema.safeParse({
          id: "a",
          role: "r",
          instructions: "do",
          maxIterations: 0,
        }).success,
      ).toBe(false);
      expect(
        AiSubAgentSpecSchema.safeParse({
          id: "a",
          role: "r",
          instructions: "do",
          maxIterations: 16,
        }).success,
      ).toBe(false);
    });
  });

  describe("AgentDelegationInputSchema", () => {
    it("parses valid delegation input", () => {
      const parsed = AgentDelegationInputSchema.parse({
        subAgentId: "researcher",
        task: "Summarize the report",
      });
      expect(parsed.subAgentId).toBe("researcher");
      expect(parsed.task).toBe("Summarize the report");
      expect(parsed.context).toBeUndefined();
    });

    it("parses delegation input with context", () => {
      const parsed = AgentDelegationInputSchema.parse({
        subAgentId: "researcher",
        task: "Summarize",
        context: { docId: "123" },
      });
      expect(parsed.context).toEqual({ docId: "123" });
    });

    it("rejects missing subAgentId or task", () => {
      expect(AgentDelegationInputSchema.safeParse({ task: "hi" }).success).toBe(
        false,
      );
      expect(
        AgentDelegationInputSchema.safeParse({ subAgentId: "x" }).success,
      ).toBe(false);
      expect(
        AgentDelegationInputSchema.safeParse({
          subAgentId: "",
          task: "hi",
        }).success,
      ).toBe(false);
    });
  });

  describe("AgentNestedTraceItemSchema", () => {
    it("parses valid nested trace", () => {
      const parsed = AgentNestedTraceItemSchema.parse({
        subAgentId: "researcher",
        role: "researcher",
        trace: [{ iteration: 1, thought: "searching" }],
        status: "completed",
        usage: {
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
        },
      });
      expect(parsed.subAgentId).toBe("researcher");
      expect(parsed.trace).toHaveLength(1);
      expect(parsed.status).toBe("completed");
      expect(parsed.usage.totalTokens).toBe(15);
    });

    it("rejects invalid status or usage", () => {
      expect(
        AgentNestedTraceItemSchema.safeParse({
          subAgentId: "a",
          role: "r",
          trace: [],
          status: "unknown_status",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        }).success,
      ).toBe(false);
      expect(
        AgentNestedTraceItemSchema.safeParse({
          subAgentId: "a",
          role: "r",
          trace: [],
          status: "completed",
          usage: { promptTokens: -1, completionTokens: 0, totalTokens: 0 },
        }).success,
      ).toBe(false);
    });
  });

  describe("AiAgentConfigSchema with subAgents", () => {
    it("defaults subAgents to empty array", () => {
      const parsed = AiAgentConfigSchema.parse({
        providerId: "openai",
        model: "gpt-4o",
        prompt: "Coordinate",
        secretRef: "secret://vault/openai-key",
      });
      expect(parsed.subAgents).toEqual([]);
    });

    it("parses config with subAgents", () => {
      const parsed = AiAgentConfigSchema.parse({
        providerId: "openai",
        model: "gpt-4o",
        prompt: "Coordinate",
        secretRef: "secret://vault/openai-key",
        subAgents: [
          {
            id: "researcher",
            role: "researcher",
            instructions: "Search",
          },
        ],
      });
      expect(parsed.subAgents).toHaveLength(1);
      expect(parsed.subAgents?.[0]?.id).toBe("researcher");
      expect(parsed.subAgents?.[0]?.maxIterations).toBe(5);
    });
  });

  describe("nested trace serialization", () => {
    it("parses trace items with nested sub-agent traces", () => {
      const item = AgentTraceItemSchema.parse({
        iteration: 1,
        thought: "Delegating to researcher",
        nestedTrace: {
          subAgentId: "researcher",
          role: "researcher",
          trace: [{ iteration: 1, thought: "inner thought" }],
          status: "completed",
          usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
        },
      });
      expect(item.nestedTrace?.subAgentId).toBe("researcher");
      expect(item.nestedTrace?.trace).toHaveLength(1);
      expect(JSON.parse(JSON.stringify(item)).nestedTrace.status).toBe(
        "completed",
      );
    });

    it("parses trace items without nestedTrace", () => {
      const item = AgentTraceItemSchema.parse({
        iteration: 2,
        thought: "plain step",
      });
      expect(item.nestedTrace).toBeUndefined();
    });
  });
});

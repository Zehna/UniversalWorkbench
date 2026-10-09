import { describe, expect, it } from "vitest";
import {
  AiAgentConfigSchema,
  AgentTraceItemSchema,
  AgentStatusSchema,
  AgentResponsePayloadSchema,
  AgentResponseEnvelopeSchema,
  ContextEnvelopeSchema,
  ContextTypeSchema,
} from "../src/index.js";

describe("agent contracts and schemas", () => {
  describe("AiAgentConfigSchema", () => {
    it("parses valid config and applies defaults", () => {
      const config = {
        providerId: "openai",
        model: "gpt-4o",
        prompt: "Summarize the report",
        secretRef: "secret://vault/openai-key",
      };
      const parsed = AiAgentConfigSchema.parse(config);
      expect(parsed.maxIterations).toBe(5);
      expect(parsed.allowedTools).toEqual([]);
      expect(parsed.providerId).toBe("openai");
      expect(parsed.model).toBe("gpt-4o");
    });

    it("accepts valid custom iterations and allowedTools", () => {
      const config = {
        providerId: "openai",
        model: "gpt-4o",
        prompt: "Search and summarize",
        systemPrompt: "You are a helpful researcher",
        secretRef: "secret://vault/openai-key",
        allowedTools: ["builtin.http.request@1.0.0", "builtin.json.transform@1.0.0"],
        maxIterations: 10,
        maxOutputTokens: 4096,
      };
      const parsed = AiAgentConfigSchema.parse(config);
      expect(parsed.maxIterations).toBe(10);
      expect(parsed.allowedTools).toHaveLength(2);
      expect(parsed.systemPrompt).toBe("You are a helpful researcher");
      expect(parsed.maxOutputTokens).toBe(4096);
    });

    it("rejects maxIterations greater than 15 (cap guardrail)", () => {
      const config = {
        providerId: "openai",
        model: "gpt-4o",
        prompt: "Run forever",
        secretRef: "secret://vault/openai-key",
        maxIterations: 16,
      };
      expect(() => AiAgentConfigSchema.parse(config)).toThrow();
    });

    it("rejects maxIterations less than 1", () => {
      const config = {
        providerId: "openai",
        model: "gpt-4o",
        prompt: "Zero iterations",
        secretRef: "secret://vault/openai-key",
        maxIterations: 0,
      };
      expect(() => AiAgentConfigSchema.parse(config)).toThrow();
    });

    it("rejects invalid secretRef", () => {
      const config = {
        providerId: "openai",
        model: "gpt-4o",
        prompt: "Invalid secret",
        secretRef: "plain-api-key-12345",
      };
      expect(() => AiAgentConfigSchema.parse(config)).toThrow();
    });
  });

  describe("AgentTraceItemSchema", () => {
    it("parses full step trace item", () => {
      const item = {
        iteration: 1,
        thought: "I should fetch the data",
        toolCall: {
          id: "call_123",
          name: "builtin.http.request@1.0.0",
          arguments: { url: "https://api.example.com/data" },
        },
        observation: {
          toolCallId: "call_123",
          output: { status: 200, data: "ok" },
          durationMs: 150,
          isError: false,
        },
        durationMs: 250,
      };
      const parsed = AgentTraceItemSchema.parse(item);
      expect(parsed.iteration).toBe(1);
      expect(parsed.thought).toBe("I should fetch the data");
      expect(parsed.toolCall?.name).toBe("builtin.http.request@1.0.0");
      expect(parsed.observation?.durationMs).toBe(150);
    });

    it("parses final step trace item with thought only", () => {
      const item = {
        iteration: 2,
        thought: "I now have all information needed to answer.",
      };
      const parsed = AgentTraceItemSchema.parse(item);
      expect(parsed.iteration).toBe(2);
      expect(parsed.toolCall).toBeUndefined();
      expect(parsed.observation).toBeUndefined();
    });

    it("rejects non-positive iteration number", () => {
      const item = {
        iteration: 0,
        thought: "Invalid step",
      };
      expect(() => AgentTraceItemSchema.parse(item)).toThrow();
    });
  });

  describe("AgentResponsePayloadSchema and AgentResponseEnvelopeSchema", () => {
    it("verifies ContextTypeSchema contains agent_response", () => {
      expect(ContextTypeSchema.options).toContain("agent_response");
    });

    it("parses valid agent_response payload with defaults", () => {
      const payload = {
        text: "The final answer is 42.",
        model: "gpt-4o-mini",
        iterations: 2,
        usage: {
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
        },
        usageSource: "provider",
      };
      const parsed = AgentResponsePayloadSchema.parse(payload);
      expect(parsed.status).toBe("completed");
      expect(parsed.trace).toEqual([]);
      expect(parsed.iterations).toBe(2);
    });

    it("parses agent_response envelope through ContextEnvelopeSchema and AgentResponseEnvelopeSchema", () => {
      const payload = {
        text: "Goal reached successfully.",
        model: "gpt-4o",
        status: "completed" as const,
        iterations: 1,
        trace: [
          {
            iteration: 1,
            thought: "Direct answer without tools.",
          },
        ],
        usage: {
          promptTokens: 50,
          completionTokens: 25,
          totalTokens: 75,
        },
        usageSource: "provider" as const,
      };

      const envelope = {
        id: "11111111-1111-4111-8111-111111111111",
        type: "agent_response" as const,
        schemaVersion: 1 as const,
        mimeType: "application/json",
        metadata: {},
        payload,
        provenance: {
          sourceContextIds: [],
        },
        capabilities: ["text"],
      };

      const parsedContext = ContextEnvelopeSchema.parse(envelope);
      expect(parsedContext.type).toBe("agent_response");

      const parsedAgent = AgentResponseEnvelopeSchema.parse(envelope);
      expect(parsedAgent.payload.status).toBe("completed");
      expect(parsedAgent.payload.trace).toHaveLength(1);
    });

    it("accepts iteration_limit_reached status", () => {
      expect(AgentStatusSchema.parse("iteration_limit_reached")).toBe("iteration_limit_reached");
    });

    it("rejects invalid status", () => {
      expect(() => AgentStatusSchema.parse("unknown_status")).toThrow();
    });
  });
});

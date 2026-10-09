import { describe, expect, it, vi } from "vitest";
import { createEgressPolicy } from "@uw/egress";
import {
  createHttpProvider,
  createMockProvider,
  type ProviderRequest,
} from "../src/index.js";

const SECRET = "sk-test-supersecret-abc123-VALUE";

function baseRequest(
  overrides: Partial<ProviderRequest> = {},
): ProviderRequest {
  return {
    model: "test-model",
    prompt: "what is the weather?",
    responseFormat: { kind: "text" },
    maxOutputTokens: 128,
    timeoutMs: 1000,
    secretValue: SECRET,
    signal: new AbortController().signal,
    ...overrides,
  };
}

const weatherTool = {
  name: "get_weather",
  description: "Get the weather for a city",
  parameters: {
    type: "object",
    properties: {
      city: { type: "string" },
    },
    required: ["city"],
  },
};

describe("provider tool-calling abstraction", () => {
  it("mock returns configured toolCalls when tools are requested", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("WORKBENCH_AI_MOCK", "1");
    const provider = createMockProvider({
      toolCalls: [{ id: "call_1", name: "get_weather", arguments: { city: "Paris" } }],
    });
    const result = await provider.complete(
      baseRequest({ tools: [weatherTool] }),
    );
    expect(result.toolCalls).toEqual([
      { id: "call_1", name: "get_weather", arguments: { city: "Paris" } },
    ]);
    expect(result.model).toBe("test-model");
  });

  it("mock returns no toolCalls when none are configured", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("WORKBENCH_AI_MOCK", "1");
    const provider = createMockProvider();
    const result = await provider.complete(baseRequest());
    expect(result.toolCalls).toBeUndefined();
    expect(typeof result.text).toBe("string");
  });

  it("http provider maps tools to OpenAI payload and parses tool_calls", async () => {
    let seenBody: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          id: "chatcmpl-tools-1",
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  {
                    id: "call_abc",
                    type: "function",
                    function: {
                      name: "get_weather",
                      arguments: JSON.stringify({ city: "Paris" }),
                    },
                  },
                ],
              },
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const provider = createHttpProvider({
      baseUrl: "https://public.example.net/v1",
      policy: createEgressPolicy({ resolver: async () => ["93.184.216.34"] }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await provider.complete(
      baseRequest({ tools: [weatherTool] }),
    );
    const firstCall = fetchImpl.mock.calls[0] as unknown[] | undefined;
    const init = firstCall?.[1] as unknown as { body?: string } | undefined;
    seenBody = JSON.parse(
      String(init?.body ?? "{}"),
    ) as Record<string, unknown>;
    expect(seenBody["tools"]).toEqual([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get the weather for a city",
          parameters: weatherTool.parameters,
        },
      },
    ]);
    expect(result.toolCalls).toEqual([
      { id: "call_abc", name: "get_weather", arguments: { city: "Paris" } },
    ]);
    expect(result.providerRequestId).toBe("chatcmpl-tools-1");
  });

  it("http provider omits tools field when no tools are requested", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "hi" } }],
        }),
        { status: 200 },
      );
    });
    const provider = createHttpProvider({
      baseUrl: "https://public.example.net/v1",
      policy: createEgressPolicy({ resolver: async () => ["93.184.216.34"] }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await provider.complete(baseRequest());
    const firstCall = fetchImpl.mock.calls[0] as unknown[] | undefined;
    const init = firstCall?.[1] as unknown as { body?: string } | undefined;
    const seenBody = JSON.parse(
      String(init?.body ?? "{}"),
    ) as Record<string, unknown>;
    expect("tools" in seenBody).toBe(false);
  });
});

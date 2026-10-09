import {
  estimateTokensForText,
  ProviderError,
  type AiProvider,
  type ProviderRequest,
  type ProviderResult,
  type ProviderToolCall,
} from "./types.js";

export interface MockProviderOptions {
  toolCalls?: ProviderToolCall[];
}

export function isMockAllowed(): boolean {
  // Docker smoke runs the production image; the smoke-scoped flag alone
  // opens the mock there (mirrors dockerSmokeFixtureEnabled for the fixture
  // HTTP tool). Operators never set this flag outside smoke runs.
  if (process.env.WORKBENCH_DOCKER_SMOKE_FIXTURE === "1") return true;
  if (process.env.NODE_ENV !== "test") return false;
  return (
    process.env.WORKBENCH_AI_MOCK === "1" ||
    process.env.WORKBENCH_E2E_FIXTURE === "1"
  );
}

/**
 * The mock provider when the flag matrix allows it, otherwise null. Server
 * composition uses this so the mock constructor is referenced only behind
 * the gate.
 */
export function mockProviderIfAllowed(): AiProvider | null {
  if (!isMockAllowed()) return null;
  return createMockProvider();
}

export function createMockProvider(options?: MockProviderOptions): AiProvider {
  if (!isMockAllowed()) {
    throw new ProviderError(
      "MOCK_NOT_ALLOWED",
      "Mock AI provider is not allowed in this environment",
    );
  }
  const configuredToolCalls = options?.toolCalls?.map((call) => ({
    ...call,
    arguments: { ...call.arguments },
  }));
  return {
    id: "mock",
    async complete(req: ProviderRequest): Promise<ProviderResult> {
      const text = `mock:${req.model}:${req.prompt.slice(0, 32)}`;
      const promptTokens = estimateTokensForText(req.prompt);
      const completionTokens = estimateTokensForText(text);
      const structured =
        req.responseFormat?.kind === "json" ? { echo: req.prompt } : undefined;
      const result: ProviderResult = {
        text,
        model: req.model,
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
        },
        usageSource: "estimated",
      };
      if (structured !== undefined) result.structured = structured;
      if (configuredToolCalls !== undefined) {
        result.toolCalls = configuredToolCalls.map((call) => ({
          ...call,
          arguments: { ...call.arguments },
        }));
      } else if (req.tools !== undefined && req.tools.length > 0) {
        const first = req.tools[0];
        if (first !== undefined) {
          result.toolCalls = [
            {
              id: "mock-call-1",
              name: first.name,
              arguments: {},
            },
          ];
        }
      }
      return result;
    },
  };
}

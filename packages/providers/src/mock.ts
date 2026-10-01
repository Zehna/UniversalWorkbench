import {
  estimateTokensForText,
  ProviderError,
  type AiProvider,
  type ProviderRequest,
  type ProviderResult,
} from "./types.js";

export function isMockAllowed(): boolean {
  if (process.env.NODE_ENV !== "test") return false;
  return (
    process.env.WORKBENCH_AI_MOCK === "1" ||
    process.env.WORKBENCH_E2E_FIXTURE === "1" ||
    process.env.WORKBENCH_DOCKER_SMOKE_FIXTURE === "1"
  );
}

export function createMockProvider(): AiProvider {
  if (!isMockAllowed()) {
    throw new ProviderError(
      "MOCK_NOT_ALLOWED",
      "Mock AI provider is not allowed in this environment",
    );
  }
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
      return result;
    },
  };
}

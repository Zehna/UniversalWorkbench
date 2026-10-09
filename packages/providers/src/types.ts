export type ProviderResponseFormat =
  { kind: "text" } | { kind: "json"; jsonSchema: Record<string, unknown> };

export interface ProviderToolDefinition {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

export interface ProviderToolCall {
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ProviderRequest {
  model: string;
  prompt: string;
  systemPrompt?: string;
  responseFormat: ProviderResponseFormat;
  maxOutputTokens: number;
  timeoutMs: number;
  secretValue: string;
  signal: AbortSignal;
  idempotencyKey?: string;
  tools?: ProviderToolDefinition[];
}

export interface ProviderResult {
  text: string;
  model: string;
  structured?: unknown;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  usageSource: "provider" | "estimated";
  providerRequestId?: string;
  toolCalls?: ProviderToolCall[];
}

export interface AiProvider {
  readonly id: string;
  complete(req: ProviderRequest): Promise<ProviderResult>;
}

export type ProviderErrorCode =
  | "EGRESS_BLOCKED"
  | "DNS_FAILURE"
  | "TIMEOUT"
  | "ABORTED"
  | "NETWORK_FAILURE"
  | "RESPONSE_TOO_LARGE"
  | "PROVIDER_ERROR"
  | "MOCK_NOT_ALLOWED"
  | "INVALID_CONFIG";

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;

  constructor(code: ProviderErrorCode, message: string) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
  }
}

export function estimateTokensForText(text: string): number {
  const bytes = new TextEncoder().encode(text).byteLength;
  return Math.max(1, Math.ceil(bytes / 4));
}
